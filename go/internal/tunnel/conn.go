package tunnel

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// StreamHandler is the tunnel-side callback for one stream (a client request
// flowing hub/node → gateway). Mirrors hub/src/tunnel.ts StreamHandler.
type StreamHandler interface {
	OnResponse(status int, reason string, headers http.Header)
	OnData(chunk []byte)
	OnClose(code int, message string)
	OnError(code string, message string)
}

// Timings carries heartbeat knobs (zero values fall back to protocol defaults).
type Timings struct {
	HeartbeatMs   time.Duration
	PongTimeoutMs time.Duration
}

const (
	defaultHeartbeatMs   = 30 * time.Second
	defaultPongTimeoutMs = 10 * time.Second
)

// Conn is one host gateway's tunnel connection. Mirrors hub/src/tunnel.ts
// TunnelConn: frame handling + heartbeat + stream-id allocation.
type Conn struct {
	ws     *websocket.Conn
	hostID string
	onClose func(hostID string)

	writeMu sync.Mutex
	parser  Parser

	streamsMu sync.Mutex
	streams   map[uint32]StreamHandler
	nextID    uint32

	heartbeatMs   time.Duration
	pongTimeoutMs time.Duration

	done     chan struct{}
	doneOnce sync.Once

	livenessMu    sync.Mutex
	livenessTimer *time.Timer
}

// NewConn wraps an established WebSocket as a tunnel connection and starts its
// read loop + symmetric heartbeat.
func NewConn(ws *websocket.Conn, hostID string, onClose func(hostID string), timings Timings) *Conn {
	if timings.HeartbeatMs == 0 {
		timings.HeartbeatMs = defaultHeartbeatMs
	}
	if timings.PongTimeoutMs == 0 {
		timings.PongTimeoutMs = defaultPongTimeoutMs
	}
	c := &Conn{
		ws:            ws,
		hostID:        hostID,
		onClose:       onClose,
		streams:       make(map[uint32]StreamHandler),
		nextID:        1,
		heartbeatMs:   timings.HeartbeatMs,
		pongTimeoutMs: timings.PongTimeoutMs,
		done:          make(chan struct{}),
	}
	go c.readLoop()
	go c.heartbeatLoop()
	return c
}

// HostID returns the host this tunnel belongs to.
func (c *Conn) HostID() string { return c.hostID }

func (c *Conn) closed() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

func (c *Conn) close() {
	c.doneOnce.Do(func() {
		close(c.done)
		c.clearLiveness()
		if c.onClose != nil {
			c.onClose(c.hostID)
		}
	})
}

func (c *Conn) readLoop() {
	defer c.close()
	for {
		msgType, data, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		if msgType != websocket.BinaryMessage {
			continue // text frames are not protocol content
		}
		// Any inbound frame is liveness evidence.
		c.clearLiveness()
		frames, err := c.parser.Push(data)
		if err != nil {
			c.send(TypeError, 0, mustJSON(map[string]any{"code": "PROTOCOL", "message": err.Error()}), 0)
			c.Terminate()
			return
		}
		for _, f := range frames {
			c.handleFrame(f)
		}
	}
}

func (c *Conn) heartbeatLoop() {
	ticker := time.NewTicker(c.heartbeatMs)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-ticker.C:
			if c.closed() {
				return
			}
			c.send(TypePing, 0, mustJSON(map[string]any{"ts": time.Now().UnixMilli()}), 0)
			c.armLiveness()
		}
	}
}

// armLiveness arms the dead-deadline only when none is pending (mirrors TS:
// "只在没有未决死线时武装" — otherwise the deadline is pushed every cycle).
func (c *Conn) armLiveness() {
	c.livenessMu.Lock()
	defer c.livenessMu.Unlock()
	if c.livenessTimer != nil {
		return
	}
	c.livenessTimer = time.AfterFunc(c.pongTimeoutMs, func() {
		c.Terminate()
	})
}

func (c *Conn) clearLiveness() {
	c.livenessMu.Lock()
	defer c.livenessMu.Unlock()
	if c.livenessTimer != nil {
		c.livenessTimer.Stop()
		c.livenessTimer = nil
	}
}

// AssignStreamID allocates a stream id (atomic increment, uint32 wrap).
func (c *Conn) AssignStreamID() uint32 {
	c.streamsMu.Lock()
	defer c.streamsMu.Unlock()
	id := c.nextID
	c.nextID++
	return id
}

// OpenStream opens a client request stream (http/ws) and returns its stream id.
func (c *Conn) OpenStream(kind, path, method string, headers http.Header, h StreamHandler) uint32 {
	streamID := c.AssignStreamID()
	c.setStream(streamID, h)
	c.send(TypeOpen, streamID, mustJSON(RequestOpen{Kind: kind, Path: path, Method: method, Headers: httpToHeaders(headers)}), 0)
	return streamID
}

// OpenRawStream opens an E2EE raw stream and returns its stream id.
func (c *Conn) OpenRawStream(h StreamHandler) uint32 {
	streamID := c.AssignStreamID()
	c.setStream(streamID, h)
	c.send(TypeOpen, streamID, mustJSON(RequestOpen{Kind: "raw"}), FlagE2E)
	return streamID
}

// SendData sends a request-body chunk.
func (c *Conn) SendData(streamID uint32, chunk []byte) {
	c.send(TypeData, streamID, chunk, 0)
}

