# Commerce SQLite Implementation Plan

> **For agentic workers:** Execute task-by-task in the existing isolated worktree; use bounded independent reviews for financial correctness.

**Goal:** Run the existing download storefront on SQLite without removing order, balance, or payment functionality.

**Architecture:** Keep the existing PHP/Illuminate application. Register one SQLite connection with immediate outer write transactions and Laravel savepoints, migrate the actual production schema/data into a private database outside the document root, and deploy only hash-verified source changes. Cardgw and OpenList retain their existing separate SQLite databases.

**Tech Stack:** PHP 8, PDO SQLite, Illuminate Database 7.30.6, BCMath, Python SQLite backup API, Supervisor.

## Global Constraints

- Do not change host settings, unrelated services, or primary worktrees.
- No production write lock for tests; use a copied database and isolated PHP application.
- Money, passwords, card inventory, order IDs, settings and all legacy databases must be preserved and reconciled.
- Preserve MySQL cold/consistent backups. Do not switch back to an old snapshot after SQLite accepts business writes.
- No replay of transactions that may contain external payment requests.
- No plaintext credentials, customer data or generated database files in Git.

## Task 1: Transaction and financial correctness

Files: `commerce/overlay/kernel/Database/ImmediatePDO.php`, `Bootstrap.php`, HTTP/CLI bootstrap, Bill and Order/Recharge services; `commerce/tests/sqlite.php`.

- [x] Verify native PDO manual BEGIN/commit failure, then implement PDO-owned BEGIN IMMEDIATE/COMMIT/ROLLBACK state for Illuminate's transaction API and nested savepoints.
- [x] Configure busy timeout, private database path, WAL and FULL synchronous; disable persistent PDO.
- [x] Remove MySQL session isolation statements; replace RAND ordering with inRandomOrder; propagate failed inventory writes.
- [x] Use BCMath and a fresh transaction-local user balance for ledger writes. Verify 0.30−0.10−0.20, stale models, duplicate callback and rollback.
- [x] Run `php commerce/tests/sqlite.php` against the existing vendor runtime with two independent processes. Require one winner for competing final inventory/balance and bounded lock failure without transaction replay.

## Task 2: Complete schema/data migration

Files: `commerce/migrate.php`, `commerce/README.md`, migration evidence outside Git.

- [x] Export information_schema columns/indexes and rows using the existing PDO MySQL client to a new SQLite file only; reject unsupported generated columns, views, routines or triggers.
- [x] Preserve primary/unique keys, nullability, defaults, numeric ranges and decimal scales; do not use TEXT affinity for numeric monetary comparisons.
- [x] Normalize decimal storage and compare every row using canonical typed values; verify counts, indexes, quick_check and foreign_key_check. Abort on any mismatch.
- [x] Preserve all 13 databases; identify actual consumers before stopping MySQL.

## Task 3: Application/database rehearsal and cutover

Files: SQLite database config, tested overlays, `deploy/backup_snapshot.py` configuration, release evidence.

- [x] Rehearse with the full application/runtime in an isolated directory; verify homepage/admin API, ledger, orders, callback idempotency, JSON SKU filters and error paths.
- [x] Disable incompatible MySQL plugin SQL import before any plugin filesystem mutation; do not silently run old installers against another database.
- [x] Before cutover compare live PHP files with their captured hashes and stop on concurrent changes; take consistent backups, stop storefront writes, migrate the final snapshot, validate and switch configuration.
- [x] Restart only the storefront, verify source and public HTTP plus authenticated fixture flows, then resume writes. Keep original databases preserved.
- [x] Convert ongoing backup to SQLite backup API; retire MySQL-only worker/config only after proving there are no remaining consumers. Verify a complete new backup and measured process memory.
- [x] Record actual release, data reconciliation, tests, rollback boundary and remaining limitations in the existing release record and Obsidian canonical entry.

## Execution evidence

Completed 2026-10-02; actual release, tests, measurements and limits: [SQLite release](../../release-2026-10-02-sqlite.md). No push or merge performed.
