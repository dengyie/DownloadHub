package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// OLClient OpenList API 客户端,管理登录 token 自动续
type OLClient struct {
	BaseURL  string // 如 http://127.0.0.1:5244
	Username string
	Password string
	Token    string
	TokenExp time.Time
	HTTP     *http.Client
}

func NewOLClient(base, user, pass string) *OLClient {
	return &OLClient{
		BaseURL: base, Username: user, Password: pass,
		HTTP: &http.Client{Timeout: 30 * time.Second},
	}
}

// login 登录拿 token(由 ensureToken 调用)
func (c *OLClient) login() error {
	body, _ := json.Marshal(map[string]string{"username": c.Username, "password": c.Password})
	req, err := http.NewRequest("POST", c.BaseURL+"/api/auth/login", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out struct {
		Code int `json:"code"`
		Data struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return fmt.Errorf("login parse: %w: %s", err, raw)
	}
	if out.Code != 200 || out.Data.Token == "" {
		return fmt.Errorf("login failed code=%d: %s", out.Code, raw)
	}
	c.Token = out.Data.Token
	c.TokenExp = time.Now().Add(40 * time.Hour) // 提前续,config 默认 48h
	return nil
}

// ensureToken 确保 token 有效
func (c *OLClient) ensureToken() error {
	if c.Token != "" && time.Now().Before(c.TokenExp) {
		return nil
	}
	return c.login()
}

// GetRawURL 调 /api/fs/get 拿文件签名直链(raw_url)
func (c *OLClient) GetRawURL(path, password string) (string, error) {
	url, err := c.getRawURLOnce(path, password)
	if err != nil && (isInvalToken(err) || strings.Contains(err.Error(), "401")) {
		// token 可能被服务端作废(如 OpenList 重启),重新登录重试一次
		c.Token = "" // 强制重登
		if lerr := c.ensureToken(); lerr != nil {
			return "", lerr
		}
		return c.getRawURLOnce(path, password)
	}
	return url, err
}

func isInvalToken(err error) bool {
	es := err.Error()
	return strings.Contains(es, "token is invalidated") ||
		strings.Contains(es, "invalid token") ||
		strings.Contains(es, "401")
}

func (c *OLClient) getRawURLOnce(path, password string) (string, error) {
	if err := c.ensureToken(); err != nil {
		return "", err
	}
	payload, _ := json.Marshal(map[string]string{"path": path, "password": password})
	req, err := http.NewRequest("POST", c.BaseURL+"/api/fs/get", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", c.Token)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out struct {
		Code int `json:"code"`
		Data struct {
			RawURL string `json:"raw_url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("fs/get parse: %w: %s", err, raw)
	}
	if out.Code != 200 {
		return "", fmt.Errorf("fs/get failed code=%d: %s", out.Code, raw)
	}
	if out.Data.RawURL == "" {
		return "", fmt.Errorf("fs/get empty raw_url for %s (is it a folder?)", path)
	}
	return out.Data.RawURL, nil
}