// SendRawData sends a raw-stream chunk (E2EE frame flag).
func (c *Conn) SendRawData(streamID uint32, chunk []byte) {
	c.send(TypeData, streamID, chunk, FlagE2E)
}

// ActiveStreams returns the number of open streams (R18/R39 drain waits for zero).
func (c *Conn) ActiveStreams() int {
	c.streamsMu.Lock()
	defer c.streamsMu.Unlock()
	return len(c.streams)
}

// SendRedirect sends a REDIRECT frame (P1.5 migration, R39).
func (c *Conn) SendRedirect(nodeURL string, expiresAt int64, sig string) {
	c.send(TypeRedirect, 0, mustJSON(map[string]any{"nodeUrl": nodeURL, "expiresAt": expiresAt, "sig": sig}), 0)
}

// EndRequest notifies the gateway the request body is complete (CLOSE code 0).
// The handler is kept — the response is still incoming.
func (c *Conn) EndRequest(streamID uint32) {
	c.send(TypeClose, streamID, mustJSON(map[string]any{"code": 0}), 0)
}

// AbortStream notifies the gateway the client aborted (CLOSE code 1) and drops
// the stream.
func (c *Conn) AbortStream(streamID uint32) {
	c.send(TypeClose, streamID, mustJSON(map[string]any{"code": 1, "message": "client aborted"}), 0)
	c.takeStream(streamID)
}

// Terminate force-closes the tunnel (used for liveness timeout and protocol errors).
func (c *Conn) Terminate() {
	c.close()
	_ = c.ws.Close()
}

func (c *Conn) send(typ byte, streamID uint32, payload []byte, flags byte) {
	frame, err := EncodeFrame(typ, streamID, payload, flags)
	if err != nil {
		return
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.ws.WriteMessage(websocket.BinaryMessage, frame)
}

func (c *Conn) getStream(id uint32) StreamHandler {
	c.streamsMu.Lock()
	defer c.streamsMu.Unlock()
	return c.streams[id]
}

func (c *Conn) setStream(id uint32, h StreamHandler) {
	c.streamsMu.Lock()
	defer c.streamsMu.Unlock()
	c.streams[id] = h
}

func (c *Conn) takeStream(id uint32) StreamHandler {
	c.streamsMu.Lock()
	defer c.streamsMu.Unlock()
	h := c.streams[id]
	delete(c.streams, id)
	return h
}

func (c *Conn) handleFrame(f Frame) {
	switch f.Type {
	case TypePing:
		c.send(TypePong, f.StreamID, f.Payload, 0)
	case TypePong:
		// liveness already cleared in read loop
	case TypeOpen:
		if h := c.getStream(f.StreamID); h != nil {
			var ro ResponseOpen
			if err := json.Unmarshal(f.Payload, &ro); err != nil {
				h.OnError("BAD_RESPONSE", "malformed response open")
				return
			}
			status := ro.Status
			if status == 0 {
				status = 502
			}
			h.OnResponse(status, ro.Reason, HeadersToHTTP(ro.Headers))
		}
	case TypeData:
		if h := c.getStream(f.StreamID); h != nil {
			h.OnData(f.Payload)
		}
	case TypeClose:
		if h := c.takeStream(f.StreamID); h != nil {
			var p struct {
				Code    *int    `json:"code"`
				Message *string `json:"message"`
			}
			_ = json.Unmarshal(f.Payload, &p)
			code, msg := 0, ""
			if p.Code != nil {
				code = *p.Code
			}
			if p.Message != nil {
				msg = *p.Message
			}
			h.OnClose(code, msg)
		}
	case TypeError:
		if h := c.takeStream(f.StreamID); h != nil {
			var p struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			}
			_ = json.Unmarshal(f.Payload, &p)
			h.OnError(p.Code, p.Message)
		}
	default:
		// Frame domain (A1): unknown core = protocol error; unknown extension = ignore.
		if IsUnknownCoreType(f.Type) {
			c.send(TypeError, 0, mustJSON(map[string]any{
				"code":    "UNKNOWN_FRAME",
				"message": fmt.Sprintf("unknown core frame type 0x%02x", f.Type),
			}), 0)
			c.Terminate()
		}
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func httpToHeaders(h http.Header) Headers {
	out := make(Headers, len(h))
	for k, vs := range h {
		out[k] = append([]string(nil), vs...)
	}
	return out
}

// Registry is the hostId → active tunnel map. Mirrors hub/src/tunnel.ts
// TunnelRegistry, including identity-checked unregister (reconnect race).
type Registry struct {
	mu sync.Mutex
	m  map[string]*Conn
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{m: make(map[string]*Conn)}
}

// Register adds a tunnel, kicking the previous connection for the same host.
func (r *Registry) Register(c *Conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing := r.m[c.HostID()]; existing != nil {
		existing.Terminate()
	}
	r.m[c.HostID()] = c
}

// Unregister removes a tunnel only if it is still the registered one
// (identity-checked to avoid tearing down a newer reconnect).
func (r *Registry) Unregister(hostID string, c *Conn) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.m[hostID] != c {
		return false
	}
	delete(r.m, hostID)
	return true
}

// Get returns the active tunnel for a host, or nil.
func (r *Registry) Get(hostID string) *Conn {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.m[hostID]
}

// IsOnline reports whether a host has an active tunnel.
func (r *Registry) IsOnline(hostID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.m[hostID]
	return ok
}

// List returns the currently-connected host ids.
func (r *Registry) List() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.m))
	for k := range r.m {
		out = append(out, k)
	}
	return out
}
