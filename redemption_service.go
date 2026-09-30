package main

import (
	"context"
	"errors"
	"log/slog"
	"net/url"
	"strings"
	"time"
)

type olClient interface {
	GetRawURL(context.Context, string, string) (string, error)
}
type redemptionService struct {
	store                     *grantStore
	backend                   olClient
	budget, window, minURLTTL time.Duration
	allowedHosts              []string
}

func (s *redemptionService) issue(ctx context.Context, key string) (*grant, error) {
	ctx, cancel := context.WithTimeout(ctx, s.budget)
	defer cancel()
	g, err := s.store.acquire(ctx, key, time.Now(), s.budget+2*time.Second)
	if err != nil {
		return nil, err
	}
	if g.State == "issued" {
		return g, nil
	}
	issued := false
	defer func() {
		if !issued {
			cleanup, c := context.WithTimeout(context.Background(), 2*time.Second)
			defer c()
			if err := s.store.release(cleanup, g); err != nil {
				slog.Error("grant release failed", "grant_id", g.ID, "error_type", "storage")
			}
		}
	}()
	started := time.Now()
	raw, err := s.backend.GetRawURL(ctx, "/"+g.Resource, "")
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var upstream *OLError
		if errors.As(err, &upstream) {
			slog.Warn("file backend failed", "grant_id", g.ID, "operation", upstream.Operation, "kind", upstream.Kind, "http_status", upstream.HTTPStatus, "api_code", upstream.APICode)
		}
		return nil, ErrBackend
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = validateRawURL(raw); err != nil {
		return nil, ErrBackend
	}
	u, _ := url.Parse(raw)
	if u.IsAbs() {
		allowed := false
		for _, host := range s.allowedHosts {
			if strings.EqualFold(u.Host, host) {
				allowed = true
				break
			}
		}
		if !allowed {
			return nil, ErrBackend
		}
	}
	// minURLTTL is an operator-verified lower bound, measured conservatively from before fs/get.
	expires := started.Add(s.minURLTTL)
	if windowEnd := time.Now().Add(s.window); windowEnd.Before(expires) {
		expires = windowEnd
	}
	out, err := s.store.finish(ctx, g, raw, expires, time.Now())
	var uncertain *commitError
	if errors.As(err, &uncertain) {
		check, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		// Query only: reconciliation must not acquire or charge a new operation.
		current, e := scanGrant(s.store.db.QueryRowContext(check, `SELECT `+grantColumns+` FROM grants WHERE id=?`, g.ID))
		if e == nil && current.State == "issued" {
			issued = true
			return nil, err
		}
	}
	if err != nil {
		return nil, err
	}
	issued = true
	return out, nil
}
