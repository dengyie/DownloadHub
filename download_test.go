package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestNormalizeResource 边界路径规范化
func TestNormalizeResource(t *testing.T) {
	cases := []struct{ in, want string }{
		{"pub/a.zip", "pub/a.zip"},
		{"/pub/a.zip", "pub/a.zip"},
		{"pub/a.zip/", "pub/a.zip"},
		{"/pub/a.zip/", "pub/a.zip"},
		{"  pub/a.zip  ", "pub/a.zip"},
		{"pub", "pub"},
		{"/pub/", "pub"},
	}
	for _, c := range cases {
		if got := normalizeResource(c.in); got != c.want {
			t.Errorf("normalizeResource(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// fakeOL 实现 olClient 接口, 返回固定直链用于 handler 测试
type fakeOL struct{}

func (f *fakeOL) GetRawURL(path, password string) (string, error) {
	return "https://dl.example.com" + path, nil
}

func (f *fakeOL) ensureToken() error { return nil }

// TestHandleDownloadResourceBound: 资源绑定卡的下载精确鉴权
func TestHandleDownloadResourceBound(t *testing.T) {
	db := newTestDB(t)
	c, _ := CreateCard(db, 5, "member", nil, []string{"pub/a.zip"}, nil)
	h := &handler{db: db, ol: &fakeOL{}}

	req, _ := http.NewRequest("GET", "/dl/pub/a.zip?card="+c.CardID+"&key="+c.Secret, nil)
	w := httptest.NewRecorder()
	h.handleDownload(w, req)
	if w.Code != http.StatusFound {
		t.Fatalf("resource-bound download: got %d, want 302 (body=%s)", w.Code, w.Body.String())
	}
	loc := w.Header().Get("Location")
	if !strings.Contains(loc, "/pub/a.zip") {
		t.Fatalf("redirect Location=%q, want contains /pub/a.zip", loc)
	}

	// 未绑定资源应 403
	req2, _ := http.NewRequest("GET", "/dl/pub/b.zip?card="+c.CardID+"&key="+c.Secret, nil)
	w2 := httptest.NewRecorder()
	h.handleDownload(w2, req2)
	if w2.Code != http.StatusForbidden {
		t.Fatalf("unbound resource: got %d, want 403", w2.Code)
	}
}

// TestHandleDownloadPrefixCompatible: 前缀卡的旧模式下载鉴权
func TestHandleDownloadPrefixCompatible(t *testing.T) {
	db := newTestDB(t)
	c, _ := CreateCard(db, 3, "guest", []string{"/pub/"}, nil, nil)
	h := &handler{db: db, ol: &fakeOL{}}

	req, _ := http.NewRequest("GET", "/dl/pub/anything.txt?card="+c.CardID+"&key="+c.Secret, nil)
	w := httptest.NewRecorder()
	h.handleDownload(w, req)
	if w.Code != http.StatusFound {
		t.Fatalf("prefix download: got %d, want 302", w.Code)
	}

	// 前缀外(exclusive)应 403
	req2, _ := http.NewRequest("GET", "/dl/exclusive/secret.bin?card="+c.CardID+"&key="+c.Secret, nil)
	w2 := httptest.NewRecorder()
	h.handleDownload(w2, req2)
	if w2.Code != http.StatusForbidden {
		t.Fatalf("prefix-denied: got %d, want 403", w2.Code)
	}
}

// TestHandleDownloadWrongKey: 错误密钥 403
func TestHandleDownloadWrongKey(t *testing.T) {
	db := newTestDB(t)
	c, _ := CreateCard(db, 1, "guest", []string{"/pub/"}, nil, nil)
	h := &handler{db: db, ol: &fakeOL{}}
	req, _ := http.NewRequest("GET", "/dl/pub/a.txt?card="+c.CardID+"&key=wrong", nil)
	w := httptest.NewRecorder()
	h.handleDownload(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("wrong key: got %d, want 403", w.Code)
	}
}

// TestHandleDownloadQuotaLimit: 次数用尽后 403
func TestHandleDownloadQuotaLimit(t *testing.T) {
	db := newTestDB(t)
	c, _ := CreateCard(db, 1, "guest", []string{"/pub/"}, nil, nil)
	h := &handler{db: db, ol: &fakeOL{}}
	// 第1次成功
	r1, _ := http.NewRequest("GET", "/dl/pub/a.txt?card="+c.CardID+"&key="+c.Secret, nil)
	w1 := httptest.NewRecorder()
	h.handleDownload(w1, r1)
	if w1.Code != http.StatusFound {
		t.Fatalf("first consume: got %d, want 302", w1.Code)
	}
	// 第2次(次数耗尽)403
	r2, _ := http.NewRequest("GET", "/dl/pub/a.txt?card="+c.CardID+"&key="+c.Secret, nil)
	w2 := httptest.NewRecorder()
	h.handleDownload(w2, r2)
	if w2.Code != http.StatusForbidden {
		t.Fatalf("quota exhausted: got %d, want 403", w2.Code)
	}
}

// TestHandleRedeemAPI: 兑换 API 返回资源列表
func TestHandleRedeemAPI(t *testing.T) {
	db := newTestDB(t)
	c, _ := CreateCard(db, 3, "member", nil, []string{"pub/a.zip", "pub/b.txt"}, nil)
	h := &handler{db: db, ol: &fakeOL{}}

	body := "card=" + c.CardID + "&key=" + c.Secret
	req, _ := http.NewRequest("POST", "/api/redeem", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	h.handleRedeemAPI(w, req)

	if w.Code != 200 {
		t.Fatalf("redeem api: got %d, want 200", w.Code)
	}
	var resp struct {
		Code      int
		Msg       string
		Quota     int
		Resources []struct {
			Name string
			Path string
		}
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Code != 200 || resp.Quota != 3 {
		t.Fatalf("code=%d quota=%d", resp.Code, resp.Quota)
	}
	if len(resp.Resources) != 2 {
		t.Fatalf("resource count=%d, want 2", len(resp.Resources))
	}
	if resp.Resources[0].Name != "a.zip" {
		t.Fatalf("resource name=%q, want a.zip", resp.Resources[0].Name)
	}
}

// TestHandleRedeemAPIBadKey: 错误密钥返回值校验
func TestHandleRedeemAPIBadKey(t *testing.T) {
	db := newTestDB(t)
	c, _ := CreateCard(db, 1, "guest", []string{"/pub/"}, nil, nil)
	h := &handler{db: db, ol: &fakeOL{}}
	req, _ := http.NewRequest("POST", "/api/redeem", strings.NewReader("card="+c.CardID+"&key=wrong"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	h.handleRedeemAPI(w, req)
	if w.Code != 403 {
		t.Fatalf("bad key: got %d, want 403", w.Code)
	}
}
