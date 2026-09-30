package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func limitedGrantCard(t *testing.T, db *sql.DB) *Card {
	t.Helper()
	paths := make([]string, 100)
	for i := range paths {
		paths[i] = fmt.Sprintf("private/file-%d", i)
	}
	c, err := CreateCard(db, 2, "member", nil, paths, nil)
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func fillGrantRows(t *testing.T, s *grantStore, c *Card, count int) {
	t.Helper()
	for count > 0 {
		n := min(count, len(c.Resources))
		if _, err := s.create(context.Background(), c, c.Resources[:n], time.Minute); err != nil {
			t.Fatal(err)
		}
		count -= n
	}
}
func TestGrantPerCardPendingLimit(t *testing.T) {
	s := &grantStore{newTestDB(t)}
	c := limitedGrantCard(t, s.db)
	first, err := s.create(context.Background(), c, c.Resources, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	fillGrantRows(t, s, c, 400)
	// Expired rows still occupy capacity until maintenance actually removes them.
	if _, err = s.db.Exec(`UPDATE grants SET credential_expires_at=? WHERE credential_hash<>?`, time.Now().Add(-time.Second).UnixMilli(), secretHash(first[0].Credential)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.create(context.Background(), c, c.Resources, time.Minute); err == nil {
		t.Fatal("created beyond 500 pending grants")
	}
	if _, err = s.acquire(context.Background(), first[0].Credential, time.Now(), time.Minute); err != nil {
		t.Fatalf("existing credential invalidated: %v", err)
	}
	if err = s.cleanup(context.Background(), time.Now(), 24*time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err = s.create(context.Background(), c, c.Resources, time.Minute); err != nil {
		t.Fatalf("capacity not recovered: %v", err)
	}
}
func TestGrantPendingLimitAcrossConnections(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db")
	a, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	c := limitedGrantCard(t, a)
	fillGrantRows(t, &grantStore{a}, c, 499)
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for _, db := range []*sql.DB{a, b} {
		wg.Add(1)
		go func(db *sql.DB) {
			defer wg.Done()
			<-start
			_, err := (&grantStore{db}).create(context.Background(), c, c.Resources[:1], time.Minute)
			results <- err
		}(db)
	}
	close(start)
	wg.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		} else if !errors.Is(err, ErrGrantLimit) {
			t.Fatalf("unexpected admission error: %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("admitted %d requests into one remaining slot", successes)
	}
	var n int
	if err = a.QueryRow(`SELECT count(*) FROM grants`).Scan(&n); err != nil || n != 500 {
		t.Fatalf("rows=%d err=%v", n, err)
	}
}
func TestGrantCleanupDrainsMultipleBatches(t *testing.T) {
	s := &grantStore{newTestDB(t)}
	for range 3 {
		c := limitedGrantCard(t, s.db)
		fillGrantRows(t, s, c, 400)
	}
	future := time.Now().Add(2 * time.Minute)
	if err := s.cleanup(context.Background(), future, 24*time.Hour); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM grants`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("cleanup left %d expired rows: %v", n, err)
	}
}

func TestGrantLimitHTTPMapping(t *testing.T) {
	w := httptest.NewRecorder()
	(&handler{}).fail(w, ErrGrantLimit)
	if w.Code != 429 || w.Header().Get("Retry-After") != "60" {
		t.Fatalf("status=%d headers=%v", w.Code, w.Header())
	}
}

func TestGrantCleanupCancellationKeepsRows(t *testing.T) {
	s := &grantStore{newTestDB(t)}
	c := limitedGrantCard(t, s.db)
	fillGrantRows(t, s, c, 100)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.cleanup(ctx, time.Now().Add(time.Hour), 24*time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation=%v", err)
	}
	var n int
	if err := s.db.QueryRow(`SELECT count(*) FROM grants`).Scan(&n); err != nil || n != 100 {
		t.Fatalf("rows=%d err=%v", n, err)
	}
}
