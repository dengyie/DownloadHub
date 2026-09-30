package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode"
)

const openListResponseLimit = 1 << 20

// OLError classifies upstream failures without retaining response bodies,
// credentials, resource paths, or signed URLs.
type OLError struct {
	Operation  string
	Kind       string
	HTTPStatus int
	APICode    int
}

func (e *OLError) Error() string {
	return fmt.Sprintf("openlist %s: %s (http=%d api=%d)", e.Operation, e.Kind, e.HTTPStatus, e.APICode)
}

type olToken struct {
	value      string
	generation uint64
}
type olRefresh struct {
	done chan struct{}
	err  error
}

// OLClient is safe for concurrent requests. Configure HTTP before first use.
type OLClient struct {
	baseURL  string
	username string
	password string
	HTTP     *http.Client
	mu       sync.Mutex
	token    olToken
	tokenExp time.Time
	refresh  *olRefresh
}

func NewOLClient(base, user, pass string) *OLClient {
	return &OLClient{baseURL: strings.TrimRight(base, "/"), username: user, password: pass,
		HTTP: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (c *OLClient) ensureToken(ctx context.Context) (olToken, error) {
	for {
		if err := ctx.Err(); err != nil {
			return olToken{}, err
		}
		c.mu.Lock()
		if c.token.value != "" && time.Now().Before(c.tokenExp) {
			token := c.token
			c.mu.Unlock()
			return token, nil
		}
		if pending := c.refresh; pending != nil {
			c.mu.Unlock()
			select {
			case <-ctx.Done():
				return olToken{}, ctx.Err()
			case <-pending.done:
			}
			// A canceled leader must not make an unrelated live caller fail.
			if pending.err != nil && !errors.Is(pending.err, context.Canceled) && !errors.Is(pending.err, context.DeadlineExceeded) {
				return olToken{}, pending.err
			}
			continue
		}
		pending := &olRefresh{done: make(chan struct{})}
		c.refresh = pending
		c.mu.Unlock()
		value, err := c.login(ctx)
		c.mu.Lock()
		if err == nil {
			c.token = olToken{value: value, generation: c.token.generation + 1}
			c.tokenExp = time.Now().Add(40 * time.Hour)
		}
		token := c.token
		pending.err = err
		c.refresh = nil
		close(pending.done)
		c.mu.Unlock()
		return token, err
	}
}

func (c *OLClient) login(ctx context.Context) (string, error) {
	var out struct {
		Token string `json:"token"`
	}
	if err := c.call(ctx, "login", "/api/auth/login", "", map[string]string{"username": c.username, "password": c.password}, &out); err != nil {
		return "", err
	}
	if out.Token == "" {
		return "", &OLError{Operation: "login", Kind: "empty token"}
	}
	return out.Token, nil
}

// GetRawURL retries authentication once, sharing the caller's total deadline.
func (c *OLClient) GetRawURL(ctx context.Context, path, password string) (string, error) {
	for attempt := 0; attempt < 2; attempt++ {
		token, err := c.ensureToken(ctx)
		if err != nil {
			return "", err
		}
		var out struct {
			RawURL string `json:"raw_url"`
		}
		err = c.call(ctx, "fs/get", "/api/fs/get", token.value, map[string]string{"path": path, "password": password}, &out)
		var upstream *OLError
		if attempt == 0 && errors.As(err, &upstream) && (upstream.HTTPStatus == 401 || upstream.APICode == 401) {
			c.mu.Lock()
			if c.token.generation == token.generation {
				c.token.value = ""
			}
			c.mu.Unlock()
			continue
		}
		if err != nil {
			return "", err
		}
		if out.RawURL == "" {
			return "", &OLError{Operation: "fs/get", Kind: "empty raw_url"}
		}
		if err := validateRawURL(out.RawURL); err != nil {
			return "", err
		}
		return out.RawURL, nil
	}
	return "", &OLError{Operation: "fs/get", Kind: "authentication failed"}
}

func (c *OLClient) call(ctx context.Context, operation, endpoint, token string, payload map[string]string, data any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return &OLError{Operation: operation, Kind: "encode request"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+endpoint, bytes.NewReader(body))
	if err != nil {
		return &OLError{Operation: operation, Kind: "invalid endpoint"}
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &OLError{Operation: operation, Kind: "transport"}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &OLError{Operation: operation, Kind: "http status", HTTPStatus: resp.StatusCode}
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, openListResponseLimit+1))
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &OLError{Operation: operation, Kind: "read response"}
	}
	if len(raw) > openListResponseLimit {
		return &OLError{Operation: operation, Kind: "response too large"}
	}
	var envelope struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return &OLError{Operation: operation, Kind: "invalid json"}
	}
	if envelope.Code != 200 {
		return &OLError{Operation: operation, Kind: "api status", HTTPStatus: resp.StatusCode, APICode: envelope.Code}
	}
	if err := json.Unmarshal(envelope.Data, data); err != nil {
		return &OLError{Operation: operation, Kind: "invalid data"}
	}
	return nil
}

func validateRawURL(raw string) error {
	invalid := func() error { return &OLError{Operation: "fs/get", Kind: "invalid raw_url"} }
	if strings.TrimSpace(raw) != raw || strings.IndexFunc(raw, func(r rune) bool { return r <= 32 || r == '\\' }) >= 0 {
		return invalid()
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Fragment != "" || strings.Contains(u.Path, "\\") || (u != nil && strings.IndexFunc(u.Path, unicode.IsControl) >= 0) {
		return invalid()
	}
	if u.IsAbs() {
		if (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
			return invalid()
		}
		return nil
	}
	if u.Host != "" || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") {
		return invalid()
	}
	return nil
}
