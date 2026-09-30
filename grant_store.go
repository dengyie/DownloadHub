package main

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Bound uncharged credentials per card, including expired rows awaiting cleanup.
// A 100-resource card can prepare five full resource lists without invalidating any prior link.
const maxPendingGrantsPerCard = 500

type grantStore struct{ db *sql.DB }
type resourceItem struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Credential string `json:"credential"`
}
type grant struct {
	ID                               string    `json:"grant_id"`
	URL                              string    `json:"url"`
	ExpiresAt                        time.Time `json:"expires_at"`
	Quota                            int       `json:"quota"`
	CardID, Resource, State, ClaimID string
	CredentialExpires, LeaseUntil    int64
}

const grantColumns = `id,card_id,resource,state,claim_id,credential_expires_at,lease_until,result_url,expires_at`

func scanGrant(row rowScanner) (*grant, error) {
	var g grant
	var expires int64
	if err := row.Scan(&g.ID, &g.CardID, &g.Resource, &g.State, &g.ClaimID, &g.CredentialExpires, &g.LeaseUntil, &g.URL, &expires); err != nil {
		if err == sql.ErrNoRows {
			return nil, ErrDenied
		}
		return nil, err
	}
	g.ExpiresAt = time.UnixMilli(expires).UTC()
	return &g, nil
}
func (s *grantStore) create(ctx context.Context, card *Card, resources []string, ttl time.Duration) ([]resourceItem, error) {
	if len(resources) > 100 || ttl <= 0 {
		return nil, ErrInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	c, _, err := scanCard(tx.QueryRowContext(ctx, `SELECT `+cardColumns+` FROM cards WHERE card_id=?`, card.CardID))
	if err != nil {
		return nil, err
	}
	now := time.Now()
	if err = c.valid(now, true); err != nil {
		return nil, err
	}
	var pending int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM grants g WHERE card_id=? AND NOT EXISTS (SELECT 1 FROM quota_events e WHERE e.grant_id=g.id)`, c.CardID).Scan(&pending); err != nil {
		return nil, err
	}
	if len(resources) > maxPendingGrantsPerCard-pending {
		return nil, ErrGrantLimit
	}
	items := make([]resourceItem, 0, len(resources))
	for _, resource := range resources {
		resource = normalizeResource(resource)
		if err = validateResourcePath(resource); err != nil {
			return nil, err
		}
		if !c.authorizes(resource) {
			return nil, ErrDenied
		}
		key, err := randomSecret(32)
		if err != nil {
			return nil, err
		}
		id, err := randomSecret(16)
		if err != nil {
			return nil, err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO grants(id,credential_hash,card_id,resource,state,credential_expires_at,created_at) VALUES(?,?,?,?,'ready',?,?)`, id, secretHash(key), c.CardID, resource, now.Add(ttl).UnixMilli(), now.UnixMilli())
		if err != nil {
			return nil, err
		}
		items = append(items, resourceItem{Name: filepathBase(resource), Path: DownloadPathWithToken(resource, key), Credential: key})
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return items, nil
}
func (s *grantStore) acquire(ctx context.Context, key string, now time.Time, lease time.Duration) (*grant, error) {
	if len(key) != 64 {
		return nil, ErrDenied
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if fresh := time.Now(); fresh.After(now) {
		now = fresh
	}
	g, err := scanGrant(tx.QueryRowContext(ctx, `SELECT `+grantColumns+` FROM grants WHERE credential_hash=?`, secretHash(key)))
	if err != nil {
		return nil, err
	}
	c, _, err := scanCard(tx.QueryRowContext(ctx, `SELECT `+cardColumns+` FROM cards WHERE card_id=?`, g.CardID))
	if err != nil {
		return nil, err
	}
	if err = c.valid(now, g.State != "issued"); err != nil {
		return nil, err
	}
	if !c.authorizes(g.Resource) {
		return nil, ErrDenied
	}
	g.Quota = c.Quota
	if g.State == "issued" {
		if !now.Before(g.ExpiresAt) || g.URL == "" {
			return nil, ErrExpired
		}
		return g, nil
	}
	if g.State == "expired" || g.CredentialExpires <= now.UnixMilli() {
		return nil, ErrExpired
	}
	if g.State == "processing" && g.LeaseUntil > now.UnixMilli() {
		return nil, ErrBusy
	}
	claim, err := randomSecret(16)
	if err != nil {
		return nil, err
	}
	g.ClaimID = claim
	g.State = "processing"
	g.LeaseUntil = now.Add(lease).UnixMilli()
	_, err = tx.ExecContext(ctx, `UPDATE grants SET state='processing',claim_id=?,lease_until=? WHERE id=?`, claim, g.LeaseUntil, g.ID)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return g, nil
}
func (s *grantStore) release(ctx context.Context, g *grant) error {
	_, err := s.db.ExecContext(ctx, `UPDATE grants SET state='ready',claim_id='',lease_until=0 WHERE id=? AND state='processing' AND claim_id=?`, g.ID, g.ClaimID)
	return err
}

type commitError struct{ err error }

func (e *commitError) Error() string { return "authorization commit outcome requires reconciliation" }
func (e *commitError) Unwrap() error { return e.err }
func (s *grantStore) finish(ctx context.Context, claimed *grant, url string, expires, now time.Time) (*grant, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !expires.After(now) {
		return nil, ErrBackend
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if fresh := time.Now(); fresh.After(now) {
		now = fresh
	}
	if !expires.After(now) {
		return nil, ErrBackend
	}
	g, err := scanGrant(tx.QueryRowContext(ctx, `SELECT `+grantColumns+` FROM grants WHERE id=?`, claimed.ID))
	if err != nil {
		return nil, err
	}
	if g.State != "processing" || g.ClaimID != claimed.ClaimID || g.LeaseUntil <= now.UnixMilli() {
		return nil, ErrBusy
	}
	if g.CredentialExpires <= now.UnixMilli() {
		return nil, ErrExpired
	}
	c, _, err := scanCard(tx.QueryRowContext(ctx, `SELECT `+cardColumns+` FROM cards WHERE card_id=?`, g.CardID))
	if err != nil {
		return nil, err
	}
	if err = c.valid(now, true); err != nil {
		return nil, err
	}
	if !c.authorizes(g.Resource) {
		return nil, ErrDenied
	}
	if c.ExpiresAt != nil && c.ExpiresAt.Before(expires) {
		expires = *c.ExpiresAt
	}
	result, err := tx.ExecContext(ctx, `UPDATE cards SET quota=quota-1 WHERE card_id=? AND quota>0 AND revoked=0 AND (expires_at_ms IS NULL OR expires_at_ms>?)`, g.CardID, now.UnixMilli())
	if err != nil {
		return nil, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n != 1 {
		return nil, ErrDenied
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO quota_events(grant_id,card_id,delta,committed_at) VALUES(?,?,-1,?)`, g.ID, g.CardID, now.UnixMilli())
	if err != nil {
		return nil, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE grants SET state='issued',issued_at=?,expires_at=?,result_url=?,claim_id='',lease_until=0 WHERE id=?`, now.UnixMilli(), expires.UnixMilli(), url, g.ID)
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, &commitError{err}
	}
	g.State = "issued"
	g.URL = url
	g.ExpiresAt = expires.UTC()
	g.Quota = c.Quota - 1
	return g, nil
}

// cleanup drains bounded transactions until caught up or its total time budget expires.
// Existing valid credentials and live leases are never invalidated to make room.
func (s *grantStore) cleanup(ctx context.Context, now time.Time, retention time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for {
		changed, err := s.cleanupBatch(ctx, now, retention)
		if err != nil {
			return err
		}
		if changed == 0 {
			return nil
		}
	}
}

func (s *grantStore) cleanupBatch(ctx context.Context, now time.Time, retention time.Duration) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var changed int64
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`UPDATE grants SET result_url='',state='expired' WHERE id IN (SELECT id FROM grants WHERE state='issued' AND expires_at<=? LIMIT 500)`, []any{now.UnixMilli()}},
		{`DELETE FROM grants WHERE id IN (SELECT id FROM grants WHERE state IN ('ready','processing','expired') AND credential_expires_at<=? AND lease_until<=? AND NOT EXISTS(SELECT 1 FROM quota_events WHERE grant_id=grants.id) LIMIT 500)`, []any{now.UnixMilli(), now.UnixMilli()}},
	} {
		result, err := tx.ExecContext(ctx, statement.query, statement.args...)
		if err != nil {
			return 0, err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return 0, err
		}
		changed += n
	}
	// Delete audit and parent rows together only beyond the declared retention period.
	rows, err := tx.QueryContext(ctx, `SELECT g.id FROM grants g JOIN quota_events e ON e.grant_id=g.id WHERE g.state='expired' AND e.committed_at<? LIMIT 500`, now.Add(-retention).UnixMilli())
	if err != nil {
		return 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	for _, id := range ids {
		if _, err = tx.ExecContext(ctx, `DELETE FROM quota_events WHERE grant_id=?`, id); err != nil {
			return 0, err
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM grants WHERE id=?`, id); err != nil {
			return 0, err
		}
	}
	changed += int64(len(ids))
	if err = tx.Commit(); err != nil {
		return 0, fmt.Errorf("maintenance transaction: %w", err)
	}
	return changed, nil
}
