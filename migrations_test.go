package main

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestFutureSchemaReturnsErrorWithoutPanic(t *testing.T) {
	p := filepath.Join(t.TempDir(), "future.db")
	db, _ := sql.Open("sqlite", p)
	db.Exec(`PRAGMA user_version=999`)
	db.Close()
	db, err := openDB(p)
	if err == nil || db != nil {
		t.Fatal("accepted future schema")
	}
}
func TestMigrationLegacyDataAndCredential(t *testing.T) {
	p := filepath.Join(t.TempDir(), "old.db")
	db, e := sql.Open("sqlite", p)
	if e != nil {
		t.Fatal(e)
	}
	_, e = db.Exec(`CREATE TABLE cards(card_id TEXT PRIMARY KEY,secret TEXT,quota INTEGER,perm_group TEXT,prefixes TEXT,resources TEXT,expires_at DATETIME,created_at DATETIME,revoked INTEGER);CREATE TABLE download_tokens(token_hash TEXT PRIMARY KEY,card_id TEXT,resource TEXT,expires_at DATETIME,used INTEGER,created_at DATETIME)`)
	if e != nil {
		t.Fatal(e)
	}
	key := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	now := time.Now()
	_, e = db.Exec(`INSERT INTO cards VALUES('legacy','secret',1,'member','','private/a',NULL,?,0)`, now)
	if e != nil {
		t.Fatal(e)
	}
	_, e = db.Exec(`INSERT INTO download_tokens VALUES(?,'legacy','private/a',?,2,?)`, secretHash(key), now.Add(time.Minute), now)
	if e != nil {
		t.Fatal(e)
	}
	db.Close()
	db, e = openDB(p)
	if e != nil {
		t.Fatal(e)
	}
	c, e := VerifyCard(db, "legacy", "secret")
	if e != nil || c.Quota != 1 {
		t.Fatal(c, e)
	}
	s := &grantStore{db}
	g, e := s.acquire(context.Background(), key, time.Now(), time.Minute)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.finish(context.Background(), g, "https://files.example/a", now.Add(time.Minute), time.Now())
	if e != nil {
		t.Fatal(e)
	}
	var secretCols int
	db.QueryRow(`SELECT count(*) FROM pragma_table_info('cards') WHERE name='secret'`).Scan(&secretCols)
	if secretCols != 0 {
		t.Fatal("plaintext column retained")
	}
	db.Close()
	db, e = openDB(p)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	g, e = (&grantStore{db}).acquire(context.Background(), key, time.Now(), time.Minute)
	if e != nil || g.Quota != 0 {
		t.Fatal(g, e)
	}
}
func TestMigrationFailureRollsBack(t *testing.T) {
	p := filepath.Join(t.TempDir(), "bad.db")
	db, _ := sql.Open("sqlite", p)
	db.Exec(`CREATE TABLE cards(card_id TEXT PRIMARY KEY,secret TEXT,quota INTEGER,perm_group TEXT,prefixes TEXT,expires_at DATETIME,created_at DATETIME,revoked INTEGER);INSERT INTO cards VALUES('bad','s',1,'member','/private/',NULL,'not-a-date',0)`)
	db.Close()
	var got *sql.DB
	var err error
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("migration panicked: %v", r)
			}
		}()
		got, err = openDB(p)
	}()
	if got != nil {
		got.Close()
	}
	if err == nil {
		t.Error("invalid date accepted")
	}
	db, _ = sql.Open("sqlite", p)
	defer db.Close()
	var n int
	db.QueryRow(`SELECT count(*) FROM cards`).Scan(&n)
	if n != 1 {
		t.Fatal("lost old card")
	}
	db.QueryRow(`PRAGMA user_version`).Scan(&n)
	if n != 0 {
		t.Fatal("advanced failed schema")
	}
}
func TestGrantCardExpiresWaitingForConnection(t *testing.T) {
	s, key, c := grantFixture(t)
	g, _ := s.acquire(context.Background(), key, time.Now(), time.Minute)
	expiry := time.Now().Add(80 * time.Millisecond)
	s.db.Exec(`UPDATE cards SET expires_at_ms=? WHERE card_id=?`, expiry.UnixMilli(), c.CardID)
	conn, e := s.db.Conn(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	captured := time.Now()
	go func() {
		_, err := s.finish(context.Background(), g, "https://files.example/a", time.Now().Add(time.Minute), captured)
		done <- err
	}()
	time.Sleep(time.Until(expiry) + 20*time.Millisecond)
	conn.Close()
	if e = <-done; !errors.Is(e, ErrExpired) {
		t.Fatalf("expired card finalized after lock wait: %v", e)
	}
}
