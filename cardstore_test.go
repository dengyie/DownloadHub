package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dir := t.TempDir()
	db, err := openDB(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestCreateAndVerifyCard(t *testing.T) {
	db := newTestDB(t)
	days := 30
	card, err := CreateCard(db, 5, "member", []string{"/pub/", "/share/"}, nil, &days)
	if err != nil {
		t.Fatalf("CreateCard: %v", err)
	}
	if card.Quota != 5 || card.PermGroup != "member" {
		t.Fatalf("card fields wrong: %+v", card)
	}
	// 正确验卡
	got, err := VerifyCard(db, card.CardID, card.Secret)
	if err != nil {
		t.Fatalf("VerifyCard valid: %v", err)
	}
	if got.CardID != card.CardID {
		t.Fatalf("mismatch id")
	}
	// 错密钥
	if _, err := VerifyCard(db, card.CardID, "wrong"); err == nil {
		t.Fatal("expected error for wrong secret")
	}
	// 不存在
	if _, err := VerifyCard(db, "nope", "x"); err == nil {
		t.Fatal("expected error for missing card")
	}
}

func TestExpiredCard(t *testing.T) {
	db := newTestDB(t)
	// 直接插一张已过期的卡
	et := time.Now().Add(-1 * time.Hour)
	_, err := db.Exec(`INSERT INTO cards (card_id,secret,quota,perm_group,prefixes,expires_at,created_at,revoked)
		VALUES (?,?,?,?,?,?,?,0)`, "exp", "k", 10, "guest", "/pub/", et, time.Now())
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	if _, err := VerifyCard(db, "exp", "k"); err == nil {
		t.Fatal("expected expired error")
	}
}

func TestConsumeQuota(t *testing.T) {
	db := newTestDB(t)
	days := 0
	c, _ := CreateCard(db, 2, "guest", []string{"/pub/"}, nil, &days)
	if _, err := ConsumeQuota(db, c.CardID); err != nil {
		t.Fatalf("consume1: %v", err)
	}
	if _, err := ConsumeQuota(db, c.CardID); err != nil {
		t.Fatalf("consume2: %v", err)
	}
	if _, err := ConsumeQuota(db, c.CardID); err == nil {
		t.Fatal("expected error after quota exhausted")
	}
}

func TestCardAllowed(t *testing.T) {
	c := &Card{Prefixes: []string{"/pub/", "/share/"}}
	if !c.Allowed("/pub/a.txt") {
		t.Fatal("should allow /pub/a.txt")
	}
	if !c.Allowed("/pub") {
		t.Fatal("should allow bare /pub")
	}
	if !c.Allowed("/share/docs/x.bin") {
		t.Fatal("should allow /share path")
	}
	if c.Allowed("/exclusive/secret.bin") {
		t.Fatal("should DENY /exclusive for member card")
	}
	if c.Allowed("/gateway.rs") {
		t.Fatal("should deny unrelated")
	}
}

func TestRevokeCard(t *testing.T) {
	db := newTestDB(t)
	c, _ := CreateCard(db, 3, "vip", []string{"/pub/"}, nil, nil)
	if err := RevokeCard(db, c.CardID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := VerifyCard(db, c.CardID, c.Secret); err == nil {
		t.Fatal("expected revoked error")
	}
}

func TestPermanentCard(t *testing.T) {
	db := newTestDB(t)
	c, err := CreateCard(db, 1, "guest", []string{"/pub/"}, nil, nil)
	if err != nil {
		t.Fatalf("CreateCard: %v", err)
	}
	if c.ExpiresAt != nil {
		t.Fatalf("permanent card should have nil expires")
	}
	if _, err := VerifyCard(db, c.CardID, c.Secret); err != nil {
		t.Fatalf("verify permanent: %v", err)
	}
}

func TestResourceBoundCard(t *testing.T) {
	db := newTestDB(t)
	// 卡绑定两个具体资源
	c, err := CreateCard(db, 2, "member", nil, []string{"pub/a.zip", "pub/说明.txt"}, nil)
	if err != nil {
		t.Fatalf("CreateCard: %v", err)
	}
	if len(c.Resources) != 2 {
		t.Fatalf("expected 2 resources, got %v", c.Resources)
	}
	// 验卡正常
	got, err := VerifyCard(db, c.CardID, c.Secret)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !got.HasResource("/pub/a.zip") {
		t.Fatal("should have /pub/a.zip")
	}
	if !got.HasResource("/pub/说明.txt") {
		t.Fatal("should have /pub/说明.txt")
	}
	if got.HasResource("/pub/other.zip") {
		t.Fatal("should NOT have /pub/other.zip (unbound)")
	}
	// 绑定资源卡的 Allowed 前缀为空(旧逻辑不适用)
	if got.Allowed("/pub/a.zip") {
		t.Fatal("resource-bound card should not use prefix Allow")
	}
}

func TestResourceBoundDownloadCheck(t *testing.T) {
	db := newTestDB(t)
	c, _ := CreateCard(db, 1, "member", nil, []string{"pub/only.zip"}, nil)
	vs, _ := VerifyCard(db, c.CardID, c.Secret)
	// 精确下载校验
	if !vs.HasResource("/pub/only.zip") {
		t.Fatal("should allow own resource")
	}
	if vs.HasResource("/pub/other.zip") {
		t.Fatal("should deny unbound resource")
	}
}

// TestOpenDBMigration: 旧表(无 resources 列)自动升级到新 schema
func TestOpenDBMigration(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/migrate.db"
	// 建一个没有 resources 列的旧表
	oldDB, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open old db: %v", err)
	}
	_, err = oldDB.Exec(`CREATE TABLE cards (
		card_id TEXT PRIMARY KEY, secret TEXT NOT NULL, quota INTEGER NOT NULL,
		perm_group TEXT NOT NULL DEFAULT '', prefixes TEXT NOT NULL DEFAULT '',
		expires_at DATETIME, created_at DATETIME NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`)
	if err != nil {
		oldDB.Close()
		t.Fatalf("create old table: %v", err)
	}
	oldDB.Close()

	// 用 openDB 打开应自动加 resources 列
	db, err := openDB(path)
	if err != nil {
		t.Fatalf("openDB migrate: %v", err)
	}
	defer db.Close()
	// 升级后应能用 resources 字段创建/查询资源卡
	c, err := CreateCard(db, 2, "member", nil, []string{"pub/x.zip"}, nil)
	if err != nil {
		t.Fatalf("CreateCard after migrate: %v", err)
	}
	got, err := VerifyCard(db, c.CardID, c.Secret)
	if err != nil {
		t.Fatalf("verify after migrate: %v", err)
	}
	if !got.HasResource("pub/x.zip") {
		t.Fatal("resources not persisted after migration")
	}
}

var _ = os.DevNull
