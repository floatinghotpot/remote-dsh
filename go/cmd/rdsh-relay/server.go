package main

import (
	"net/http"
	"net/url"
	"regexp"

	"github.com/floatinghotpot/remote-dsh/go/internal/relay"
	"github.com/floatinghotpot/remote-dsh/go/internal/tunnel"
	"github.com/gorilla/websocket"
)

var hostPathRe = regexp.MustCompile(`^/h/([^/]+)(/.*)?$`)

// server wires the tunnel registry + relay data plane + host-cookie verifier
// into an HTTP handler. Mirrors packages/hub/src/server.ts relay-related routing.
type server struct {
	tunnels *tunnel.Registry
	relay   *relay.Node
	cookie  *hostCookie
	cache   *hostCache
	account string // account-service base URL (for login redirects)
	// assignVerify validates a gateway's one-time assign token and returns its
	// hostId (wired to protocol-B in T1.7). nil accepts any token (dev).
	assignVerify func(token string) (hostID string, ok bool)

	upgrader    *websocket.Upgrader
	rawUpgrader *websocket.Upgrader
}

func newServer(tunnels *tunnel.Registry, rn *relay.Node, cookie *hostCookie, cache *hostCache, account string) *server {
	return &server{
		tunnels:     tunnels,
		relay:       rn,
		cookie:      cookie,
		cache:       cache,
		account:     account,
		upgrader:    &websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
		rawUpgrader: &websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
	}
}

// authorize resolves (hostID, userID, ok): signed host cookie + local host
// cache (ownership + ver). No account-service round-trip (R3).
func (s *server) authorize(req *http.Request) (string, int64, bool) {
	c, err := req.Cookie(relay.HostCookieName)
	if err != nil {
		return "", 0, false
	}
	hostID, userID, ver, ok := s.cookie.verify(c.Value)
	if !ok {
		return "", 0, false
	}
	if s.cache != nil && !s.cache.authorize(hostID, userID, ver) {
		return "", 0, false
	}
	return hostID, userID, true
}

func (s *server) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		path := req.URL.Path
		if h := hostPathRe.FindStringSubmatch(path); h != nil {
			s.handleEnterHost(w, req, h[1], h[2])
			return
		}
		if _, _, ok := s.authorize(req); ok {
			s.relay.HandleHTTP(w, req)
			return
		}
		http.Redirect(w, req, s.account+"/portal", http.StatusFound)
	})
}

// handleEnterHost re-validates the cookie for re-entry and 302s to the root.
// The account service owns the initial enter (session + ownership + Set-Cookie
// with Domain=<region root>) and 302s the client here.
func (s *server) handleEnterHost(w http.ResponseWriter, req *http.Request, hostID, rest string) {
	c, err := req.Cookie(relay.HostCookieName)
	if err != nil {
		next := url.QueryEscape("/h/" + hostID + rest)
		http.Redirect(w, req, s.account+"/portal/login?next="+next, http.StatusFound)
		return
	}
	gotHost, _, _, ok := s.cookie.verify(c.Value)
	if !ok || gotHost != hostID {
		next := url.QueryEscape("/h/" + hostID + rest)
		http.Redirect(w, req, s.account+"/portal/login?next="+next, http.StatusFound)
		return
	}
	if rest == "" {
		rest = "/"
	}
	http.Redirect(w, req, rest, http.StatusFound)
}

// handleUpgrade routes WebSocket upgrades: /tunnel (gateway), /e2e (raw), and
// root-with-cookie (DSH events.mux / events.host).
func (s *server) handleUpgrade(w http.ResponseWriter, req *http.Request) {
	path := req.URL.Path
	if path == "/tunnel" {
		s.handleTunnelUpgrade(w, req)
		return
	}
	if path == "/e2e" {
		if _, _, ok := s.authorize(req); ok {
			s.relay.HandleRawUpgrade(w, req)
			return
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if _, _, ok := s.authorize(req); ok {
		s.relay.HandleWSUpgrade(w, req, path)
		return
	}
	http.Error(w, "not found", http.StatusNotFound)
}

// handleTunnelUpgrade accepts a host gateway's tunnel. The gateway arrives here
// after the account service 307-redirected it (dynamic assignment, R35) with a
// one-time assign token; the node verifies that token and extracts the hostId.
func (s *server) handleTunnelUpgrade(w http.ResponseWriter, req *http.Request) {
	assign := req.URL.Query().Get("assign")
	hostID := assign
	if s.assignVerify != nil {
		var ok bool
		hostID, ok = s.assignVerify(assign)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}
	ws, err := s.upgrader.Upgrade(w, req, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(tunnel.MaxPayloadLength)
	var conn *tunnel.Conn
	conn = tunnel.NewConn(ws, hostID, func(hostID string) {
		s.tunnels.Unregister(hostID, conn)
	}, tunnel.Timings{})
	s.tunnels.Register(conn)
}
