package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestOLConcurrentRefresh(t *testing.T) {
	var logins atomic.Int32
	entered := make(chan struct{})
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/login" {
			if logins.Add(1) == 1 {
				close(entered)
			}
			<-release
			w.Write([]byte(`{"code":200,"data":{"token":"shared"}}`))
			return
		}
		w.Write([]byte(`{"code":200,"data":{"raw_url":"https://files.example/a"}}`))
	}))
	defer srv.Close()
	c := NewOLClient(srv.URL, "admin", "secret")
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.GetRawURL(context.Background(), "/a", ""); err != nil {
				t.Error(err)
			}
		}()
	}
	<-entered
	close(release)
	wg.Wait()
	if got := logins.Load(); got != 1 {
		t.Fatalf("login calls=%d, want 1", got)
	}
}

func TestOLWaiterCancellation(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		w.Write([]byte(`{"code":200,"data":{"token":"t"}}`))
	}))
	defer srv.Close()
	c := NewOLClient(srv.URL, "u", "p")
	leader := make(chan error, 1)
	go func() { _, err := c.ensureToken(context.Background()); leader <- err }()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := c.ensureToken(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("waiter: %v", err)
	}
	close(release)
	if err := <-leader; err != nil {
		t.Fatal(err)
	}
}

func TestOLRequestCancellation(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/login" {
			w.Write([]byte(`{"code":200,"data":{"token":"t"}}`))
			return
		}
		close(entered)
		<-release
	}))
	defer srv.Close()
	c := NewOLClient(srv.URL, "u", "p")
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { _, err := c.GetRawURL(ctx, "/a", ""); result <- err }()
	<-entered
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("canceled request: %v", err)
		}
	case <-time.After(time.Second):
		t.Error("request did not cancel")
	}
	close(release)
}

func TestOLStale401DoesNotInvalidateRefresh(t *testing.T) {
	var logins atomic.Int32
	staleEntered, releaseStale := make(chan struct{}), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/login" {
			n := logins.Add(1)
			fmt.Fprintf(w, `{"code":200,"data":{"token":"t%d"}}`, n)
			return
		}
		var payload map[string]string
		json.NewDecoder(r.Body).Decode(&payload)
		if r.Header.Get("Authorization") == "t1" {
			if payload["path"] == "/slow" {
				close(staleEntered)
				<-releaseStale
			}
			w.WriteHeader(401)
			return
		}
		w.Write([]byte(`{"code":200,"data":{"raw_url":"/p/a"}}`))
	}))
	defer srv.Close()
	c := NewOLClient(srv.URL, "u", "p")
	result := make(chan error, 1)
	go func() { _, err := c.GetRawURL(context.Background(), "/slow", ""); result <- err }()
	<-staleEntered
	_, err := c.GetRawURL(context.Background(), "/fast", "")
	close(releaseStale)
	if err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if got := logins.Load(); got != 2 {
		t.Fatalf("login count=%d want 2", got)
	}
}

func TestOLResponseValidation(t *testing.T) {
	for _, tc := range []struct {
		name, body, kind string
		status, api      int
	}{
		{"http", `{"code":200,"data":{"raw_url":"/secret"}}`, "http status", 503, 0},
		{"api", `{"code":403,"message":"SECRET"}`, "api status", 200, 403},
		{"malformed", `SECRET`, "invalid json", 200, 0},
		{"oversized", strings.Repeat("SECRET", openListResponseLimit/6+1), "response too large", 200, 0},
		{"invalid url", `{"code":200,"data":{"raw_url":"javascript:SECRET"}}`, "invalid raw_url", 200, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/auth/login" {
					w.Write([]byte(`{"code":200,"data":{"token":"secret-token"}}`))
					return
				}
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			c := NewOLClient(srv.URL, "u", "secret-password")
			_, err := c.GetRawURL(context.Background(), "/secret-path", "")
			var upstream *OLError
			if !errors.As(err, &upstream) || upstream.Kind != tc.kind || upstream.APICode != tc.api {
				t.Fatalf("got %v", err)
			}
			if strings.Contains(strings.ToLower(err.Error()), "secret") {
				t.Fatalf("secret in error: %v", err)
			}
		})
	}
}

type olRoundTripper func(*http.Request) (*http.Response, error)

func (f olRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type olBrokenReader struct{}

func (olBrokenReader) Read([]byte) (int, error) { return 0, errors.New("SECRET") }
func (olBrokenReader) Close() error             { return nil }

func TestOLReadAndTransportErrorsAreSanitized(t *testing.T) {
	for _, transport := range []olRoundTripper{
		func(*http.Request) (*http.Response, error) { return nil, errors.New("SECRET") },
		func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: olBrokenReader{}}, nil
		},
	} {
		c := NewOLClient("http://example.test", "u", "p")
		c.HTTP.Transport = transport
		_, err := c.GetRawURL(context.Background(), "/a", "")
		if err == nil || strings.Contains(err.Error(), "SECRET") {
			t.Fatalf("error: %v", err)
		}
	}
}

func TestOLRawURLSchemes(t *testing.T) {
	for _, raw := range []string{"https://example.test/p/a?sign=x", "http://example.test/p/a", "/p/a?sign=x", "/p/a%20b"} {
		if err := validateRawURL(raw); err != nil {
			t.Errorf("valid %q: %v", raw, err)
		}
	}
	for _, raw := range []string{"javascript:alert(1)", "//evil.test/p/a", "https://u:p@example.test/p/a", "relative", "/\\evil.test/a", "/p/a\nX: hi", "/p/%5csecret", " https://example.test/a", "https:///a"} {
		if err := validateRawURL(raw); err == nil {
			t.Errorf("accepted unsafe %q", raw)
		}
	}
}

func TestOLDoesNotFollowLoginRedirect(t *testing.T) {
	var reached atomic.Bool
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached.Store(true) }))
	defer destination.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer srv.Close()
	c := NewOLClient(srv.URL, "u", "secret-password")
	if _, err := c.GetRawURL(context.Background(), "/a", ""); err == nil {
		t.Fatal("accepted login redirect")
	}
	if reached.Load() {
		t.Fatal("followed login redirect with credentials")
	}
}

func TestRawURLCannotPassBackendAndFailBrowserWhitespaceRules(t *testing.T) {
	for _, raw := range []string{"https://files.example/a b", "https://files.example/a%00b", "/p/a\x00b"} {
		if err := validateRawURL(raw); err == nil {
			t.Errorf("unsafe raw URL accepted: %q", raw)
		}
	}
	if err := validateRawURL("https://files.example/a%20b"); err != nil {
		t.Fatal(err)
	}
}
