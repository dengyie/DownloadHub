package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
)

// backupDatabase never runs schema migration and never overwrites an existing backup.
func backupDatabase(ctx context.Context, source, destination string) error {
	source, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	destination, err = filepath.Abs(destination)
	if err != nil {
		return err
	}
	if source == destination {
		return fmt.Errorf("source and backup must differ")
	}
	if _, err = os.Stat(source); err != nil {
		return err
	}
	f, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	complete := false
	defer func() {
		if !complete {
			os.Remove(destination)
		}
	}()
	u := url.URL{Scheme: "file", Path: source}
	u.RawQuery = "mode=ro&_pragma=busy_timeout(2000)"
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return err
	}
	defer db.Close()
	if _, err = db.ExecContext(ctx, `VACUUM main INTO ?`, destination); err != nil {
		return err
	}
	u.Path = destination
	copyDB, err := sql.Open("sqlite", u.String())
	if err != nil {
		return err
	}
	defer copyDB.Close()
	var integrity string
	if err = copyDB.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&integrity); err != nil {
		return err
	}
	if integrity != "ok" {
		return fmt.Errorf("backup integrity check failed")
	}
	complete = true
	return nil
}
