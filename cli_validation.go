package main

import (
	"fmt"
	"math"
	"strings"
	"time"
	"unicode"
)

// validateCardInput rejects ambiguous scopes before any database mutation.
func validateCardInput(quota int, group string, prefixes, resources []string, ttlDays *int) error {
	if len(resources) > 100 || len(prefixes) > 100 {
		return fmt.Errorf("最多绑定 100 项资源或前缀")
	}
	if quota <= 0 {
		return fmt.Errorf("quota 必须为正整数")
	}
	switch group {
	case "guest", "member", "vip":
	default:
		return fmt.Errorf("未知权限组 %q", group)
	}
	if ttlDays != nil && (*ttlDays < 0 || int64(*ttlDays) > math.MaxInt64/int64(24*time.Hour)) {
		return fmt.Errorf("days 超出有效范围")
	}
	if (len(prefixes) == 0) == (len(resources) == 0) {
		return fmt.Errorf("必须指定资源或前缀，且不能同时指定")
	}
	for _, list := range [][]string{prefixes, resources} {
		seen := map[string]bool{}
		for _, value := range list {
			if len(value) > 2048 || value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\\,?#") || strings.IndexFunc(value, unicode.IsControl) >= 0 {
				return fmt.Errorf("无效资源路径 %q", value)
			}
			isPrefix := len(resources) == 0
			path := value
			if isPrefix {
				if !strings.HasPrefix(path, "/") || !strings.HasSuffix(path, "/") {
					return fmt.Errorf("前缀必须以 / 开始和结束")
				}
				path = strings.TrimSuffix(strings.TrimPrefix(path, "/"), "/")
			} else if strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") {
				return fmt.Errorf("资源必须是无首尾斜线的相对文件路径")
			}
			for _, part := range strings.Split(path, "/") {
				if part == "" || part == "." || part == ".." {
					return fmt.Errorf("无效资源路径 %q", value)
				}
			}
			if seen[value] {
				return fmt.Errorf("重复资源路径 %q", value)
			}
			seen[value] = true
		}
	}
	return nil
}

func parseCardList(value string) []string {
	if value == "" {
		return nil
	}
	// Empty entries intentionally survive so validation can reject typos.
	return strings.Split(value, ",")
}
