package main

import (
	"bytes"
	"fmt"
	"gopkg.in/yaml.v3"
	"io"
	"net"
	"net/netip"
	"net/url"
	"os"
)

type Config struct {
	PublicCatalogPath  string   `yaml:"public_catalog_path"`
	DownloadHosts      []string `yaml:"download_hosts"`
	Listen             string   `yaml:"listen"`
	DBPath             string   `yaml:"db_path"`
	OpenListURL        string   `yaml:"openlist_url"`
	OLAdminUser        string   `yaml:"openlist_admin_user"`
	OLAdminPass        string   `yaml:"openlist_admin_pass"`
	GrantWindowSeconds int      `yaml:"grant_window_seconds"`
	MinURLTTLSeconds   int      `yaml:"openlist_min_url_ttl_seconds"`
	TrustedProxyCIDRs  []string `yaml:"trusted_proxy_cidrs"`
	PublicPrefixes     []string `yaml:"public_prefixes"`
	AuditRetentionDays int      `yaml:"audit_retention_days"`
}

func defaultConfig() Config {
	return Config{Listen: "127.0.0.1:8080", DBPath: "cards.db", OpenListURL: "http://127.0.0.1:5244", GrantWindowSeconds: 600, PublicPrefixes: []string{"pub/"}, AuditRetentionDays: 90}
}
func loadConfig(path string) (Config, error) {
	cfg := defaultConfig()
	b, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	dec := yaml.NewDecoder(bytes.NewReader(b))
	dec.KnownFields(true)
	if err = dec.Decode(&cfg); err != nil {
		return cfg, fmt.Errorf("invalid YAML configuration")
	}
	var extra any
	if err = dec.Decode(&extra); err != io.EOF {
		return cfg, fmt.Errorf("configuration must contain exactly one YAML document")
	}
	return cfg, cfg.validate()
}
func (c Config) validate() error {
	if _, _, err := net.SplitHostPort(c.Listen); err != nil {
		return fmt.Errorf("invalid listen address")
	}
	if c.DBPath == "" {
		return fmt.Errorf("db_path required")
	}
	u, err := url.Parse(c.OpenListURL)
	if err != nil || u == nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("invalid openlist_url")
	}
	if c.OLAdminUser == "" || c.OLAdminPass == "" || c.OLAdminPass == "CHANGE_ME" {
		return fmt.Errorf("OpenList credentials required")
	}
	if c.GrantWindowSeconds < 10 || c.GrantWindowSeconds > 3600 {
		return fmt.Errorf("grant_window_seconds must be 10..3600")
	}
	if c.MinURLTTLSeconds < c.GrantWindowSeconds || c.MinURLTTLSeconds > 86400 {
		return fmt.Errorf("operator-verified openlist_min_url_ttl_seconds must be >= grant window and <= 86400; verify signer before enabling grants")
	}
	if c.AuditRetentionDays < 1 || c.AuditRetentionDays > 3650 {
		return fmt.Errorf("audit_retention_days must be 1..3650")
	}
	for _, host := range c.DownloadHosts {
		u, e := url.Parse("https://" + host)
		if e != nil || u.Host != host || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return fmt.Errorf("invalid download_hosts entry")
		}
	}
	for _, cidr := range c.TrustedProxyCIDRs {
		if _, err := netip.ParsePrefix(cidr); err != nil {
			return fmt.Errorf("invalid trusted proxy CIDR")
		}
	}
	for _, p := range c.PublicPrefixes {
		if p == "" || p[0] == '/' || p[len(p)-1] != '/' || validateResourcePath(p[:len(p)-1]) != nil {
			return fmt.Errorf("invalid public resource prefix")
		}
	}
	if c.PublicCatalogPath != "" {
		if _, err := loadPublicCatalog(c.PublicCatalogPath, c.PublicPrefixes); err != nil {
			return err
		}
	}
	return nil
}
