package main

import (
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
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

	gw := &handler{db: db, ol: ol}

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

// handler HTTP handler 集合
type handler struct {
	db *sql.DB
	ol *OLClient
}

func (h *handler) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"status":"ok"}`)
}

// handleDownload 核心: /dl/<path>?card=&key=
func (h *handler) handleDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", 405)
		return
	}
	// 提取路径
	p := strings.TrimPrefix(r.URL.Path, "/dl/")
	if p == "" {
		http.Error(w, "empty path", 400)
		return
	}
	cardID := r.URL.Query().Get("card")
	key := r.URL.Query().Get("key")
	if cardID == "" || key == "" {
		http.Error(w, "missing card/key", 400)
		return
	}
	// 路径 URL 解码
	if un, err := url.PathUnescape(p); err == nil {
		p = un
	}
	// 校验卡
	card, err := VerifyCard(h.db, cardID, key)
	if err != nil {
		http.Error(w, err.Error(), 403)
		return
	}
	// 权限匹配: 卡绑定资源时精确匹配,否则按前缀(旧模式)
	if len(card.Resources) > 0 {
		if !card.HasResource("/" + p) {
			http.Error(w, "该卡无权下载此资源", 403)
			return
		}
	} else if !card.Allowed("/" + p) {
		http.Error(w, "无权访问该资源", 403)
		return
	}
	// 从 OpenList 拿签名直链
	rawURL, err := h.ol.GetRawURL("/"+p, "")
	if err != nil {
		http.Error(w, "后端取直链失败: "+err.Error(), 502)
		return
	}
	// 扣次数
	left, err := ConsumeQuota(h.db, cardID)
	if err != nil {
		http.Error(w, "扣次数失败: "+err.Error(), 500)
		return
	}
	log.Printf("下载: card=%s path=%s group=%s 剩余=%d", cardID, "/"+p, card.PermGroup, left)
	// 302 到签名直链
	http.Redirect(w, r, rawURL, http.StatusFound)
}

// resourceItem 兑换 API 返回的单条资源
type resourceItem struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// handleRedeemAPI POST 卡号+密钥 -> 验证 -> 返回绑定的资源列表
func (h *handler) handleRedeemAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(405)
		fmt.Fprint(w, `{"code":405,"msg":"method not allowed"}`)
		return
	}
	cardID := strings.TrimSpace(r.FormValue("card"))
	key := strings.TrimSpace(r.FormValue("key"))
	if cardID == "" || key == "" {
		w.WriteHeader(400)
		fmt.Fprint(w, `{"code":400,"msg":"请填写卡号和密钥"}`)
		return
	}
	card, err := VerifyCard(h.db, cardID, key)
	if err != nil {
		w.WriteHeader(403)
		fmt.Fprintf(w, `{"code":403,"msg":%q}`, err.Error())
		return
	}
	// 绑定资源卡的兑换页列出资源; 前缀卡无具体资源列表,提示用 /dl 直连
	if len(card.Resources) == 0 {
		fmt.Fprintf(w, `{"code":200,"msg":"ok","quota":%d,"resources":[]}`, card.Quota)
		return
	}
	items := make([]resourceItem, 0, len(card.Resources))
	for _, rs := range card.Resources {
		items = append(items, resourceItem{Name: filepathBase(rs), Path: rs})
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
