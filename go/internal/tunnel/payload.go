package tunnel

import (
	"encoding/json"
	"net/http"
)

// Headers is the wire header form used in OPEN payloads: a single value is
// stored as a one-element slice; multi-value headers may hold several values.
type Headers = map[string][]string

// JSONPayload encodes v to a JSON byte slice.
func JSONPayload(v any) ([]byte, error) {
	return json.Marshal(v)
}

// MustJSON encodes v to JSON, ignoring errors (values are trusted internal).
func MustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// ParseJSONPayload decodes a frame payload as a JSON object.
func ParseJSONPayload(payload []byte) (map[string]any, error) {
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// RequestOpen is an OPEN request payload (node → gateway).
type RequestOpen struct {
	Kind    string  `json:"kind"` // "http" | "ws" | "raw"
	Method  string  `json:"method,omitempty"`
	Path    string  `json:"path,omitempty"`
	Headers Headers `json:"headers,omitempty"`
}

// ResponseOpen is an OPEN response payload (gateway → node).
type ResponseOpen struct {
	Kind    string  `json:"kind"`
	Status  int     `json:"status,omitempty"`
	Reason  string  `json:"reason,omitempty"`
	Headers Headers `json:"headers,omitempty"`
}

// HeadersToHTTP converts the wire header form to net/http.Header.
func HeadersToHTTP(h Headers) http.Header {
	out := make(http.Header, len(h))
	for k, vs := range h {
		out[k] = append([]string(nil), vs...)
	}
	return out
}
