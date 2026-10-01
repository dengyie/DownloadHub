package main

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"time"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// Log only fixed categories and numeric codes: driver error strings may include SQL,
// resource names, filesystem paths, or credentials. Keep extended SQLite codes.
func logMaintenanceFailure(ctx context.Context, logger *slog.Logger, err error, elapsed time.Duration) {
	if err == nil || errors.Is(err, context.Canceled) ||
		(errors.Is(ctx.Err(), context.Canceled) && errors.Is(err, sql.ErrTxDone)) {
		return
	}
	kind := "unknown"
	attrs := []slog.Attr{slog.Int64("elapsed_ms", elapsed.Milliseconds())}
	var dbErr *sqlite.Error
	if errors.As(err, &dbErr) {
		kind = "sqlite"
		attrs = append(attrs, slog.Int("sqlite_code", dbErr.Code()))
		switch dbErr.Code() & 0xff {
		case sqlite3.SQLITE_BUSY:
			kind = "busy"
		case sqlite3.SQLITE_LOCKED:
			kind = "locked"
		case sqlite3.SQLITE_IOERR:
			kind = "io"
		case sqlite3.SQLITE_FULL:
			kind = "disk_full"
		case sqlite3.SQLITE_READONLY:
			kind = "readonly"
		case sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB:
			kind = "corrupt"
		case sqlite3.SQLITE_CANTOPEN, sqlite3.SQLITE_PERM:
			kind = "access"
		case sqlite3.SQLITE_CONSTRAINT:
			kind = "constraint"
		}
	}
	if errors.Is(err, context.DeadlineExceeded) ||
		(errors.Is(err, sql.ErrTxDone) && errors.Is(ctx.Err(), context.DeadlineExceeded)) {
		kind = "deadline"
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		attrs = append(attrs, slog.String("context_error", "deadline"))
	} else if errors.Is(ctx.Err(), context.Canceled) {
		attrs = append(attrs, slog.String("context_error", "canceled"))
	}
	attrs = append(attrs, slog.String("error_type", kind))
	logger.LogAttrs(ctx, slog.LevelError, "maintenance failed", attrs...)
}
