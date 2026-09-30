package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode"
)

type Card struct {
	CardID    string
	Secret    string
	Quota     int
	PermGroup string
	Prefixes  []string
	Resources []string
	ExpiresAt *time.Time
	CreatedAt time.Time
	Revoked   bool
}

func randomSecret(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
func secretHash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func CreateCard(db *sql.DB, quota int, group string, prefixes, resources []string, days *int) (*Card, error) {
	if err := validateCardInput(quota, group, prefixes, resources, days); err != nil {
		return nil, err
	}
	id, err := randomSecret(16)
	if err != nil {
		return nil, err
	}
	key, err := randomSecret(32)
	if err != nil {
		return nil, err
	}
	c := &Card{CardID: id, Secret: key, Quota: quota, PermGroup: group, Prefixes: prefixes, Resources: resources, CreatedAt: time.Now().UTC()}
	var expires any
	if days != nil && *days > 0 {
		t := c.CreatedAt.Add(time.Duration(*days) * 24 * time.Hour)
		c.ExpiresAt = &t
		expires = t.UnixMilli()
	}
	p, _ := json.Marshal(prefixes)
	r, _ := json.Marshal(resources)
	_, err = db.Exec(`INSERT INTO cards(card_id,secret_hash,quota,perm_group,prefixes,resources,expires_at_ms,created_at_ms,revoked) VALUES(?,?,?,?,?,?,?,?,0)`, id, secretHash(key), quota, group, string(p), string(r), expires, c.CreatedAt.UnixMilli())
	if err != nil {
		return nil, err
	}
	return c, nil
}

const cardColumns = `card_id,secret_hash,quota,perm_group,prefixes,resources,expires_at_ms,created_at_ms,revoked`

type rowScanner interface{ Scan(...any) error }

func scanCard(row rowScanner) (*Card, string, error) {
	var c Card
	var hash, p, r string
	var expires sql.NullInt64
	var created int64
	if err := row.Scan(&c.CardID, &hash, &c.Quota, &c.PermGroup, &p, &r, &expires, &created, &c.Revoked); err != nil {
		if err == sql.ErrNoRows {
			return nil, "", ErrDenied
		}
		return nil, "", err
	}
	if err := json.Unmarshal([]byte(p), &c.Prefixes); err != nil {
		return nil, "", fmt.Errorf("decode card prefixes: %w", err)
	}
	if err := json.Unmarshal([]byte(r), &c.Resources); err != nil {
		return nil, "", fmt.Errorf("decode card resources: %w", err)
	}
	c.CreatedAt = time.UnixMilli(created).UTC()
	if expires.Valid {
		t := time.UnixMilli(expires.Int64).UTC()
		c.ExpiresAt = &t
	}
	return &c, hash, nil
}
func loadCard(db *sql.DB, id string) (*Card, error) {
	c, _, err := scanCard(db.QueryRow(`SELECT `+cardColumns+` FROM cards WHERE card_id=?`, id))
	return c, err
}
func verifyCardContext(ctx context.Context, db *sql.DB, id, key string) (*Card, error) {
	c, hash, err := scanCard(db.QueryRowContext(ctx, `SELECT `+cardColumns+` FROM cards WHERE card_id=?`, id))
	if err != nil {
		return nil, err
	}
	if subtle.ConstantTimeCompare([]byte(hash), []byte(secretHash(key))) != 1 {
		return nil, ErrDenied
	}
	if err := c.valid(time.Now(), true); err != nil {
		return nil, err
	}
	return c, nil
}
func VerifyCard(db *sql.DB, id, key string) (*Card, error) {
	return verifyCardContext(context.Background(), db, id, key)
}
func (c *Card) valid(now time.Time, needQuota bool) error {
	if c.Revoked {
		return ErrDenied
	}
	if c.ExpiresAt != nil && !now.Before(*c.ExpiresAt) {
		return ErrExpired
	}
	if needQuota && c.Quota <= 0 {
		return ErrQuota
	}
	return nil
}
func (c *Card) Allowed(path string) bool {
	for _, p := range c.Prefixes {
		p = strings.TrimSuffix(p, "/")
		if path == p || strings.HasPrefix(path, p+"/") {
			return true
		}
	}
	return false
}
func (c *Card) HasResource(path string) bool {
	p := normalizeResource(path)
	for _, r := range c.Resources {
		if normalizeResource(r) == p {
			return true
		}
	}
	return false
}
func (c *Card) authorizes(path string) bool {
	if len(c.Resources) > 0 {
		return c.HasResource(path)
	}
	return c.Allowed("/" + normalizeResource(path))
}
func validateResourcePath(p string) error {
	p = strings.TrimPrefix(p, "/")
	if p == "" || len(p) > 2048 || strings.TrimSpace(p) != p || strings.ContainsAny(p, "\\,?#") || strings.IndexFunc(p, unicode.IsControl) >= 0 {
		return ErrInvalid
	}
	for _, s := range strings.Split(p, "/") {
		if s == "" || s == "." || s == ".." {
			return ErrInvalid
		}
	}
	return nil
}
func normalizeResource(p string) string { return strings.TrimPrefix(p, "/") }
func RevokeCard(db *sql.DB, id string) error {
	r, err := db.Exec(`UPDATE cards SET revoked=1 WHERE card_id=?`, id)
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrDenied
	}
	return nil
}
func ListCards(db *sql.DB) ([]Card, error) {
	rows, err := db.Query(`SELECT ` + cardColumns + ` FROM cards ORDER BY created_at_ms DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Card{}
	for rows.Next() {
		c, _, err := scanCard(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}
func splitNonEmpty(s, sep string) []string {
	var out []string
	for _, p := range strings.Split(s, sep) {
		if strings.TrimSpace(p) != "" {
			out = append(out, strings.TrimSpace(p))
		}
	}
	return out
}
func (c *Card) String() string {
	return fmt.Sprintf("card=%s quota=%d group=%s", c.CardID, c.Quota, c.PermGroup)
}
