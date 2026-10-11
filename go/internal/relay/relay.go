// Package relay is the data plane: forward client HTTP/SSE/WebSocket/E2EE
// traffic over a host's tunnel to its gateway. Mirrors packages/hub/src/relay.ts
// (pure pass-through — no business-message parsing, only authorize + route).
//
// P1 simplification vs the hub: no HTML injection (the E2EE shim + back-bar are
// account-service/portal concerns and are deferred; see plan.md).
package relay

import (
	"net/http"
	"strings"

	"github.com/floatinghotpot/remote-dsh/go/internal/tunnel"
	"github.com/gorilla/websocket"
)

// Authorizer resolves a request to (hostID, userID, ok) from the signed host
// cookie + local host cache. The node wires this to its Ed25519 verifier.
type Authorizer func(req *http.Request) (hostID string, userID int64, ok bool)

// Meter records relayed bytes per user×host (R8; wired to protocol-B usage
// reporting by the node). May be nil to disable.
type Meter func(hostID string, userID int64, up, down int64)

// Node is the relay data plane.
type Node struct {
	Tunnels     *tunnel.Registry
	Authorize   Authorizer
	Meter       Meter
	MaxPayload  int64
	Upgrader    *websocket.Upgrader
	RawUpgrader *websocket.Upgrader
}

// New returns a relay Node with default upgrade settings.
func New(tunnels *tunnel.Registry, authorize Authorizer, meter Meter) *Node {
	up := &websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	raw := &websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	return &Node{
		Tunnels:     tunnels,
		Authorize:   authorize,
		Meter:       meter,
		MaxPayload:  tunnel.MaxPayloadLength,
		Upgrader:    up,
		RawUpgrader: raw,
	}
}

// writeError writes a JSON error body.
func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(tunnel.MustJSON(map[string]any{"error": map[string]any{"code": code, "message": message}}))
}

// HostCookieName is the signed cookie that selects a host (mirrors hub
// server.ts HOST_COOKIE = "rdsh_host").
const HostCookieName = "rdsh_host"

// normalizeHeaders strips hop-by-hop / host / authorization, and forwards only
// the gateway access cookie (rdsh_gate). Mirrors relay.ts normalizeHeaders.
func normalizeHeaders(h http.Header) tunnel.Headers {
	out := make(tunnel.Headers, len(h))
	for k, vs := range h {
		lk := strings.ToLower(k)
		switch lk {
		case "connection", "upgrade", "host", "authorization":
			continue
		case "cookie":
			if gate := extractGateCookie(vs); gate != "" {
				out["cookie"] = []string{"rdsh_gate=" + gate}
			}
		default:
			out[k] = append([]string(nil), vs...)
		}
	}
	return out
}

// extractGateCookie pulls the rdsh_gate value out of a Cookie header value list.
func extractGateCookie(vs []string) string {
	for _, s := range vs {
		for _, part := range strings.Split(s, ";") {
			idx := strings.IndexByte(part, '=')
			if idx <= 0 {
				continue
			}
			if strings.TrimSpace(part[:idx]) == "rdsh_gate" {
				return strings.TrimSpace(part[idx+1:])
			}
		}
	}
	return ""
}

func cookieValue(req *http.Request, name string) string {
	c, err := req.Cookie(name)
	if err != nil {
		return ""
	}
	return c.Value
}

// httpHandler is the tunnel-side StreamHandler that writes to an http.ResponseWriter.
type httpHandler struct {
	w         http.ResponseWriter
	responded bool
	meter     Meter
	userID    int64
	hostID    string
}

func (h *httpHandler) OnResponse(status int, reason string, headers http.Header) {
	h.responded = true
	for k, vs := range headers {
		for _, v := range vs {
			h.w.Header().Add(k, v)
		}
	}
	h.w.WriteHeader(status)
}

func (h *httpHandler) OnData(chunk []byte) {
	if h.meter != nil {
		h.meter(h.hostID, h.userID, 0, int64(len(chunk)))
	}
	if _, err := h.w.Write(chunk); err != nil {
		return
	}
}

func (h *httpHandler) OnClose(code int, message string) {
	// response body complete
}

func (h *httpHandler) OnError(code, message string) {
	if !h.responded {
		writeError(h.w, http.StatusBadGateway, "UPSTREAM_ERROR", code+": "+message)
	}
}

