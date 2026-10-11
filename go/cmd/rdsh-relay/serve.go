package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
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
	srv.relay = relay.New(registry, srv.authorize, nil)

	// Protocol B background loops (N2 heartbeat + N5 sync).
	acc := newAccount(cfg.AccountURL, cfg.NodeToken)
	srv.assignVerify = acc.AssignVerify
	go heartbeatLoop(acc, cfg.NodeID, registry)
	go syncLoop(acc, cfg.NodeID, cookie, cache, registry)

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

// heartbeatLoop reports N2 load every 30s.
func heartbeatLoop(acc *account, nodeID string, registry *tunnel.Registry) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		load := Load{
			Connections: int64(len(registry.List())),
			Capacity:    0, // TODO: from config
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
		// Draining (R38) → stop taking new hosts; the account service already
		// excludes draining nodes from assignment. Full migration is P1.5.
		_ = data.Draining
	}
}
