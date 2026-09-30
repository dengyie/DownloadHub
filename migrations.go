package main

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/001.sql
var initialSchema string

const schemaVersion = 1

func openDB(path string) (db *sql.DB, err error) {
	if path == "" {
		return nil, ErrInvalid
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	// URI pragmas run on every new connection; no WAL assumption about the filesystem.
	u := url.URL{Scheme: "file", Path: abs}
	q := url.Values{}
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "busy_timeout(2000)")
	q.Set("_txlock", "immediate")
	u.RawQuery = q.Encode()
	file, err := os.OpenFile(abs, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err == nil {
		if err = file.Close(); err != nil {
			return nil, err
		}
	} else if !os.IsExist(err) {
		return nil, err
	}
	db, err = sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	opened := db
	defer func() {
		if err != nil {
			opened.Close()
			db = nil
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var version int
	if err = tx.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil {
		return nil, err
	}
	if version > schemaVersion {
		return nil, fmt.Errorf("database schema %d is newer than supported %d", version, schemaVersion)
	}
	if version == schemaVersion {
		err = tx.Commit()
		return db, err
	}
	if _, err = tx.ExecContext(ctx, initialSchema); err != nil {
		return nil, err
	}
	cols, err := tableColumns(tx, "cards")
	if err != nil {
		return nil, err
	}
	if len(cols) > 0 {
		if err = migrateCards(ctx, tx, cols); err != nil {
			return nil, err
		}
	}
	tokenCols, err := tableColumns(tx, "download_tokens")
	if err != nil {
		return nil, err
	}
	if len(tokenCols) > 0 {
		if err = migrateTokens(ctx, tx); err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, `DROP TABLE download_tokens`); err != nil {
			return nil, err
		}
	}
	if len(cols) > 0 {
		if _, err = tx.ExecContext(ctx, `DROP TABLE cards`); err != nil {
			return nil, err
		}
	}
	if _, err = tx.ExecContext(ctx, `ALTER TABLE cards_v1 RENAME TO cards; PRAGMA user_version=1`); err != nil {
		return nil, err
	}
	err = tx.Commit()
	return db, err
}
func tableColumns(tx *sql.Tx, table string) (map[string]bool, error) {
	// Only internal constant table names reach this helper.
	rows, err := tx.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var cid, nn, pk int
		var name, kind string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &kind, &nn, &dflt, &pk); err != nil {
			return nil, err
		}
		out[name] = true
	}
	return out, rows.Err()
}
func migrateCards(ctx context.Context, tx *sql.Tx, cols map[string]bool) error {
	hash, res := "''", "''"
	if cols["secret_hash"] {
		hash = "secret_hash"
	}
	if cols["resources"] {
		res = "resources"
	}
	rows, err := tx.QueryContext(ctx, `SELECT card_id,secret,`+hash+`,quota,perm_group,prefixes,`+res+`,expires_at,created_at,revoked FROM cards`)
	if err != nil {
		return err
	}
	type legacy struct {
		id, key, hash, group, p, r string
		quota                      int
		expires                    sql.NullTime
		created                    time.Time
		revoked                    bool
	}
	var cards []legacy
	for rows.Next() {
		var c legacy
		if err := rows.Scan(&c.id, &c.key, &c.hash, &c.quota, &c.group, &c.p, &c.r, &c.expires, &c.created, &c.revoked); err != nil {
			rows.Close()
			return fmt.Errorf("legacy card timestamp/row invalid: %w", err)
		}
		cards = append(cards, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, c := range cards {
		if c.hash == "" {
			if c.key == "" {
				return fmt.Errorf("legacy card missing credential hash")
			}
			c.hash = secretHash(c.key)
		}
		p, _ := json.Marshal(splitNonEmpty(c.p, ","))
		r, _ := json.Marshal(splitNonEmpty(c.r, ","))
		var exp any
		if c.expires.Valid {
			exp = c.expires.Time.UnixMilli()
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO cards_v1 VALUES(?,?,?,?,?,?,?,?,?)`, c.id, c.hash, c.quota, c.group, string(p), string(r), exp, c.created.UnixMilli(), c.revoked); err != nil {
			return err
		}
	}
	return nil
}
func migrateTokens(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `SELECT token_hash,card_id,resource,expires_at,used,created_at FROM download_tokens`)
	if err != nil {
		return err
	}
	type oldToken struct {
		hash, card, resource string
		expires, created     time.Time
		used                 int
	}
	var tokens []oldToken
	for rows.Next() {
		var t oldToken
		if err := rows.Scan(&t.hash, &t.card, &t.resource, &t.expires, &t.used, &t.created); err != nil {
			rows.Close()
			return err
		}
		tokens = append(tokens, t)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, t := range tokens {
		if t.used < 0 || t.used > 2 {
			return fmt.Errorf("unknown legacy token state")
		}
		state := "ready"
		if t.used == 1 || !time.Now().Before(t.expires) {
			state = "expired"
		}
		id, err := randomSecret(16)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO grants(id,credential_hash,card_id,resource,state,credential_expires_at,created_at) VALUES(?,?,?,?,?,?,?)`, id, t.hash, t.card, normalizeResource(t.resource), state, t.expires.UnixMilli(), t.created.UnixMilli()); err != nil {
			return err
		}
	}
	return nil
}
