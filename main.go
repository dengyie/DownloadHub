package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Listen      string `yaml:"listen"`
	DBPath      string `yaml:"db_path"`
	OpenListURL string `yaml:"openlist_url"`
	OLAdminUser string `yaml:"openlist_admin_user"`
	OLAdminPass string `yaml:"openlist_admin_pass"`
}

func defaultConfig() Config {
	return Config{
		Listen:      "127.0.0.1:8080",
		DBPath:      "cards.db",
		OpenListURL: "http://127.0.0.1:5244",
	}
}

func loadConfig(path string) (Config, error) {
	cfg := defaultConfig()
	b, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if err := yaml.Unmarshal(b, &cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func main() {
	// 子命令: gencard / listcards / revokecard / serve
	args := os.Args[1:]
	if len(args) == 0 {
		printUsage()
		return
	}
	if args[0] == "serve" {
		// 网关服务: 需要解析 --config
		fs := flag.NewFlagSet("cardgw", flag.ExitOnError)
		var configPath string
		fs.StringVar(&configPath, "config", "/root/cardgw/config.yaml", "配置文件路径")
		_ = fs.Parse(args[1:])
		cfg, err := loadConfig(configPath)
		if err != nil {
			log.Fatalf("load config %s: %v", configPath, err)
		}
		runServer(cfg)
		return
	}

	// admin CLI 模式: 全部参数交给 RunGen 自己解析(它定义了所需 flag)
	RunGen(args, "")
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "用法:")
	fmt.Fprintln(os.Stderr, "  # 网关服务;  config 指向配置文件(设 listen/db_path/openlist 凭据)")
	fmt.Fprintln(os.Stderr, "  cardgw serve -config /root/cardgw/config.yaml")
	fmt.Fprintln(os.Stderr, "  # 绑资源卡(推荐): cardgw gencard --quota N --resource pub/a.zip,pub/b.txt [--days D]")
	fmt.Fprintln(os.Stderr, "  # 绑前缀卡(兼容): cardgw gencard --quota N --group g --prefix /pub/,/share/ [--days D]")
	fmt.Fprintln(os.Stderr, "  cardgw listcards")
	fmt.Fprintln(os.Stderr, "  cardgw revokecard --card <id>")
}

// runServer 启动 HTTP 网关
func runServer(cfg Config) {
	db, err := openDB(cfg.DBPath)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	ol := NewOLClient(cfg.OpenListURL, cfg.OLAdminUser, cfg.OLAdminPass)
	// 预热一次 token,失败先警告
	if err := ol.ensureToken(); err != nil {
		log.Printf("WARN OpenList 登录失败(启动后半分钟自动重试): %v", err)
	}

	gw := &handler{db: db, ol: ol, ratelimit: newRateLimiter()}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", gw.handleHealth)
	mux.HandleFunc("/dl/", gw.handleDownload)
	mux.HandleFunc("/redeem", gw.handleRedeemPage)
	mux.HandleFunc("/api/redeem", gw.handleRedeemAPI)

	log.Printf("卡密网关启动: %s (OpenList=%s)", cfg.Listen, cfg.OpenListURL)
	svr := &http.Server{
		Addr:         cfg.Listen,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}
	if err := svr.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}

// olClient 网关依赖的 OpenList 客户端接口(便于测试注入 fake)
type olClient interface {
	GetRawURL(path, password string) (string, error)
	ensureToken() error
}

// handler HTTP handler 集合
type handler struct {
	db        *sql.DB
	ol        olClient
	ratelimit *rateLimiter
}

type olClientDB interface {
	Exec(query string, args ...any) (sql.Result, error)
}

// rateLimiter 是轻量的进程内固定窗口限流器。多实例部署时应移到 nginx/Redis。
type rateLimiter struct {
	mu sync.Mutex
	m  map[string]rateWindow
}

type rateWindow struct {
	start time.Time
	n     int
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{m: make(map[string]rateWindow)}
}

func (l *rateLimiter) allow(key string, limit int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	w := l.m[key]
	if w.start.IsZero() || now.Sub(w.start) >= window {
		l.m[key] = rateWindow{start: now, n: 1}
		return true
	}
	if w.n >= limit {
		return false
	}
	w.n++
	l.m[key] = w
	return true
}

// clientIP 使用 nginx 注入的 X-Real-IP; 直连时回退 RemoteAddr。
func clientIP(r *http.Request) string {
	if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); ip != "" {
		return ip
	}
	return r.RemoteAddr
}

func (h *handler) securityHeaders(w http.ResponseWriter) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

