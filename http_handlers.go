package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type handler struct {
	db                 *sql.DB
	service            *redemptionService
	ratelimit          *rateLimiter
	once               sync.Once
	trusted            []netip.Prefix
	public             []string
	requests, failures atomic.Uint64
}

func newHandler(db *sql.DB, ol olClient, cfg Config) *handler {
	h := &handler{db: db, ratelimit: newRateLimiter(), public: cfg.PublicPrefixes}
	for _, s := range cfg.TrustedProxyCIDRs {
		p, err := netip.ParsePrefix(s)
		if err == nil {
			h.trusted = append(h.trusted, p)
		}
	}
	h.service = &redemptionService{store: &grantStore{db}, backend: ol, budget: 8 * time.Second, window: time.Duration(cfg.GrantWindowSeconds) * time.Second, minURLTTL: time.Duration(cfg.MinURLTTLSeconds) * time.Second, allowedHosts: cfg.DownloadHosts}
	return h
}
func (h *handler) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", h.handleHealth)
	mux.HandleFunc("/ready", h.handleReady)
	mux.HandleFunc("/brand/", h.handleBrandAsset)
	mux.HandleFunc("/redeem", h.handleRedeemPage)
	mux.HandleFunc("/dl/", h.handleDownload)
	mux.HandleFunc("/api/redeem", h.handleRedeemAPI)
	mux.HandleFunc("/api/grants", h.handleGrants)
	assets, _ := fs.Sub(webAssets, "web")
	assetHandler := http.StripPrefix("/assets/", http.FileServer(http.FS(assets)))
	mux.Handle("/assets/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		assetHandler.ServeHTTP(w, r)
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.requests.Add(1)
		id, err := randomSecret(12)
		if err != nil {
			http.Error(w, "request unavailable", 503)
			return
		}
		w.Header().Set("X-Request-ID", id)
		h.securityHeaders(w)
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		mux.ServeHTTP(w, r.WithContext(ctx))
	})
}
func (h *handler) securityHeaders(w http.ResponseWriter) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
}
func (h *handler) limited(r *http.Request, limit int) bool {
	h.once.Do(func() {
		if h.ratelimit == nil {
			h.ratelimit = newRateLimiter()
		}
	})
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err == nil {
		for _, prefix := range h.trusted {
			if prefix.Contains(peer.Unmap()) {
				if ip, e := netip.ParseAddr(r.Header.Get("X-Real-IP")); e == nil {
					host = ip.Unmap().String()
				}
				break
			}
		}
	}
	return h.ratelimit.allow(r.URL.Path+":"+host, limit, time.Minute)
}
func (h *handler) respond(w http.ResponseWriter, status int, v any) {
	h.securityHeaders(w)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Warn("response interrupted", "request_id", w.Header().Get("X-Request-ID"))
	}
}
func (h *handler) fail(w http.ResponseWriter, err error) {
	h.failures.Add(1)
	status, code, msg := 500, "internal", "服务暂时不可用，请用同一凭证重试"
	switch {
	case errors.Is(err, ErrGrantLimit):
		status, code, msg = 429, "grant_limit", ErrGrantLimit.Error()
		w.Header().Set("Retry-After", "60")
	case errors.Is(err, ErrInvalid):
		status, code, msg = 400, "invalid_request", ErrInvalid.Error()
	case errors.Is(err, ErrDenied):
		status, code, msg = 403, "denied", ErrDenied.Error()
	case errors.Is(err, ErrExpired):
		status, code, msg = 410, "expired", ErrExpired.Error()
	case errors.Is(err, ErrQuota):
		status, code, msg = 403, "quota_exhausted", ErrQuota.Error()
	case errors.Is(err, ErrBusy):
		status, code, msg = 409, "processing", ErrBusy.Error()
		w.Header().Set("Retry-After", "1")
	case errors.Is(err, context.DeadlineExceeded):
		status, code, msg = 504, "timeout", "处理超时，请用同一凭证重试"
	case errors.Is(err, context.Canceled):
		status, code, msg = 408, "cancelled", "请求已取消，请用同一凭证重试"
	case errors.Is(err, ErrBackend):
		status, code, msg = 502, "backend_unavailable", ErrBackend.Error()
	}
	slog.Warn("request failed", "request_id", w.Header().Get("X-Request-ID"), "error_code", code)
	h.respond(w, status, map[string]any{"code": status, "error": code, "msg": msg})
}
func (h *handler) post(w http.ResponseWriter, r *http.Request, limit int) bool {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		h.respond(w, 405, map[string]any{"code": 405, "msg": "请通过页面确认操作"})
		return false
	}
	if !h.limited(r, limit) {
		w.Header().Set("Retry-After", "60")
		h.respond(w, 429, map[string]any{"code": 429, "msg": "请求过于频繁，请稍后重试"})
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	if err := r.ParseForm(); err != nil {
		h.fail(w, ErrInvalid)
		return false
	}
	return true
}
func (h *handler) handleRedeemAPI(w http.ResponseWriter, r *http.Request) {
	if !h.post(w, r, 20) {
		return
	}
	id, key := strings.TrimSpace(r.PostForm.Get("card")), strings.TrimSpace(r.PostForm.Get("key"))
	if id == "" || key == "" || len(id) > 128 || len(key) > 256 {
		h.fail(w, ErrInvalid)
		return
	}
	card, err := verifyCardContext(r.Context(), h.db, id, key)
	if err != nil {
		h.fail(w, err)
		return
	}
	resources := card.Resources
	if len(resources) == 0 {
		if p := r.PostForm.Get("resource"); p != "" {
			resources = []string{p}
		}
	}
	for _, p := range resources {
		if h.isPublic(p) {
			h.respond(w, 409, map[string]any{"code": 409, "error": "public_resource", "msg": "该资源位于公开目录，不应消耗卡密，请联系管理员确认资源地址"})
			return
		}
	}
	items, err := h.service.store.create(r.Context(), card, resources, 10*time.Minute)
	if err != nil {
		h.fail(w, err)
		return
	}
	h.respond(w, 200, map[string]any{"code": 200, "msg": "ok", "quota": card.Quota, "resources": items})
}
func (h *handler) isPublic(resource string) bool {
	resource = normalizeResource(resource)
	for _, prefix := range h.public {
		if strings.HasPrefix(resource, prefix) || resource == strings.TrimSuffix(prefix, "/") {
			return true
		}
	}
	return false
}
func (h *handler) handleGrants(w http.ResponseWriter, r *http.Request) {
	if !h.post(w, r, 120) {
		return
	}
	key := r.PostForm.Get("credential")
	if len(key) != 64 {
		h.fail(w, ErrInvalid)
		return
	}
	// Applies to migrated credentials as well as newly created ones.
	var resource string
	err := h.db.QueryRowContext(r.Context(), `SELECT resource FROM grants WHERE credential_hash=?`, secretHash(key)).Scan(&resource)
	if err == sql.ErrNoRows {
		h.fail(w, ErrDenied)
		return
	}
	if err != nil {
		h.fail(w, err)
		return
	}
	if h.isPublic(resource) {
		h.respond(w, 409, map[string]any{"code": 409, "msg": "公开资源不消耗卡密，请联系管理员确认资源地址"})
		return
	}
	start := time.Now()
	g, err := h.service.issue(r.Context(), key)
	if err != nil {
		h.fail(w, err)
		return
	}
	slog.Info("grant issued or recovered", "request_id", w.Header().Get("X-Request-ID"), "grant_id", g.ID, "elapsed_ms", time.Since(start).Milliseconds())
	h.respond(w, 200, map[string]any{"code": 200, "url": g.URL, "expires_at": g.ExpiresAt, "grant_id": g.ID, "quota": g.Quota})
}
func (h *handler) handleDownload(w http.ResponseWriter, r *http.Request) {
	if err := validateResourcePath(strings.TrimPrefix(r.URL.Path, "/dl/")); err != nil {
		h.fail(w, err)
		return
	}
	// Old links remain usable as an explicit confirmation page, never a GET charge.
	h.handleRedeemPage(w, r)
}
func (h *handler) handleRedeemPage(w http.ResponseWriter, r *http.Request) {
	h.securityHeaders(w)
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", 405)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if r.Method == http.MethodGet {
		fmt.Fprint(w, redeemHTML)
	}
}
func (h *handler) handleHealth(w http.ResponseWriter, r *http.Request) {
	h.respond(w, 200, map[string]any{"status": "ok", "version": version})
}
func (h *handler) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), time.Second)
	defer cancel()
	if err := h.db.PingContext(ctx); err != nil {
		h.respond(w, 503, map[string]any{"status": "unavailable"})
		return
	}
	h.respond(w, 200, map[string]any{"status": "ready", "schema": schemaVersion, "requests": h.requests.Load(), "failures": h.failures.Load(), "backend": "checked_on_demand"})
}
func (h *handler) handleBrandAsset(w http.ResponseWriter, r *http.Request) {
	h.securityHeaders(w)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	switch strings.TrimPrefix(r.URL.Path, "/brand/") {
	case "logo.png":
		w.Header().Set("Content-Type", "image/png")
		w.Write(brandLogoPNG)
	case "favicon.ico":
		w.Header().Set("Content-Type", "image/x-icon")
		w.Write(brandFaviconICO)
	case "apple-touch-icon.png":
		w.Header().Set("Content-Type", "image/png")
		w.Write(brandAppleTouchPNG)
	default:
		http.NotFound(w, r)
	}
}
func DownloadPathWithToken(resource, token string) string {
	parts := strings.Split(normalizeResource(resource), "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return "/dl/" + strings.Join(parts, "/") + "?token=" + url.QueryEscape(token)
}
func filepathBase(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}
