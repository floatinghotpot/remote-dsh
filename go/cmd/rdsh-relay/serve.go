package main

import (
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
// user×host (for R8 usage reporting).
type usageKey struct {
	hostID string
	userID int64
}

type usageEntry struct {
	bytesUp   int64
	bytesDown int64
	startedAt int64 // first-byte ms
}

type nodeMeter struct {
	bytesIn  atomic.Int64
	bytesOut atomic.Int64

	mu    sync.Mutex
	usage map[usageKey]*usageEntry
}

func newNodeMeter() *nodeMeter {
	return &nodeMeter{usage: make(map[usageKey]*usageEntry)}
}

func (m *nodeMeter) add(hostID string, userID int64, up, down int64) {
	m.bytesIn.Add(up)
	m.bytesOut.Add(down)
	if userID <= 0 || hostID == "" {
		return
	}
	now := time.Now().UnixMilli()
	m.mu.Lock()
	defer m.mu.Unlock()
	k := usageKey{hostID, userID}
	e := m.usage[k]
	if e == nil {
		e = &usageEntry{startedAt: now}
		m.usage[k] = e
	}
	e.bytesUp += up
	e.bytesDown += down
}

// snapshot returns the accumulated usage rows and resets the per-user×host map.
func (m *nodeMeter) snapshot(date string) []UsageRow {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now().UnixMilli()
	var rows []UsageRow
	for k, e := range m.usage {
		if e.bytesUp == 0 && e.bytesDown == 0 {
			continue
		}
		seconds := (now - e.startedAt) / 1000
		if seconds < 0 {
			seconds = 0
		}
		rows = append(rows, UsageRow{
			Date:           date,
			UserID:         k.userID,
			HostID:         k.hostID,
			RelayBytesUp:   e.bytesUp,
			RelayBytesDown: e.bytesDown,
			RelaySeconds:   seconds,
			Sessions:       1,
		})
	}
	m.usage = make(map[usageKey]*usageEntry)
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
		rows := m.snapshot(time.Now().Format("2006-01-02"))
		if len(rows) == 0 {
			continue
		}
		_ = acc.ReportUsage(cfg.RelayNodeToken, cfg.InstanceID, rows)
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
