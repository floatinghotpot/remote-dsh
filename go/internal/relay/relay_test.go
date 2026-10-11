package relay

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/floatinghotpot/remote-dsh/go/internal/tunnel"
	"github.com/gorilla/websocket"
)

func TestNormalizeHeaders(t *testing.T) {
	h := http.Header{
		"Connection":    {"keep-alive"},
		"Upgrade":       {"websocket"},
		"Host":          {"node.example.com"},
		"Authorization": {"Bearer secret"},
		"Content-Type":  {"application/json"},
		"Cookie":        {"rdsh_gate=abc; rdsh_hub_session=secret"},
	}
	out := normalizeHeaders(h)
	for _, k := range []string{"connection", "upgrade", "host", "authorization"} {
		if _, ok := out[k]; ok {
			t.Fatalf("%s must be stripped", k)
		}
	}
	if got := out["Content-Type"]; len(got) != 1 || got[0] != "application/json" {
		t.Fatalf("Content-Type = %v", got)
	}
	// only the gateway cookie survives; the session cookie is stripped
	if got := out["cookie"]; len(got) != 1 || got[0] != "rdsh_gate=abc" {
		t.Fatalf("cookie = %v, want [rdsh_gate=abc]", got)
	}
}

// TestHandleHTTPForwards runs a fake gateway over a real WebSocket and asserts
// that HandleHTTP forwards the request and streams the response back.
func TestHandleHTTPForwards(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		var p tunnel.Parser
		for {
			_, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			frames, err := p.Push(data)
			if err != nil {
				return
			}
			for _, f := range frames {
				switch f.Type {
				case tunnel.TypePing:
					pong, _ := tunnel.EncodeFrame(tunnel.TypePong, f.StreamID, f.Payload, 0)
					_ = ws.WriteMessage(websocket.BinaryMessage, pong)
				case tunnel.TypeOpen:
					// Respond 200 + "hello" body, then CLOSE.
					respOpen, _ := tunnel.EncodeFrame(tunnel.TypeOpen, f.StreamID,
						tunnel.MustJSON(map[string]any{"kind": "http", "status": 200, "headers": map[string][]string{"content-type": {"text/plain"}}}), 0)
					_ = ws.WriteMessage(websocket.BinaryMessage, respOpen)
					body, _ := tunnel.EncodeFrame(tunnel.TypeData, f.StreamID, []byte("hello"), 0)
					_ = ws.WriteMessage(websocket.BinaryMessage, body)
					closeF, _ := tunnel.EncodeFrame(tunnel.TypeClose, f.StreamID, tunnel.MustJSON(map[string]any{"code": 0}), 0)
					_ = ws.WriteMessage(websocket.BinaryMessage, closeF)
				}
			}
		}
	}))
	defer gateway.Close()

	wsURL := "ws" + strings.TrimPrefix(gateway.URL, "http") + "/tunnel"
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	conn := tunnel.NewConn(ws, "host-1", func(string) {}, tunnel.Timings{})
	registry := tunnel.NewRegistry()
	registry.Register(conn)

	node := New(registry, func(r *http.Request) (string, int64, bool) { return "host-1", 42, true }, nil)

	req := httptest.NewRequest(http.MethodGet, "http://node.example.com/api/x", nil)
	rec := httptest.NewRecorder()
	node.HandleHTTP(rec, req)

	// The response is written asynchronously by the tunnel read loop; wait for
	// the full body, not just the status header.
	deadline := time.Now().Add(2 * time.Second)
	for rec.Body.String() != "hello" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.String() != "hello" {
		t.Fatalf("body = %q, want %q", rec.Body.String(), "hello")
	}
}

// TestHandleHTTPOffline returns 503 when the host has no tunnel.
func TestHandleHTTPOffline(t *testing.T) {
	node := New(tunnel.NewRegistry(), func(r *http.Request) (string, int64, bool) { return "host-1", 42, true }, nil)
	req := httptest.NewRequest(http.MethodGet, "http://node.example.com/", nil)
	rec := httptest.NewRecorder()
	node.HandleHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

// TestHandleHTTPUnauthorized returns 401 when authorization fails.
func TestHandleHTTPUnauthorized(t *testing.T) {
	node := New(tunnel.NewRegistry(), func(r *http.Request) (string, int64, bool) { return "", 0, false }, nil)
	req := httptest.NewRequest(http.MethodGet, "http://node.example.com/", nil)
	rec := httptest.NewRecorder()
	node.HandleHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

// TestHandleHTTPBlocksUntilResponse uses a real HTTP server (not httptest.NewRecorder)
// to catch the regression where HandleHTTP returned before the async response, causing
// net/http to auto-flush an empty 200 and truncate the body (2026-10-12 white screen).
func TestHandleHTTPBlocksUntilResponse(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		var p tunnel.Parser
		for {
			_, data, err := ws.ReadMessage()
			if err != nil {
				return
			}
			frames, err := p.Push(data)
			if err != nil {
				return
			}
			for _, f := range frames {
				if f.Type != tunnel.TypeOpen {
					continue
				}
				respOpen, _ := tunnel.EncodeFrame(tunnel.TypeOpen, f.StreamID,
					tunnel.MustJSON(map[string]any{"kind": "http", "status": 200, "headers": map[string][]string{"content-type": {"text/plain"}}}), 0)
				_ = ws.WriteMessage(websocket.BinaryMessage, respOpen)
				body, _ := tunnel.EncodeFrame(tunnel.TypeData, f.StreamID, []byte("hello"), 0)
				_ = ws.WriteMessage(websocket.BinaryMessage, body)
				closeF, _ := tunnel.EncodeFrame(tunnel.TypeClose, f.StreamID, tunnel.MustJSON(map[string]any{"code": 0}), 0)
				_ = ws.WriteMessage(websocket.BinaryMessage, closeF)
			}
		}
	}))
	defer gateway.Close()

	wsURL := "ws" + strings.TrimPrefix(gateway.URL, "http") + "/tunnel"
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	conn := tunnel.NewConn(ws, "host-1", func(string) {}, tunnel.Timings{})
	registry := tunnel.NewRegistry()
	registry.Register(conn)

	node := New(registry, func(r *http.Request) (string, int64, bool) { return "host-1", 42, true }, nil)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		node.HandleHTTP(w, r)
	}))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if string(body) != "hello" {
		t.Fatalf("body = %q, want %q (empty body = HandleHTTP returned before the async response)", string(body), "hello")
	}
}
