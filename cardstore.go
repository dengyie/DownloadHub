package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Card 一条卡密记录
type Card struct {
	CardID    string
	Secret    string
	Quota     int      // 剩余下载次数
	PermGroup string   // guest / member / vip (兼容旧卡)
	Prefixes  []string // 允许的资源路径前缀(旧模式,兼容)
	Resources []string // 绑定的具体资源路径列表(新模式)
	ExpiresAt *time.Time
	CreatedAt time.Time
	Revoked   bool
}

func openDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // sqlite 单写
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS cards (
		card_id    TEXT PRIMARY KEY,
		secret     TEXT NOT NULL,
		quota      INTEGER NOT NULL,
		perm_group TEXT NOT NULL DEFAULT '',
		prefixes   TEXT NOT NULL DEFAULT '',
		resources  TEXT NOT NULL DEFAULT '',
		expires_at DATETIME,
		created_at DATETIME NOT NULL,
		revoked    INTEGER NOT NULL DEFAULT 0
	)`)
	if err != nil {
		return nil, err
	}
	// 兼容旧表: 若 resources 列不存在则加(用 PRAGMA 检查避免对已存在列重复 ALTER 报错)
	var hasRes bool
	rows, err := db.Query(`PRAGMA table_info(cards)`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			rows.Close()
			return nil, err
		}
		if name == "resources" {
			hasRes = true
		}
	}
	rows.Close()
	if !hasRes {
		if _, err := db.Exec(`ALTER TABLE cards ADD COLUMN resources TEXT NOT NULL DEFAULT ''`); err != nil {
			return nil, err
		}
	}
	return db, nil
}

func randomSecret(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// CreateCard 生成一张新卡。resources 是具体资源路径列表(新模式), prefixes 是旧前缀权限模式(兼容)。
// 建议: 新卡用 resources, 旧卡可继续用 prefixes。
func CreateCard(db *sql.DB, quota int, permGroup string, prefixes []string, resources []string, ttlDays *int) (*Card, error) {
	card := &Card{
		CardID:    randomSecret(4),
		Secret:    randomSecret(8),
		Quota:     quota,
		PermGroup: permGroup,
		Prefixes:  prefixes,
		Resources: resources,
		CreatedAt: time.Now(),
	}
	if ttlDays != nil {
		et := time.Now().Add(time.Duration(*ttlDays) * 24 * time.Hour)
		card.ExpiresAt = &et
	}
	_, err := db.Exec(`INSERT INTO cards
		(card_id, secret, quota, perm_group, prefixes, resources, expires_at, created_at, revoked)
		VALUES (?,?,?,?,?,?,?,?,0)`,
		card.CardID, card.Secret, card.Quota, card.PermGroup,
		strings.Join(card.Prefixes, ","),
		strings.Join(card.Resources, ","),
		card.ExpiresAt, card.CreatedAt)
	if err != nil {
		return nil, err
	}
	return card, nil
}

// VerifyCard 校验卡密,成功返回卡,失败返回错误
func VerifyCard(db *sql.DB, cardID, secret string) (*Card, error) {
	var c Card
	var exp sql.NullTime
	var prefixes, resources string
	row := db.QueryRow(`SELECT card_id, secret, quota, perm_group, prefixes, resources, expires_at, created_at, revoked
		FROM cards WHERE card_id = ?`, cardID)
	if err := row.Scan(&c.CardID, &c.Secret, &c.Quota, &c.PermGroup,
		&prefixes, &resources, &exp, &c.CreatedAt, &c.Revoked); err != nil {
		if err == sql.ErrNoRows {
			return nil, errors.New("卡号不存在")
		}
		return nil, err
	}
	c.Prefixes = splitNonEmpty(prefixes, ",")
	c.Resources = splitNonEmpty(resources, ",")
	if exp.Valid {
		t := exp.Time
		c.ExpiresAt = &t
	}
	if c.Revoked {
		return nil, errors.New("卡已被吊销")
	}
	if c.Secret != secret {
		return nil, errors.New("卡密钥错误")
	}
	if c.Quota <= 0 {
		return nil, errors.New("次数已用完")
	}
	if c.ExpiresAt != nil && time.Now().After(*c.ExpiresAt) {
		return nil, errors.New("卡已过期")
	}
	return &c, nil
}

// ConsumeQuota 扣一次次数,返回更新后的剩余
func ConsumeQuota(db *sql.DB, cardID string) (int, error) {
	res, err := db.Exec(`UPDATE cards SET quota = quota - 1 WHERE card_id = ? AND quota > 0`, cardID)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	if n == 0 {
		return 0, errors.New("次数已用完")
	}
	var left int
	if err := db.QueryRow(`SELECT quota FROM cards WHERE card_id = ?`, cardID).Scan(&left); err != nil {
		return 0, err
	}
	return left, nil
}

// Allowed 判断路径是否在卡的允许前缀内(旧模式,兼容)
func (c *Card) Allowed(path string) bool {
	for _, p := range c.Prefixes {
		trimmed := strings.TrimSuffix(p, "/")
		if path == trimmed {
			return true
		}
		if strings.HasPrefix(path, trimmed+"/") {
			return true
		}
	}
	return false
}

// normalizeResource 规范化资源路径: 去首尾斜杠, 统一比较基准 ("pub/a.zip" == "/pub/a.zip/")
func normalizeResource(p string) string {
	p = strings.TrimSpace(p)
	p = strings.TrimPrefix(p, "/")
	return strings.TrimSuffix(p, "/")
}

// HasResource 检查卡是否绑定了该资源路径(新模式,路径规范化比较)
func (c *Card) HasResource(resource string) bool {
	norm := normalizeResource(resource)
	for _, r := range c.Resources {
		if normalizeResource(r) == norm {
			return true
		}
	}
	return false
}

// RevokeCard 吊销卡
func RevokeCard(db *sql.DB, cardID string) error {
	res, err := db.Exec(`UPDATE cards SET revoked = 1 WHERE card_id = ?`, cardID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("卡号不存在")
	}
	return nil
}

// ListCards 列出所有卡
func ListCards(db *sql.DB) ([]Card, error) {
	rows, err := db.Query(`SELECT card_id, secret, quota, perm_group, prefixes, resources, expires_at, created_at, revoked FROM cards ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Card
	for rows.Next() {
		var c Card
		var exp sql.NullTime
		var prefixes, resources string
		if err := rows.Scan(&c.CardID, &c.Secret, &c.Quota, &c.PermGroup,
			&prefixes, &resources, &exp, &c.CreatedAt, &c.Revoked); err != nil {
			return nil, err
		}
		c.Prefixes = splitNonEmpty(prefixes, ",")
		c.Resources = splitNonEmpty(resources, ",")
		if exp.Valid {
			t := exp.Time
			c.ExpiresAt = &t
		}
		out = append(out, c)
	}
	return out, nil
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
	return fmt.Sprintf("card=%s quota=%d group=%s prefixes=%v", c.CardID, c.Quota, c.PermGroup, c.Prefixes)
}