// HandleHTTP relays an HTTP/SSE request over the host's tunnel.
func (n *Node) HandleHTTP(w http.ResponseWriter, req *http.Request) {
	hostID, userID, ok := n.Authorize(req)
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid host session")
		return
	}
	conn := n.Tunnels.Get(hostID)
	if conn == nil {
		writeError(w, http.StatusServiceUnavailable, "HOST_OFFLINE", "host is offline")
		return
	}

	headers := normalizeHeaders(req.Header)
	h := &httpHandler{w: w, meter: n.Meter, userID: userID, hostID: hostID}
	streamID := conn.OpenStream("http", req.URL.RequestURI(), req.Method, headers, h)

	// Stream the request body.
	body := req.Body
	buf := make([]byte, 32*1024)
	for {
		nRead, err := body.Read(buf)
		if nRead > 0 {
			if n.Meter != nil {
				n.Meter(hostID, userID, int64(nRead), 0)
			}
			conn.SendData(streamID, buf[:nRead])
		}
		if err != nil {
			break
		}
	}
	conn.EndRequest(streamID)
}

// wsHandler relays a browser WS ↔ tunnel stream.
type wsHandler struct {
	client   *websocket.Conn
	conn     *tunnel.Conn
	streamID uint32
	meter    Meter
	userID   int64
	hostID   string
}

func (h *wsHandler) OnResponse(status int, reason string, headers http.Header) {}
func (h *wsHandler) OnData(chunk []byte) {
	if h.meter != nil {
		h.meter(h.hostID, h.userID, 0, int64(len(chunk)))
	}
	// DSH WS is text/JSON — forward as text frame.
	_ = h.client.WriteMessage(websocket.TextMessage, chunk)
}
func (h *wsHandler) OnClose(code int, message string) {
	_ = h.client.Close()
	h.conn.AbortStream(h.streamID)
}
func (h *wsHandler) OnError(code, message string) {
	_ = h.client.Close()
	h.conn.AbortStream(h.streamID)
}

// HandleWSUpgrade relays a browser WebSocket upgrade over the tunnel.
func (n *Node) HandleWSUpgrade(w http.ResponseWriter, req *http.Request, path string) {
	hostID, userID, ok := n.Authorize(req)
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid host session")
		return
	}
	conn := n.Tunnels.Get(hostID)
	if conn == nil {
		writeError(w, http.StatusServiceUnavailable, "HOST_OFFLINE", "host is offline")
		return
	}
	client, err := n.Upgrader.Upgrade(w, req, nil)
	if err != nil {
		return
	}
	client.SetReadLimit(n.MaxPayload)

	h := &wsHandler{client: client, conn: conn, meter: n.Meter, userID: userID, hostID: hostID}
	streamID := conn.OpenStream("ws", path, "GET", normalizeHeaders(req.Header), h)
	h.streamID = streamID

	for {
		mt, data, err := client.ReadMessage()
		if err != nil {
			break
		}
		if mt == websocket.TextMessage || mt == websocket.BinaryMessage {
			if n.Meter != nil {
				n.Meter(hostID, userID, int64(len(data)), 0)
			}
			conn.SendData(streamID, data)
		}
	}
	conn.AbortStream(streamID)
}

// HandleRawUpgrade relays an E2EE raw stream (binary bytes both ways).
func (n *Node) HandleRawUpgrade(w http.ResponseWriter, req *http.Request) {
	hostID, userID, ok := n.Authorize(req)
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "invalid host session")
		return
	}
	conn := n.Tunnels.Get(hostID)
	if conn == nil {
		writeError(w, http.StatusServiceUnavailable, "HOST_OFFLINE", "host is offline")
		return
	}
	client, err := n.RawUpgrader.Upgrade(w, req, nil)
	if err != nil {
		return
	}
	client.SetReadLimit(n.MaxPayload)

	h := &wsHandler{client: client, conn: conn, meter: n.Meter, userID: userID, hostID: hostID}
	streamID := conn.OpenRawStream(h)
	h.streamID = streamID

	for {
		mt, data, err := client.ReadMessage()
		if err != nil {
			break
		}
		if mt == websocket.TextMessage || mt == websocket.BinaryMessage {
			if n.Meter != nil {
				n.Meter(hostID, userID, int64(len(data)), 0)
			}
			conn.SendRawData(streamID, data)
		}
	}
	conn.AbortStream(streamID)
}
