package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPublicCatalogConfigurationFailsClosed(t *testing.T) {
	cfg := defaultConfig()
	cfg.OLAdminUser, cfg.OLAdminPass, cfg.MinURLTTLSeconds = "fixture", "fixture", 600
	directory := t.TempDir()
	cfg.PublicCatalogPath = filepath.Join(directory, "catalog.json")
	if cfg.validate() == nil {
		t.Fatal("missing catalog accepted")
	}
	if err := os.WriteFile(cfg.PublicCatalogPath, []byte(`[{"id":"secret","password":"must-not-publish"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	if cfg.validate() == nil {
		t.Fatal("private unknown fields accepted")
	}
	if err := os.WriteFile(cfg.PublicCatalogPath, []byte("[]"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := cfg.validate(); err != nil {
		t.Fatal(err)
	}
}

func TestGatewayAlwaysProvidesAPIsOnly(t *testing.T) {
	h, card := testHandler(t)
	routes := h.routes()
	for _, path := range []string{"/", "/redeem", "/item/101", "/dl/private/a.zip", "/brand/logo.png", "/assets/redeem.js"} {
		response := httptest.NewRecorder()
		routes.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s: %d", path, response.Code)
		}
	}
	catalog := httptest.NewRecorder()
	routes.ServeHTTP(catalog, httptest.NewRequest(http.MethodGet, "/api/catalog", nil))
	var result struct {
		Code      int
		Resources []publicResource
	}
	if err := json.Unmarshal(catalog.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Code != 200 || len(result.Resources) != 4 {
		t.Fatal("catalog unavailable in API-only mode")
	}
	if catalog.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("catalog cached")
	}
	if !strings.Contains(catalog.Header().Get("Content-Security-Policy"), "object-src 'none'") {
		t.Fatal("security policy missing")
	}
	credential := redeemCredential(t, h, card)
	if credential == "" {
		t.Fatal("redemption API unavailable")
	}
	got, err := loadCard(h.db, card.CardID)
	if err != nil || got.Quota != 2 {
		t.Fatal("reads or redemption consumed a grant")
	}
	unknown := httptest.NewRecorder()
	routes.ServeHTTP(unknown, httptest.NewRequest(http.MethodGet, "/api/unknown", nil))
	if unknown.Code != 404 || !strings.Contains(unknown.Header().Get("Content-Type"), "application/json") {
		t.Fatal("unknown API became an HTML document")
	}
}

func TestCatalogMethodsAndUnavailableHEAD(t *testing.T) {
	h, _ := testHandler(t)
	for _, unavailable := range []bool{false, true} {
		if unavailable {
			h.catalogErr = errors.New("private filesystem detail")
		}
		head := httptest.NewRecorder()
		h.routes().ServeHTTP(head, httptest.NewRequest(http.MethodHead, "/api/catalog", nil))
		want := http.StatusOK
		if unavailable {
			want = http.StatusServiceUnavailable
		}
		if head.Code != want || head.Body.Len() != 0 {
			t.Fatalf("HEAD available=%v: code=%d body=%q", !unavailable, head.Code, head.Body.String())
		}
	}
	get := httptest.NewRecorder()
	h.routes().ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/catalog", nil))
	if get.Code != 503 || strings.Contains(get.Body.String(), "filesystem") {
		t.Fatal("catalog diagnostics disclosed")
	}
	post := httptest.NewRecorder()
	h.routes().ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/api/catalog", nil))
	if post.Code != 405 || post.Header().Get("Allow") != "GET, HEAD" {
		t.Fatal("catalog accepted a mutation")
	}
}
