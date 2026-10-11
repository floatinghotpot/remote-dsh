package main

import "testing"

func TestConfigValidateTLSModes(t *testing.T) {
	base := func() *Config {
		return &Config{AccountURL: "https://rdsh.cn", AdvertiseURL: "https://node.example.com"}
	}

	// behindProxy alone is valid.
	c := base()
	c.BehindProxy = true
	if err := c.validate(); err != nil {
		t.Fatalf("behindProxy: %v", err)
	}

	// tls alone is valid.
	c = base()
	c.TLS = &TLS{Cert: "/c", Key: "/k"}
	if err := c.validate(); err != nil {
		t.Fatalf("tls: %v", err)
	}

	// acme alone is valid.
	c = base()
	c.ACME = &ACME{Enabled: true, Email: "ops@example.com"}
	if err := c.validate(); err != nil {
		t.Fatalf("acme: %v", err)
	}

	// none of the three → error.
	c = base()
	if err := c.validate(); err == nil {
		t.Fatal("expected error when no TLS mode configured")
	}

	// acme + behindProxy are mutually exclusive.
	c = base()
	c.ACME = &ACME{Enabled: true}
	c.BehindProxy = true
	if err := c.validate(); err == nil {
		t.Fatal("expected error for acme + behindProxy")
	}

	// acme + tls are mutually exclusive.
	c = base()
	c.ACME = &ACME{Enabled: true}
	c.TLS = &TLS{Cert: "/c", Key: "/k"}
	if err := c.validate(); err == nil {
		t.Fatal("expected error for acme + tls")
	}
}

func TestConfigDefaults(t *testing.T) {
	c := &Config{AccountURL: "https://rdsh.cn", AdvertiseURL: "https://node.example.com", BehindProxy: true}
	_ = c.validate()
	if c.Listen != "0.0.0.0:443" {
		t.Fatalf("default listen = %q", c.Listen)
	}
}
