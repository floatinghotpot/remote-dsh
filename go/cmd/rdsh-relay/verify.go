package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// hostCookie verifies the signed host cookie (Ed25519, R17/R3).
//
// Cookie layout (mirrors auth.ts signHostCookie, but Ed25519 instead of HMAC):
//
//	payload = hostId + "." + userId + "." + ver + "." + exp
//	sig     = hex(Ed25519_Sign(accountPrivate, payload))
//	cookie  = base64url(payload + "." + sig)
//
// The node holds only the public key, so it can verify but never forge.
type hostCookie struct {
	pub ed25519.PublicKey
}

// verify parses + verifies a host cookie, returning (hostID, userID, ver, ok).
// The caller validates `ver` against the local host cache (N5 sync).
func (c *hostCookie) verify(cookie string) (hostID string, userID int64, ver int64, ok bool) {
	if c.pub == nil {
		return "", 0, 0, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(cookie)
	if err != nil {
		return "", 0, 0, false
	}
	parts := strings.Split(string(raw), ".")
	if len(parts) != 5 {
		return "", 0, 0, false
	}
	hostID = parts[0]
	userID, err = strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return "", 0, 0, false
	}
	ver, err = strconv.ParseInt(parts[2], 10, 64)
	if err != nil {
		return "", 0, 0, false
	}
	exp, err := strconv.ParseInt(parts[3], 10, 64)
	if err != nil {
		return "", 0, 0, false
	}
	sig, err := hex.DecodeString(parts[4])
	if err != nil {
		return "", 0, 0, false
	}
	payload := strings.Join(parts[:4], ".")
	if !ed25519.Verify(c.pub, []byte(payload), sig) {
		return "", 0, 0, false
	}
	if exp <= time.Now().UnixMilli() {
		return "", 0, 0, false
	}
	return hostID, userID, ver, true
}

// decodeHexKey decodes a hex Ed25519 public key (32 bytes).
func decodeHexKey(s string) ([]byte, error) {
	b, err := hex.DecodeString(s)
	if err != nil {
		return nil, err
	}
	if len(b) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("Ed25519 public key must be %d bytes, got %d", ed25519.PublicKeySize, len(b))
	}
	return b, nil
}
