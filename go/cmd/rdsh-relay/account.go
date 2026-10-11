package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// account is the protocol-B client (node → account service). Mirrors the
// N1/N2/N4/N5 contract in solution.md §6.2 (upstream periodic requests).
type account struct {
	baseURL string
	token   string // node token (R12-N6 auth)
	http    *http.Client
}

func newAccount(baseURL, token string) *account {
	return &account{
		baseURL: baseURL,
		token:   token,
		http:    &http.Client{Timeout: 15 * time.Second},
	}
}

// NodeInfo is the N1 register response.
type NodeInfo struct {
	NodeID string `json:"nodeId"`
}

// Load is the N2 heartbeat payload.
type Load struct {
	Connections  int64 `json:"connections"`
	ActiveStreams int64 `json:"activeStreams"`
	BytesIn      int64 `json:"bytesIn"`
	BytesOut     int64 `json:"bytesOut"`
	CPU          int   `json:"cpu"`
	Mem          int   `json:"mem"`
	Capacity     int64 `json:"capacity"` // max concurrent connections
}

// SyncData is the N5 data-sync response: everything the node needs to verify
// host cookies + authorize clients locally (no account-service round-trip).
type SyncData struct {
	Hosts            []HostEntry `json:"hosts"`
	HostCookiePubKey string      `json:"hostCookiePubKey"` // Ed25519 hex
	Draining         bool        `json:"draining"`
}

// HostEntry is one host's local authorization data (N5).
type HostEntry struct {
	HostID   string           `json:"hostId"`
	OwnerID  int64            `json:"ownerId"`
	Online   bool             `json:"online"`
	UserVers map[string]int64 `json:"userVers"` // userId (string key) → session ver
}

func (a *account) post(path string, body any, out any) error {
	buf, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, a.baseURL+path, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+a.token)
	resp, err := a.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s: HTTP %d: %s", path, resp.StatusCode, string(data))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

// Register is N1: node register → nodeId.
func (a *account) Register(name, advertiseURL string, capabilities []string) (*NodeInfo, error) {
	var out NodeInfo
	err := a.post("/api/nodes/register", map[string]any{
		"name":         name,
		"advertiseUrl": advertiseURL,
		"capabilities": capabilities,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Heartbeat is N2: periodic load report.
func (a *account) Heartbeat(nodeID string, load Load) error {
	return a.post("/api/nodes/heartbeat", map[string]any{
		"nodeId":       nodeID,
		"connections":  load.Connections,
		"activeStreams": load.ActiveStreams,
		"bytesIn":      load.BytesIn,
		"bytesOut":     load.BytesOut,
		"cpu":          load.CPU,
		"mem":          load.Mem,
		"capacity":     load.Capacity,
	}, nil)
}

// HostUpsert is N4: host online/offline registration (idempotent).
func (a *account) HostUpsert(nodeID, hostID string, online bool) error {
	return a.post("/api/nodes/hosts", map[string]any{
		"nodeId": nodeID,
		"hostId": hostID,
		"online": online,
	}, nil)
}

// Sync is N5: pull host authorization data + pubkey + draining flag.
func (a *account) Sync(nodeID string) (*SyncData, error) {
	var out SyncData
	err := a.post("/api/nodes/sync", map[string]any{"nodeId": nodeID}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// AssignVerify validates a gateway's one-time assign token (R35) and returns
// its hostId. The node calls back to the account service, which consumed the
// token when the gateway was redirected here.
func (a *account) AssignVerify(token string) (string, bool) {
	var out struct {
		HostID string `json:"hostId"`
	}
	err := a.post("/api/nodes/assign", map[string]any{"assign": token}, &out)
	if err != nil || out.HostID == "" {
		return "", false
	}
	return out.HostID, true
}
