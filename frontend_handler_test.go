package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestStandaloneFrontendRoutesDoNotExposeOtherFiles(t *testing.T) {
	ui := newFrontendHandler(fstest.MapFS{
		"index.html":                         {Data: []byte("<!doctype html><title>Standalone frontend</title>")},
		"ui/0123456789abcdef01234567/app.js": {Data: []byte("export const safe = true;")},
		".env":                               {Data: []byte("secret")},
		"cards.db":                           {Data: []byte("private database")},
		"ui/0123456789abcdef01234567/secret.json": {Data: []byte("private config")},
	})
	for _, path := range []string{"/", "/redeem", "/resources/frpc-arm64", "/item/12", "/cat/1", "/user/index/query", "/user/authentication/login", "/user/dashboard/index", "/help", "/dl/private/file.zip?token=legacy"} {
		result := httptest.NewRecorder()
		ui.ServeHTTP(result, httptest.NewRequest(http.MethodGet, path, nil))
		if result.Code != 200 || !strings.Contains(result.Body.String(), "Standalone frontend") || result.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: %d %s", path, result.Code, result.Body.String())
		}
	}
	for _, path := range []string{"/missing", "/api/missing", "/admin", "/.env", "/cards.db", "/ui/0123456789abcdef01234567/missing.js", "/ui/0123456789abcdef01234567/secret.json", "/ui/0123456789abcdef01234567/../../cards.db"} {
		result := httptest.NewRecorder()
		ui.ServeHTTP(result, httptest.NewRequest(http.MethodGet, path, nil))
		if result.Code != 404 || strings.Contains(result.Body.String(), "Standalone frontend") || strings.Contains(result.Body.String(), "private database") {
			t.Fatalf("unrecognized path served as frontend: %s / %d", path, result.Code)
		}
	}
	asset := httptest.NewRecorder()
	ui.ServeHTTP(asset, httptest.NewRequest(http.MethodGet, "/ui/0123456789abcdef01234567/app.js", nil))
	if asset.Code != 200 || !strings.Contains(asset.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("versioned asset cache policy missing: %d", asset.Code)
	}
	head := httptest.NewRecorder()
	ui.ServeHTTP(head, httptest.NewRequest(http.MethodHead, "/redeem", nil))
	if head.Code != 200 || head.Body.Len() != 0 {
		t.Fatal("HEAD must not send HTML or cause an action")
	}
	post := httptest.NewRecorder()
	ui.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/redeem", nil))
	if post.Code != 405 {
		t.Fatal("frontend documents only accept GET/HEAD")
	}
}
