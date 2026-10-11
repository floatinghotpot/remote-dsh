package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/floatinghotpot/remote-dsh/go/internal/relay"
	"github.com/floatinghotpot/remote-dsh/go/internal/tunnel"
	"github.com/gorilla/websocket"
)

// hostCache is the N5-synced local host authorization data (R3: no account
// round-trip). hostID → HostEntry, with a pubkey that can be hot-swapped.
type hostCache struct {
	mu    sync.RWMutex
	hosts map[string]HostEntry
}

func newHostCache() *hostCache {
	return &hostCache{hosts: make(map[string]HostEntry)}
}

func (c *hostCache) setHosts(hosts []HostEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	m := make(map[string]HostEntry, len(hosts))
	for _, h := range hosts {
		m[h.HostID] = h
	}
	c.hosts = m
}

// authorize checks the host is known locally + the entering user's ver matches
// (owner or shared member, via the N5 userVers map).
func (c *hostCache) authorize(hostID string, userID, ver int64) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	h, ok := c.hosts[hostID]
	if !ok {
		return false
	}
	v, ok := h.UserVers[strconv.FormatInt(userID, 10)]
	if !ok {
		return false
	}
	return v == ver
}

// defaultDataDir returns the state directory (~/.rdsh/relay, or $RDSH_DATA_DIR).
func defaultDataDir() string {
	if d := os.Getenv("RDSH_DATA_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".rdsh", "relay")
}

func serve(dataDir string) error {
	cfg, err := loadConfig(dataDir)
	if err != nil {
		return err
	}
	pub, err := cfg.hostCookiePublicKey()
	if err != nil {
		return err
	}

	registry := tunnel.NewRegistry()
	cookie := &hostCookie{pub: pub}
	cache := newHostCache()

	srv := newServer(registry, nil, cookie, cache, cfg.AccountURL)
	meter := newNodeMeter()
	srv.relay = relay.New(registry, srv.authorize, meter.add)

	// Protocol B background loops (N2 heartbeat + N5 sync).
	acc := newAccount(cfg.AccountURL, cfg.NodeToken)
	srv.assignVerify = acc.AssignVerify
	go heartbeatLoop(acc, cfg.NodeID, registry, meter)
	go syncLoop(acc, cfg.NodeID, cookie, cache, registry)
	go reportUsageLoop(acc, cfg, meter)

	handler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if websocket.IsWebSocketUpgrade(req) {
			srv.handleUpgrade(w, req)
			return
		}
		srv.handler().ServeHTTP(w, req)
	})

	fmt.Printf("rdsh-relay: node %s serving %s (account %s)\n", cfg.NodeID, cfg.AdvertiseURL, cfg.AccountURL)
	return startHTTPServer(cfg, handler)
}

// nodeMeter accumulates relayed bytes: aggregate (for N2 load, R32) + per
// user×host (for R8 usage reporting). Mirrors hub/src/relay-usage.ts: cumulative
// values, NOT cleared on flush; instanceId is per-process (F1).
type usageKey struct {
	hostID string
	userID int64
}

type usageEntry struct {
	bytesUp   int64
	bytesDown int64
	sessions  int64 // 1 per user×host (relay side does not count distinct sessions)
}

type nodeMeter struct {
	instanceID string
	day        string

	bytesIn  atomic.Int64
	bytesOut atomic.Int64

	mu    sync.Mutex
	usage map[usageKey]*usageEntry
	dirty map[usageKey]bool
}

func newNodeMeter() *nodeMeter {
	return &nodeMeter{
		instanceID: randomInstanceID(),
		day:        time.Now().Format("2006-01-02"),
		usage:      make(map[usageKey]*usageEntry),
		dirty:      make(map[usageKey]bool),
	}
}

func (m *nodeMeter) add(hostID string, userID int64, up, down int64) {
	m.bytesIn.Add(up)
	m.bytesOut.Add(down)
	if userID <= 0 || hostID == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	k := usageKey{hostID, userID}
	e := m.usage[k]
	if e == nil {
		e = &usageEntry{sessions: 1}
		m.usage[k] = e
	}
	e.bytesUp += up
	e.bytesDown += down
	m.dirty[k] = true
}

func (m *nodeMeter) row(date string, k usageKey, e *usageEntry) UsageRow {
	return UsageRow{
		Date:           date,
		UserID:         k.userID,
		HostID:         k.hostID,
		RelayBytesUp:   e.bytesUp,
		RelayBytesDown: e.bytesDown,
		RelaySeconds:   0, // relay side does not measure session duration (F2)
		Sessions:       e.sessions,
	}
}

// report returns the rows to send. Same day: only dirty rows (cumulative, NOT
// cleared). Day rollover: the old day's full final cumulative, then reset.
func (m *nodeMeter) report(date string) []UsageRow {
	m.mu.Lock()
	defer m.mu.Unlock()
	if date != m.day {
		var rows []UsageRow
		for k, e := range m.usage {
			rows = append(rows, m.row(m.day, k, e))
		}
		m.usage = make(map[usageKey]*usageEntry)
		m.dirty = make(map[usageKey]bool)
		m.day = date
		return rows
	}
	var rows []UsageRow
	for k := range m.dirty {
		if e := m.usage[k]; e != nil {
			rows = append(rows, m.row(date, k, e))
		}
	}
	m.dirty = make(map[usageKey]bool)
	return rows
}

// reportUsageLoop flushes per-user×host usage to the account service (R8).
func reportUsageLoop(acc *account, cfg *Config, m *nodeMeter) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		if cfg.RelayNodeToken == "" {
			continue
		}
		rows := m.report(time.Now().Format("2006-01-02"))
		if len(rows) == 0 {
			continue
		}
		_ = acc.ReportUsage(cfg.RelayNodeToken, m.instanceID, rows)
	}
}

// heartbeatLoop reports N2 load every 30s.
func heartbeatLoop(acc *account, nodeID string, registry *tunnel.Registry, m *nodeMeter) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		load := Load{
			Connections: int64(len(registry.List())),
			BytesIn:     m.bytesIn.Load(),
			BytesOut:    m.bytesOut.Load(),
			Capacity:    0,
		}
		_ = acc.Heartbeat(nodeID, load)
	}
}

// syncLoop pulls N5 host data + pubkey + draining every 30s.
func syncLoop(acc *account, nodeID string, cookie *hostCookie, cache *hostCache, registry *tunnel.Registry) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		data, err := acc.Sync(nodeID)
		if err != nil {
			continue
		}
		cache.setHosts(data.Hosts)
		if data.HostCookiePubKey != "" {
			if pk, err := decodeHexKey(data.HostCookiePubKey); err == nil {
				cookie.pub = pk
			}
		}
		// P1.5 迁移（R39）：draining 时向每个有迁移票据的主机发 REDIRECT（等活跃流归零）。
		for _, h := range data.Hosts {
			if h.MigrateTo == nil {
				continue
			}
			conn := registry.Get(h.HostID)
			if conn != nil && conn.ActiveStreams() == 0 {
				conn.SendRedirect(h.MigrateTo.NodeURL, h.MigrateTo.ExpiresAt, h.MigrateTo.Sig)
			}
		}
	}
}

// randomInstanceID returns a random 32-hex-char id (per-process, mirrors hub randomUUID).
func randomInstanceID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
