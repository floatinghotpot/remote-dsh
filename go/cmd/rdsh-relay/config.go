package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Config is the relay.json configuration (R28).
type Config struct {
	AccountURL   string `json:"accountUrl"`   // account-service base URL (https://rdsh.cn)
	AdvertiseURL string `json:"advertiseUrl"` // public node URL (https://sg01.tunnel.rdsh.cn)
	Listen       string `json:"listen"`       // bind address (0.0.0.0:443 or 127.0.0.1:8443)
	DataDir      string `json:"dataDir"`      // state dir (certs cache, nodeId, …)

	// Identity (written by `rdsh-relay join`).
	Name     string `json:"name,omitempty"`     // admin-set display name
	NodeID   string `json:"nodeId,omitempty"`   // assigned at first registration, persisted (R37)
	NodeToken string `json:"nodeToken,omitempty"` // node auth token (R12-N6)
	// Relay usage reporting (R8, 11-usage-analytics): shared node token + instance id.
	RelayNodeToken string `json:"relayNodeToken,omitempty"`
	InstanceID     string `json:"instanceId,omitempty"`

	TLS  *TLS  `json:"tls,omitempty"`  // manual cert (incl. wildcard)
	ACME *ACME `json:"acme,omitempty"` // automatic issuance/renewal
	// BehindProxy: TLS terminated by a reverse proxy (node speaks plain HTTP).
	BehindProxy bool `json:"behindProxy"`

	// HostCookiePubKey is the hex-encoded Ed25519 public key for host-cookie
	// verification (R17). Normally synced from the account service (N5); this
	// field is a bootstrap fallback.
	HostCookiePubKey string `json:"hostCookiePubKey,omitempty"`
}

// TLS is a manually deployed certificate (fullchain + key), including wildcard.
type TLS struct {
	Cert string `json:"cert"`
	Key  string `json:"key"`
}

// ACME is the automatic Let's Encrypt issuance/renewal switch (R27 ①).
type ACME struct {
	Enabled bool   `json:"enabled"`
	Email   string `json:"email"`
}

// validate returns a descriptive error on an invalid/missing required field.
func (c *Config) validate() error {
	if c.AccountURL == "" {
		return errors.New("accountUrl is required")
	}
	if c.AdvertiseURL == "" {
		return errors.New("advertiseUrl is required")
	}
	if c.Listen == "" {
		c.Listen = "0.0.0.0:443"
	}
	if c.ACME != nil && c.ACME.Enabled && c.BehindProxy {
		return errors.New("acme.enabled and behindProxy are mutually exclusive")
	}
	if c.ACME != nil && c.ACME.Enabled && c.TLS != nil {
		return errors.New("acme.enabled and tls are mutually exclusive")
	}
	if !c.BehindProxy && c.TLS == nil && (c.ACME == nil || !c.ACME.Enabled) {
		return errors.New("one of tls / acme.enabled / behindProxy is required")
	}
	return nil
}

// loadConfig reads relay.json from dir, applying defaults.
func loadConfig(dir string) (*Config, error) {
	path := filepath.Join(dir, "relay.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("config not found: %s (run `rdsh-relay join` first)", path)
		}
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

// hostCookiePublicKey decodes the config hex key into a 32-byte public key.
func (c *Config) hostCookiePublicKey() ([]byte, error) {
	if c.HostCookiePubKey == "" {
		return nil, nil // deferred to N5 sync
	}
	b, err := hex.DecodeString(c.HostCookiePubKey)
	if err != nil {
		return nil, fmt.Errorf("hostCookiePubKey: %w", err)
	}
	if len(b) != 32 {
		return nil, fmt.Errorf("hostCookiePubKey: Ed25519 public key must be 32 bytes")
	}
	return b, nil
}
