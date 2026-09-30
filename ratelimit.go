package main

import (
	"sync"
	"time"
)

// rateLimiter 是轻量的进程内固定窗口限流器。多实例部署时应移到 nginx/Redis。
type rateLimiter struct {
	mu          sync.Mutex
	m           map[string]rateWindow
	lastCleanup time.Time
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
	if l.lastCleanup.IsZero() || now.Sub(l.lastCleanup) >= window {
		for k, w := range l.m {
			if now.Sub(w.start) >= window {
				delete(l.m, k)
			}
		}
		l.lastCleanup = now
	}
	if _, exists := l.m[key]; !exists && len(l.m) >= 10000 {
		return false
	}
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
