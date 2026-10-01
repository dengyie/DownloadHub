package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func maintenanceRecord(t *testing.T, ctx context.Context, err error) map[string]any {
	t.Helper()
	var output bytes.Buffer
	logMaintenanceFailure(ctx, slog.New(slog.NewJSONHandler(&output, nil)), err, 27*time.Millisecond)
	if strings.Contains(output.String(), "sensitive") {
		t.Fatalf("raw error leaked: %s", &output)
	}
	if output.Len() == 0 {
		return nil
	}
	var record map[string]any
	if e := json.Unmarshal(output.Bytes(), &record); e != nil {
		t.Fatal(e)
	}
	return record
}

func TestMaintenanceLogDeadlineAndCancellation(t *testing.T) {
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	// database/sql can surface ErrTxDone after context rollback, losing the cause.
	r := maintenanceRecord(t, ctx, fmt.Errorf("sensitive context: %w", sql.ErrTxDone))
	if r["error_type"] != "deadline" || r["elapsed_ms"] != float64(27) {
		t.Fatalf("missing deadline diagnostics: %v", r)
	}
	ctx, stop := context.WithCancel(context.Background())
	stop()
	if r := maintenanceRecord(t, ctx, context.Canceled); r != nil {
		t.Fatalf("shutdown reported as failure: %v", r)
	}
	if r := maintenanceRecord(t, context.Background(), nil); r != nil {
		t.Fatalf("success reported as failure: %v", r)
	}
	r = maintenanceRecord(t, context.Background(), errors.New("sensitive credential and SQL"))
	if r["error_type"] != "unknown" {
		t.Fatalf("unknown failure lost: %v", r)
	}
}

func TestMaintenanceLogRealSQLiteBusyAndRecovery(t *testing.T) {
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
	if _, err = b.Exec("PRAGMA busy_timeout=1"); err != nil {
		t.Fatal(err)
	}
	tx, err := a.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	err = (&grantStore{b}).cleanup(context.Background(), time.Now(), 24*time.Hour)
	if err == nil {
		t.Fatal("expected competing writer to block maintenance")
	}
	r := maintenanceRecord(t, context.Background(), fmt.Errorf("sensitive wrapper: %w", err))
	if r["error_type"] != "busy" || r["sqlite_code"] != float64(5) {
		t.Fatalf("lock failure not classified: %v", r)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err = (&grantStore{b}).cleanup(context.Background(), time.Now(), 24*time.Hour); err != nil {
		t.Fatalf("maintenance did not recover after lock release: %v", err)
	}
}

func TestMaintenanceLogSQLiteErrorDoesNotLeakQuery(t *testing.T) {
	db := newTestDB(t)
	_, err := db.Exec("SELECT * FROM sensitive_card_secret")
	r := maintenanceRecord(t, context.Background(), err)
	if r["error_type"] != "sqlite" || r["sqlite_code"] != float64(1) {
		t.Fatalf("SQLite code lost: %v", r)
	}
}
