package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func grantFixture(t *testing.T) (*grantStore, string, *Card) {
	t.Helper()
	db := newTestDB(t)
	c, e := CreateCard(db, 1, "member", nil, []string{"private/a%20b.zip"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	s := &grantStore{db: db}
	items, e := s.create(context.Background(), c, []string{"private/a%20b.zip"}, time.Minute)
	if e != nil {
		t.Fatal(e)
	}
	return s, items[0].Credential, c
}
func TestGrantCleanupPreservesProcessing(t *testing.T) {
	s, key, _ := grantFixture(t)
	g, e := s.acquire(context.Background(), key, time.Now(), time.Minute)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.cleanup(context.Background(), time.Now(), 90*24*time.Hour); e != nil {
		t.Fatal(e)
	}
	if _, e = s.finish(context.Background(), g, "https://files.example/a", time.Now().Add(time.Minute), time.Now()); e != nil {
		t.Fatal(e)
	}
}
func TestGrantRevokedWhileBackendPending(t *testing.T) {
	s, key, c := grantFixture(t)
	g, _ := s.acquire(context.Background(), key, time.Now(), time.Minute)
	RevokeCard(s.db, c.CardID)
	if _, e := s.finish(context.Background(), g, "https://files.example/a", time.Now().Add(time.Minute), time.Now()); !errors.Is(e, ErrDenied) {
		t.Fatalf("revoked finish=%v", e)
	}
	got, _ := loadCard(s.db, c.CardID)
	if got.Quota != 1 {
		t.Fatal("charged revoked card")
	}
}
func TestGrantFencedLease(t *testing.T) {
	s, key, _ := grantFixture(t)
	now := time.Now()
	old, _ := s.acquire(context.Background(), key, now, time.Millisecond)
	newer, e := s.acquire(context.Background(), key, now.Add(time.Second), time.Minute)
	if e != nil {
		t.Fatal(e)
	}
	s.release(context.Background(), old)
	if _, e = s.finish(context.Background(), old, "https://files.example/a", now.Add(time.Minute), now.Add(time.Second)); !errors.Is(e, ErrBusy) {
		t.Fatal(e)
	}
	if _, e = s.finish(context.Background(), newer, "https://files.example/a", now.Add(time.Minute), now.Add(time.Second)); e != nil {
		t.Fatal(e)
	}
}
func TestGrantIssuedRecoveryWithZeroQuota(t *testing.T) {
	s, key, _ := grantFixture(t)
	g, _ := s.acquire(context.Background(), key, time.Now(), time.Minute)
	first, e := s.finish(context.Background(), g, "https://files.example/a", time.Now().Add(time.Minute), time.Now())
	if e != nil {
		t.Fatal(e)
	}
	again, e := s.acquire(context.Background(), key, time.Now(), time.Minute)
	if e != nil || again.State != "issued" || again.ID != first.ID || again.Quota != 0 {
		t.Fatalf("recovery=%+v %v", again, e)
	}
	var n int
	s.db.QueryRow(`SELECT count(*) FROM quota_events`).Scan(&n)
	if n != 1 {
		t.Fatal(n)
	}
}
func TestGrantConcurrentLastQuota(t *testing.T) {
	s, key, c := grantFixture(t)
	more, _ := s.create(context.Background(), c, []string{"private/a%20b.zip"}, time.Minute)
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	for _, k := range []string{key, more[0].Credential} {
		wg.Add(1)
		go func(k string) {
			defer wg.Done()
			g, e := s.acquire(context.Background(), k, time.Now(), time.Minute)
			if e == nil {
				_, e = s.finish(context.Background(), g, "https://files.example/a", time.Now().Add(time.Minute), time.Now())
			}
			if e == nil {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		}(k)
	}
	wg.Wait()
	if wins != 1 {
		t.Fatal(wins)
	}
}

func TestGrantAtomicDebitRollsBackWhenAuditWriteFails(t *testing.T) {
	s, key, c := grantFixture(t)
	g, err := s.acquire(context.Background(), key, time.Now(), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`CREATE TRIGGER audit_fail BEFORE INSERT ON quota_events BEGIN SELECT RAISE(ABORT,'injected storage failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.finish(context.Background(), g, "https://files.example/a", time.Now().Add(time.Minute), time.Now()); err == nil {
		t.Fatal("injected audit failure ignored")
	}
	got, _ := loadCard(s.db, c.CardID)
	if got.Quota != 1 {
		t.Fatal("partial debit committed")
	}
	var state string
	s.db.QueryRow(`SELECT state FROM grants WHERE id=?`, g.ID).Scan(&state)
	if state != "processing" {
		t.Fatal(state)
	}
	s.db.Exec(`DROP TRIGGER audit_fail`)
	if _, err = s.finish(context.Background(), g, "https://files.example/a", time.Now().Add(time.Minute), time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestGrantCrossConnectionSingleDebit(t *testing.T) {
	path := t.TempDir() + "/shared.db"
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
	c, err := CreateCard(a, 1, "member", nil, []string{"private/a"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	s := &grantStore{a}
	items, err := s.create(context.Background(), c, c.Resources, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	done := make(chan error, 2)
	for _, store := range []*grantStore{s, {b}} {
		go func(store *grantStore) {
			<-start
			g, e := store.acquire(context.Background(), items[0].Credential, time.Now(), time.Minute)
			if e == nil && g.State != "issued" {
				_, e = store.finish(context.Background(), g, "https://files.example/a", time.Now().Add(time.Minute), time.Now())
			}
			done <- e
		}(store)
	}
	close(start)
	for range 2 {
		if e := <-done; e != nil && !errors.Is(e, ErrBusy) {
			t.Fatal(e)
		}
	}
	var count int
	a.QueryRow(`SELECT count(*) FROM quota_events`).Scan(&count)
	if count != 1 {
		t.Fatal(count)
	}
	got, _ := loadCard(a, c.CardID)
	if got.Quota != 0 {
		t.Fatal(got.Quota)
	}
}
