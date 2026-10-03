# Commerce transaction, fulfillment and notification fixes

> Execute each task with evidence-driven-bugfix and executing-plans. Independent transaction and CI tasks can run in parallel; review their changes before release.

**Goal:** Correct all four reproduced production review findings without changing host settings or replaying the MySQL cutover.

**Architecture:** SQLiteConnection owns framework and PDO transaction recovery. Settlement and fulfillment are separate: local purchases abort on shortage, external payments persist paid/pending and retry fulfillment without accounting. A transactional notification outbox is drained outside business transactions; a bounded application maintenance command retries pending stock and email.

**Constraints:** Preserve primary worktree changes, no production customer test writes, no real test emails/payments, no MySQL restart, no schema/data rollback after live writes. One attempt per business transaction. Keep existing overlay and dependencies pinned.

## 1. SQLite recovery

- [x] Convert SQLITE_FULL reproduction into outer/nested/manual regressions in `commerce/tests/sqlite.php`, requiring original SQLITE_FULL, nesting=0 and independent durability of a subsequent transaction.
- [x] Add connection-level failure cleanup in `commerce/overlay/kernel/Database`; ordinary savepoints still work, catastrophic inner failures cannot be swallowed to commit a partial outer transaction.
- [x] Run full SQLite suite including deferred commit failure and competing writers.

## 2. Fulfillment and email

- [x] Add regressions for two paid orders/one card, selected sold card, balance debit rollback, restock/retry accounting, hook/commit failure sending no email, send failure/retry without reallocating cards.
- [x] Change `Order::pullCardForLocal` to return explicit shortage; enforce card product/race/SKU and count constraints; initial settlement handles paid/pending separately from local charge rollback.
- [x] Add `Order::retryDelivery` for paid pending local orders with optional explicit replacement of a selected card; never repeat settlement hooks, charges, totals or commissions.
- [x] Add a notification table and `OrderNotification` service. Enqueue only actual delivered orders inside their transaction. Claim a bounded batch in a short transaction, send outside it, acknowledge using a lease token and back off failures. SMTP can deliver duplicate notifications after a crash; inventory/accounting must remain unchanged.
- [x] Add CLI maintenance command with bounded automatic stock retry, notification retry and explicit selected-card replacement. Supply a low-memory application worker; do not change host parameters.

## 3. Reproducible CI

- [x] Pin base application source/dependencies and schema-only DDL fixtures with no customer rows or configuration.
- [x] Make all PHP suites run from an isolated temporary application with PHP 8.2, SQLite and BCMath. Add to `make check` and GitHub CI; document the exact command.
- [x] Verify a clean test preparation with no production access; preserve fault injection tests as regression assertions.

## 4. Release

- [ ] Review final diff and run complete checks/build; retain confirmed dead MySQL-logrotate removals from the review.
- [ ] Add recurring source-only deployment with old/new hashes, fresh SQLite backup, preflight PHP syntax, stopped-storefront schema update and restart. Do not run `commerce/deploy.py` again.
- [ ] Deploy verified source, inspect HTTP/service/log/backup evidence, record any limitations and update the canonical Obsidian entry/plan/router/MOC.
