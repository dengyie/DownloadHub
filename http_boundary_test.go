package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestProxyTrustAndEndpointIsolation(t *testing.T) {
	h, _ := testHandler(t)
	request := func(path, peer, claimed string) *http.Request {
		r := httptest.NewRequest("POST", path, nil)
		r.RemoteAddr = peer
		r.Header.Set("X-Real-IP", claimed)
		return r
	}
	for i := 0; i < 20; i++ {
		if !h.limited(request("/api/redeem", "203.0.113.4:1000", "198.51.100.1"), 20) {
			t.Fatal(i)
		}
	}
	if h.limited(request("/api/redeem", "203.0.113.4:2000", "198.51.100.2"), 20) {
		t.Fatal("spoofed header or new port bypassed limit")
	}
	if !h.limited(request("/api/grants", "203.0.113.4:2000", ""), 120) {
		t.Fatal("endpoint limits mixed")
	}
	h.trusted = []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	if !h.limited(request("/api/redeem", "127.0.0.1:1234", "198.51.100.20"), 20) {
		t.Fatal("trusted forwarding ignored")
	}
}
func TestConfigFailsUnsafeAndUnverifiedSettings(t *testing.T) {
	c := defaultConfig()
	c.OLAdminUser = "admin"
	c.OLAdminPass = "fixture"
	if c.validate() == nil {
		t.Fatal("unverified signature TTL accepted")
	}
	c.MinURLTTLSeconds = 600
	if e := c.validate(); e != nil {
		t.Fatal(e)
	}
	c.PublicPrefixes = []string{"/pub/"}
	if c.validate() == nil {
		t.Fatal("ambiguous public prefix accepted")
	}
	c.PublicPrefixes = []string{"pub/"}
	c.DownloadHosts = []string{"host.example/path"}
	if c.validate() == nil {
		t.Fatal("invalid host accepted")
	}
}
func TestCardInputMatchesHTTPBoundaries(t *testing.T) {
	if validateCardInput(1, "member", nil, []string{strings.Repeat("a", 2049)}, nil) == nil {
		t.Fatal("oversized resource accepted")
	}
	resources := make([]string, 101)
	for i := range resources {
		resources[i] = "private/a"
	}
	if validateCardInput(1, "member", nil, resources, nil) == nil {
		t.Fatal("oversized resource count accepted")
	}
}
func TestBackendURLHostRejectedWithoutCharge(t *testing.T) {
	h, c := testHandler(t)
	key := redeemCredential(t, h, c)
	h.service.backend = &fakeOL{get: func(context.Context, string) (string, error) { return "https://unexpected.example/a", nil }}
	if _, e := h.service.issue(context.Background(), key); !errors.Is(e, ErrBackend) {
		t.Fatal(e)
	}
	got, _ := loadCard(h.db, c.CardID)
	if got.Quota != 2 {
		t.Fatal("bad target charged")
	}
}
func TestGrantExpiredCleanupAndRetention(t *testing.T) {
	s, key, _ := grantFixture(t)
	now := time.Now()
	g, _ := s.acquire(context.Background(), key, now, time.Minute)
	g, e := s.finish(context.Background(), g, "https://files.example/a", now.Add(time.Second), now)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.cleanup(context.Background(), now.Add(2*time.Second), 24*time.Hour); e != nil {
		t.Fatal(e)
	}
	var raw string
	s.db.QueryRow(`SELECT result_url FROM grants WHERE id=?`, g.ID).Scan(&raw)
	if raw != "" {
		t.Fatal("expired URL retained")
	}
	var n int
	s.db.QueryRow(`SELECT count(*) FROM quota_events`).Scan(&n)
	if n != 1 {
		t.Fatal("audit prematurely erased")
	}
	s.cleanup(context.Background(), now.Add(25*time.Hour), 24*time.Hour)
	s.db.QueryRow(`SELECT count(*) FROM quota_events`).Scan(&n)
	if n != 0 {
		t.Fatal("audit retention ignored")
	}
}
func TestGrantBindingChangedWhilePending(t *testing.T) {
	s, key, c := grantFixture(t)
	g, _ := s.acquire(context.Background(), key, time.Now(), time.Minute)
	s.db.Exec(`UPDATE cards SET resources='["private/other"]' WHERE card_id=?`, c.CardID)
	if _, e := s.finish(context.Background(), g, "https://files.example/a", time.Now().Add(time.Minute), time.Now()); !errors.Is(e, ErrDenied) {
		t.Fatal(e)
	}
}
func TestGrantCredentialExpiresWhilePending(t *testing.T) {
	s, key, _ := grantFixture(t)
	now := time.Now()
	g, _ := s.acquire(context.Background(), key, now, time.Hour)
	if _, e := s.finish(context.Background(), g, "https://files.example/a", now.Add(time.Hour), now.Add(2*time.Minute)); !errors.Is(e, ErrExpired) {
		t.Fatal(e)
	}
}

func TestEmbeddedApplicationAssetsAreNotCached(t *testing.T) {
	h, _ := testHandler(t)
	for _, path := range []string{"/assets/redeem.js", "/assets/redeem.css"} {
		w := httptest.NewRecorder()
		h.routes().ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: status=%d cache=%q", path, w.Code, w.Header().Get("Cache-Control"))
		}
	}
}
