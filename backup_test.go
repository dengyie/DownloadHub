package main

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestBackupLegacyWithoutMigrationAndNoOverwrite(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "old.db"), filepath.Join(dir, "snapshot.db")
	db, _ := sql.Open("sqlite", src)
	db.Exec(`CREATE TABLE cards(card_id TEXT, quota INTEGER); INSERT INTO cards VALUES('legacy',3)`)
	defer db.Close()
	if err := backupDatabase(context.Background(), src, dst); err != nil {
		t.Fatal(err)
	}
	var version int
	db.QueryRow(`PRAGMA user_version`).Scan(&version)
	if version != 0 {
		t.Fatal("backup migrated source")
	}
	copyDB, _ := sql.Open("sqlite", dst)
	defer copyDB.Close()
	var quota int
	copyDB.QueryRow(`SELECT quota FROM cards`).Scan(&quota)
	if quota != 3 {
		t.Fatal("bad snapshot")
	}
	if err := backupDatabase(context.Background(), src, dst); err == nil {
		t.Fatal("overwrote snapshot")
	}
	info, _ := os.Stat(dst)
	if info.Mode().Perm() != 0600 {
		t.Fatal(info.Mode())
	}
}
func TestBackupFailureRemovesOnlyOwnOutput(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "invalid"), filepath.Join(dir, "snapshot")
	os.WriteFile(src, []byte("not sqlite"), 0600)
	if err := backupDatabase(context.Background(), src, dst); err == nil {
		t.Fatal("invalid backed up")
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Fatal("partial snapshot left")
	}
}

func TestBackupIncludesUncheckpointedWAL(t *testing.T) {
	dir := t.TempDir()
	source, destination := filepath.Join(dir, "wal.db"), filepath.Join(dir, "snapshot.db")
	db, err := sql.Open("sqlite", source)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES('committed')`); err != nil {
		t.Fatal(err)
	}
	if err = backupDatabase(context.Background(), source, destination); err != nil {
		t.Fatal(err)
	}
	copyDB, err := sql.Open("sqlite", destination)
	if err != nil {
		t.Fatal(err)
	}
	defer copyDB.Close()
	var value string
	if err = copyDB.QueryRow(`SELECT value FROM sample`).Scan(&value); err != nil || value != "committed" {
		t.Fatal(value, err)
	}
}