func (h *handler) handleHealth(w http.ResponseWriter, r *http.Request) {
	h.securityHeaders(w)
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"status":"ok"}`)
}

func (h *handler) limited(r *http.Request, limit int) bool {
	if h.ratelimit == nil {
		h.ratelimit = newRateLimiter()
	}
	return h.ratelimit.allow(clientIP(r), limit, time.Minute)
}

// handleDownload 核心: /dl/<path>?token=<一次性token>
// 兼容旧 /dl/<path>?card=&key= 链接, 但新兑换页只发 token。
func (h *handler) handleDownload(w http.ResponseWriter, r *http.Request) {
	h.securityHeaders(w)
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !h.limited(r, 120) {
		http.Error(w, "请求过于频繁", http.StatusTooManyRequests)
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/dl/")
	if p == "" {
		http.Error(w, "empty path", http.StatusBadRequest)
		return
	}
	if un, err := url.PathUnescape(p); err == nil {
		p = un
	}
	q := r.URL.Query()
	token := strings.TrimSpace(q.Get("token"))
	var card *Card
	var err error
	if token != "" {
		card, err = VerifyDownloadToken(h.db, token, "/"+p)
	} else {
		cardID := q.Get("card")
		key := q.Get("key")
		if cardID == "" || key == "" {
			http.Error(w, "missing token", http.StatusBadRequest)
			return
		}
		card, err = VerifyCard(h.db, cardID, key)
		if err == nil {
			if len(card.Resources) > 0 && !card.HasResource("/"+p) {
				err = errors.New("该卡无权下载此资源")
			} else if len(card.Resources) == 0 && !card.Allowed("/"+p) {
				err = errors.New("无权访问该资源")
			}
		}
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}
	rawURL, err := h.ol.GetRawURL("/"+p, "")
	if err != nil {
		http.Error(w, "后端取直链失败: "+err.Error(), http.StatusBadGateway)
		return
	}
	var left int
	if token != "" {
		left, err = ConsumeDownloadToken(h.db, token)
	} else {
		left, err = ConsumeQuota(h.db, card.CardID)
	}
	if err != nil {
		http.Error(w, "扣次数失败: "+err.Error(), http.StatusInternalServerError)
		return
	}
	log.Printf("下载: card=%s path=%s group=%s 剩余=%d", card.CardID, "/"+p, card.PermGroup, left)
	http.Redirect(w, r, rawURL, http.StatusFound)
}

// resourceItem 兑换 API 返回的单条资源
type resourceItem struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// handleRedeemAPI POST 卡号+密钥 -> 验证 -> 返回绑定的资源列表
func (h *handler) handleRedeemAPI(w http.ResponseWriter, r *http.Request) {
	h.securityHeaders(w)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		fmt.Fprint(w, `{"code":405,"msg":"method not allowed"}`)
		return
	}
	if !h.limited(r, 20) {
		w.WriteHeader(http.StatusTooManyRequests)
		fmt.Fprint(w, `{"code":429,"msg":"请求过于频繁"}`)
		return
	}
	_ = PurgeDownloadTokens(h.db)
	cardID := strings.TrimSpace(r.FormValue("card"))
	key := strings.TrimSpace(r.FormValue("key"))
	if cardID == "" || key == "" {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"code":400,"msg":"请填写卡号和密钥"}`)
		return
	}
	card, err := VerifyCard(h.db, cardID, key)
	if err != nil {
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprintf(w, `{"code":403,"msg":%q}`, err.Error())
		return
	}
	if len(card.Resources) == 0 {
		fmt.Fprintf(w, `{"code":200,"msg":"ok","quota":%d,"resources":[]}`, card.Quota)
		return
	}
	items := make([]resourceItem, 0, len(card.Resources))
	for _, rs := range card.Resources {
		token, tokenErr := CreateDownloadToken(h.db, card.CardID, rs, 10*time.Minute)
		if tokenErr != nil {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"code":500,"msg":"创建兑换链接失败"}`)
			return
		}
		items = append(items, resourceItem{Name: filepathBase(rs), Path: DownloadPathWithToken(rs, token)})
	}
	fmt.Fprintf(w, `{"code":200,"msg":"ok","quota":%d,"resources":%s}`,
		card.Quota, mustJSON(items))
	log.Printf("兑换页验证: card=%s 资源数=%d", cardID, len(items))
}

// handleRedeemPage GET 兑换页(内嵌 HTML,单二进制无静态依赖)
func (h *handler) handleRedeemPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, redeemHTML)
}

func DownloadPathWithToken(resource, token string) string {
	parts := strings.Split(normalizeResource(resource), "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return "/dl/" + strings.Join(parts, "/") + "?token=" + url.QueryEscape(token)
}

// filepathBase 返回路径最末段作展示名(不引 path/filepath 依赖)
func filepathBase(p string) string {
	p = strings.TrimSuffix(p, "/")
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}

// mustJSON 序列化任意值,失败则 fallback 空数组(不会失败)
func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	if len(b) == 0 {
		return "[]"
	}
	return string(b)
}
