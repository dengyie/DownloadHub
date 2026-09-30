package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// mockOpenList 模拟 OpenList 的登录 + fs/get 端点
func mockOpenList(tokenValue, rawURLValue string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/login":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"code":200,"message":"success","data":{"token":"` + tokenValue + `"}}`))
		case "/api/fs/get":
			// 若带了 Authorization 头才返回 raw_url
			if r.Header.Get("Authorization") == "" {
				w.WriteHeader(401)
				w.Write([]byte(`{"code":401,"message":"no auth","data":null}`))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"code":200,"message":"success","data":{"raw_url":"` + rawURLValue + `"}}`))
		default:
			w.WriteHeader(404)
		}
	}))
}

func TestOLLogin(t *testing.T) {
	srv := mockOpenList("tok-abc", "http://x/p/a.txt?sign=1")
	defer srv.Close()
	c := NewOLClient(srv.URL, "admin", "pw")
	if _, err := c.ensureToken(context.Background()); err != nil {
		t.Fatalf("login: %v", err)
	}
	if c.token.value != "tok-abc" {
		t.Fatalf("token = %q", c.token.value)
	}
}

func TestGetRawURL(t *testing.T) {
	srv := mockOpenList("tok-1", "http://x/p/file.bin?sign=sig123")
	defer srv.Close()
	c := NewOLClient(srv.URL, "admin", "pw")
	raw, err := c.GetRawURL(context.Background(), "/pub/file.bin", "")
	if err != nil {
		t.Fatalf("GetRawURL: %v", err)
	}
	if raw != "http://x/p/file.bin?sign=sig123" {
		t.Fatalf("raw_url = %q", raw)
	}
	// 应自动带上了 auth
}

func TestGetRawURLAuthHeaderSent(t *testing.T) {
	var sawAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/login" {
			w.Write([]byte(`{"code":200,"data":{"token":"tokX"}}`))
			return
		}
		sawAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"code":200,"data":{"raw_url":"/p/a"}}`))
	}))
	defer srv.Close()
	c := NewOLClient(srv.URL, "admin", "pw")
	if _, err := c.GetRawURL(context.Background(), "/x", ""); err != nil {
		t.Fatalf("err %v", err)
	}
	if !strings.Contains(sawAuth, "tokX") {
		t.Fatalf("auth header = %q, want contain tokX", sawAuth)
	}
}

func TestGetRawURLFolder(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/auth/login" {
			w.Write([]byte(`{"code":200,"data":{"token":"t"}}`))
			return
		}
		w.Write([]byte(`{"code":200,"data":{"raw_url":""}}`)) // 空 = 是目录或无文件
	}))
	defer srv.Close()
	c := NewOLClient(srv.URL, "admin", "pw")
	if _, err := c.GetRawURL(context.Background(), "/dir", ""); err == nil {
		t.Fatal("expected error for empty raw_url (folder)")
	} else if !strings.Contains(err.Error(), "empty raw_url") {
		t.Fatalf("unexpected err: %v", err)
	}
}

// TestGetRawURLTokenInvalidated 验证: fs/get 返回 token invalidated 时,自动重新登录并重试成功
func TestGetRawURLTokenInvalidated(t *testing.T) {
	loginCount := 0
	fsCalls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/login":
			loginCount++
			// 第二次登录返回新 token
			tok := "tok-1"
			if loginCount >= 2 {
				tok = "tok-renewed"
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"code":200,"data":{"token":"` + tok + `"}}`))
		case "/api/fs/get":
			fsCalls++
			if r.Header.Get("Authorization") == "tok-1" {
				// 模拟 token 已被服务端作废
				w.WriteHeader(401)
				w.Write([]byte(`{"code":401,"message":"token is invalidated","data":null}`))
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"code":200,"data":{"raw_url":"http://x/p/f.bin?sign=ok"}}`))
		}
	}))
	defer srv.Close()
	c := NewOLClient(srv.URL, "admin", "pw")
	raw, err := c.GetRawURL(context.Background(), "/pub/f.bin", "")
	if err != nil {
		t.Fatalf("GetRawURL: %v", err)
	}
	if raw != "http://x/p/f.bin?sign=ok" {
		t.Fatalf("raw_url = %q", raw)
	}
	if loginCount < 2 {
		t.Fatalf("expected re-login on token invalidated, loginCount=%d", loginCount)
	}
	if fsCalls < 2 {
		t.Fatalf("expected retry fs/get, fsCalls=%d", fsCalls)
	}
}
