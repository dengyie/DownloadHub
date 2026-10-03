# Commerce review fixes — 2026-10-03

Status: implementation and regression checks complete; production release pending final preflight.

## Root causes and changes

- SQLite automatic rollback could leave Illuminate at transaction depth 1. Later work appeared successful but was lost on disconnect. ImmediateConnection now preserves the original error, checks engine transaction state, invalidates uncertain sessions and enclosing callbacks, and reconnects for independent work. Ordinary savepoints still work; business callbacks are not replayed.
- Missing stock returned an apology as a delivered secret. External paid orders now remain paid/pending; local balance purchases roll back. Replenishment retries allocate once without repeating financial effects. Explicit selected-card replacement validates product/race/SKU; administrator and merchant deletion preserve unresolved selected references.
- Email could escape before the order committed. A transactional outbox records actual delivery and a bounded application worker sends afterward. Hook/commit failure leaves no notice. Send failures and stale leases retry only the notice. Manual deliveries also enqueue with their state change.
- PHP tests depended on live vendor/schema and never ran in CI. Five suites now use an immutable public source archive, exact 38-package lock verification and empty 29-table schema fixture. `make check-php` is required by `make check` and GitHub Actions.
- Removed confirmed retired MySQL logrotate source/config/test and unused Kernel import. Added source-only release checks, independent database backup, service recovery and new-directory permission regression coverage.

## Verification

- Fresh Go vet/race tests, 14 Node tests and Linux amd64 build passed.
- Seven Python tests passed (backup plus release source-drift/path/service-recovery/permissions checks).
- Five PHP suites cover automatic/nested/manual rollback, healthy savepoints, deferred commit failure, balances/ledger, schema constraints, competing paid orders, selected stock, balance rollback, outbox failure/backoff/lease recovery, real 64 MiB CLI migration/fulfillment, and both real card-deletion controllers.
- Local macOS has no PHP. PHP validation runs through a task-scoped chroot wrapper using the production PHP 8.2.33 / SQLite 3.46.1 runtime with a newly reconstructed public application; it does not load production vendor/config/customer data. GitHub Actions itself has not been run because this branch has not been pushed.

## Limits

SMTP delivery is at least once: a crash between SMTP success and acknowledgement can duplicate the same notice, never charge or allocate again. Remote shared fulfillment is unchanged and still holds the write transaction if enabled; no shared products were configured at cutover. The worker's 64 MiB setting limits PHP allocations, not total host memory. No host memory/OOM/mount settings are changed.

The live SQLite state must be preserved. Neither the old MySQL snapshot nor a pre-release SQLite copy is an automatic database rollback. Exact operator commands and release behavior are documented in `commerce/README.md`.
