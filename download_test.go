package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type fakeOL struct {
	get func(context.Context, string) (string, error)
}

func (f *fakeOL) GetRawURL(ctx context.Context, path, password string) (string, error) {
	if f.get != nil {
		return f.get(ctx, path)
	}
	return "https://files.example" + path, nil
}
func testHandler(t *testing.T) (*handler, *Card) {
	t.Helper()
	db := newTestDB(t)
	c, e := CreateCard(db, 2, "member", nil, []string{"private/a%20b.zip"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	cfg := defaultConfig()
	cfg.MinURLTTLSeconds = 600
	cfg.DownloadHosts = []string{"files.example"}
	return newHandler(db, &fakeOL{}, cfg), c
}
func postForm(h http.Handler, path string, values url.Values) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", path, strings.NewReader(values.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func redeemCredential(t *testing.T, h *handler, c *Card) string {
	t.Helper()
	w := postForm(h.routes(), "/api/redeem", url.Values{"card": {c.CardID}, "key": {c.Secret}})
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var out struct{ Resources []resourceItem }
	if e := json.Unmarshal(w.Body.Bytes(), &out); e != nil {
		t.Fatal(e)
	}
	if len(out.Resources) != 1 {
		t.Fatal(out)
	}
	return out.Resources[0].Credential
}
func TestHTTPGrantLifecycle(t *testing.T) {
	h, c := testHandler(t)
	key := redeemCredential(t, h, c)
	w := postForm(h.routes(), "/api/grants", url.Values{"credential": {key}})
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var first map[string]any
	json.Unmarshal(w.Body.Bytes(), &first)
	if first["quota"] != float64(1) || !strings.Contains(first["url"].(string), "a%20b.zip") {
		t.Fatal(first)
	}
	again := postForm(h.routes(), "/api/grants", url.Values{"credential": {key}})
	var second map[string]any
	json.Unmarshal(again.Body.Bytes(), &second)
	if first["grant_id"] != second["grant_id"] || second["quota"] != float64(1) {
		t.Fatal(second)
	}
	if again.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("cached secret")
	}
	RevokeCard(h.db, c.CardID)
	if w = postForm(h.routes(), "/api/grants", url.Values{"credential": {key}}); w.Code != 403 {
		t.Fatal(w.Code)
	}
}
func TestDownloadGETAndHEADNeverCharge(t *testing.T) {
	h, c := testHandler(t)
	key := redeemCredential(t, h, c)
	for _, method := range []string{"GET", "HEAD"} {
		w := httptest.NewRecorder()
		h.routes().ServeHTTP(w, httptest.NewRequest(method, DownloadPathWithToken("private/a%20b.zip", key), nil))
		if w.Code != 200 {
			t.Fatal(w.Code)
		}
		got, _ := loadCard(h.db, c.CardID)
		if got.Quota != 2 {
			t.Fatal("GET consumed")
		}
	}
}
func TestGrantBackendFailureReleases(t *testing.T) {
	h, c := testHandler(t)
	key := redeemCredential(t, h, c)
	h.service.backend = &fakeOL{get: func(context.Context, string) (string, error) { return "", errors.New("secret backend payload") }}
	w := postForm(h.routes(), "/api/grants", url.Values{"credential": {key}})
	if w.Code != 502 || strings.Contains(w.Body.String(), "secret") {
		t.Fatal(w.Code, w.Body.String())
	}
	h.service.backend = &fakeOL{}
	if w = postForm(h.routes(), "/api/grants", url.Values{"credential": {key}}); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestGrantDeadlineNoChargeAndRetry(t *testing.T) {
	h, c := testHandler(t)
	key := redeemCredential(t, h, c)
	h.service.budget = 20 * time.Millisecond
	h.service.backend = &fakeOL{get: func(ctx context.Context, _ string) (string, error) {
		<-ctx.Done()
		return "https://files.example/a", nil
	}}
	w := postForm(h.routes(), "/api/grants", url.Values{"credential": {key}})
	if w.Code != 504 {
		t.Fatal(w.Code, w.Body.String())
	}
	got, _ := loadCard(h.db, c.CardID)
	if got.Quota != 2 {
		t.Fatal(got.Quota)
	}
	h.service.backend = &fakeOL{}
	if w = postForm(h.routes(), "/api/grants", url.Values{"credential": {key}}); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestGrantCancellationNoCharge(t *testing.T) {
	h, c := testHandler(t)
	key := redeemCredential(t, h, c)
	ctx, cancel := context.WithCancel(context.Background())
	h.service.backend = &fakeOL{get: func(context.Context, string) (string, error) { cancel(); return "https://files.example/a", nil }}
	if _, err := h.service.issue(ctx, key); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	got, _ := loadCard(h.db, c.CardID)
	if got.Quota != 2 {
		t.Fatal(got.Quota)
	}
}
func TestPublicResourceRefusesCharge(t *testing.T) {
	h, _ := testHandler(t)
	c, e := CreateCard(h.db, 2, "member", nil, []string{"pub/manual.txt"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	w := postForm(h.routes(), "/api/redeem", url.Values{"card": {c.CardID}, "key": {c.Secret}})
	if w.Code != 409 {
		t.Fatal(w.Code)
	}
	items, _ := h.service.store.create(context.Background(), c, c.Resources, time.Minute)
	w = postForm(h.routes(), "/api/grants", url.Values{"credential": {items[0].Credential}})
	if w.Code != 409 {
		t.Fatal(w.Code)
	}
}
func TestPrefixCardExplicitResource(t *testing.T) {
	h, _ := testHandler(t)
	c, e := CreateCard(h.db, 2, "member", []string{"/private/"}, nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	for _, p := range []string{"private/a", "exclusive/a"} {
		w := postForm(h.routes(), "/api/redeem", url.Values{"card": {c.CardID}, "key": {c.Secret}, "resource": {p}})
		want := 200
		if p == "exclusive/a" {
			want = 403
		}
		if w.Code != want {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}
func TestRedeemRejectsBodyOverflowAndQueryCredentials(t *testing.T) {
	h, c := testHandler(t)
	w := postForm(h.routes(), "/api/redeem?card="+c.CardID+"&key="+c.Secret, url.Values{})
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
	w = postForm(h.routes(), "/api/redeem", url.Values{"card": {strings.Repeat("x", 9000)}, "key": {"k"}})
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
}
func TestPathValidationRoundTrip(t *testing.T) {
	for _, p := range []string{"private/中文.zip", "private/a b.zip", "private/a%20b.zip", "private/a%2Fb.zip"} {
		r := httptest.NewRequest("GET", DownloadPathWithToken(p, "t"), nil)
		if got := strings.TrimPrefix(r.URL.Path, "/dl/"); got != p {
			t.Fatal(got, p)
		}
	}
	for _, p := range []string{"a/../b", "a/./b", "a//b", "a\\b", "/", "a\x00b"} {
		if validateResourcePath(p) == nil {
			t.Fatal(p)
		}
	}
}
