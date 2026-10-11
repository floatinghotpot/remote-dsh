package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"
	"time"
)

func signCookie(t *testing.T, priv ed25519.PrivateKey, hostID string, userID, ver int64, exp int64) string {
	t.Helper()
	payload := strings.Join([]string{hostID, strconv.FormatInt(userID, 10), strconv.FormatInt(ver, 10), strconv.FormatInt(exp, 10)}, ".")
	sig := ed25519.Sign(priv, []byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload + "." + hex.EncodeToString(sig)))
}

func TestHostCookieRoundtrip(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	exp := time.Now().Add(time.Hour).UnixMilli()
	cookie := signCookie(t, priv, "host-abc", 42, 3, exp)
	c := &hostCookie{pub: pub}
	hostID, userID, ver, ok := c.verify(cookie)
	if !ok {
		t.Fatal("valid cookie rejected")
	}
	if hostID != "host-abc" || userID != 42 || ver != 3 {
		t.Fatalf("got (%s,%d,%d)", hostID, userID, ver)
	}
}

func TestHostCookieTampered(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	exp := time.Now().Add(time.Hour).UnixMilli()
	cookie := signCookie(t, priv, "host-abc", 42, 3, exp)
	// tamper the user id (replace "42" with "99" in the decoded payload)
	raw, _ := base64.RawURLEncoding.DecodeString(cookie)
	parts := strings.Split(string(raw), ".")
	parts[1] = "99"
	tampered := base64.RawURLEncoding.EncodeToString([]byte(strings.Join(parts, ".")))
	c := &hostCookie{pub: pub}
	if _, _, _, ok := c.verify(tampered); ok {
		t.Fatal("tampered cookie accepted")
	}
}

func TestHostCookieWrongKey(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	exp := time.Now().Add(time.Hour).UnixMilli()
	cookie := signCookie(t, priv, "host-abc", 42, 3, exp)
	c := &hostCookie{pub: otherPub}
	if _, _, _, ok := c.verify(cookie); ok {
		t.Fatal("cookie signed by another key accepted")
	}
}

func TestHostCookieExpired(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	exp := time.Now().Add(-time.Hour).UnixMilli()
	cookie := signCookie(t, priv, "host-abc", 42, 3, exp)
	c := &hostCookie{pub: pub}
	if _, _, _, ok := c.verify(cookie); ok {
		t.Fatal("expired cookie accepted")
	}
}

func TestHostCookieNoKey(t *testing.T) {
	c := &hostCookie{pub: nil}
	if _, _, _, ok := c.verify("whatever"); ok {
		t.Fatal("cookie accepted with no public key configured")
	}
}
