# Commerce review fixes — 2026-10-03

Status: deployed at approximately 09:01 CST on 2026-10-03. Application source is commit `f31a24a`; cardgw remains `329679d`.

## Root causes and changes

- SQLite automatic rollback could leave Illuminate at transaction depth 1. Later work appeared successful but was lost on disconnect. ImmediateConnection now preserves the original error, checks engine transaction state, invalidates uncertain sessions and enclosing callbacks, and reconnects for independent work. Ordinary savepoints still work; business callbacks are not replayed.
- Missing stock returned an apology as a delivered secret. External paid orders now remain paid/pending; local balance purchases roll back. Replenishment retries allocate once without repeating financial effects. Explicit selected-card replacement validates product/race/SKU; administrator and merchant deletion preserve unresolved selected references.
- Email could escape before the order committed. A transactional outbox records actual delivery and a bounded application worker sends afterward. Hook/commit failure leaves no notice. Send failures and stale leases retry only the notice. Manual deliveries also enqueue with their state change.
- PHP tests depended on live vendor/schema and never ran in CI. Five suites now use an immutable public source archive, exact 38-package lock verification and empty 29-table schema fixture. `make check-php` is required by `make check` and GitHub Actions.
- Removed confirmed retired MySQL logrotate source/config/test and unused Kernel import. Added source-only release checks, independent database backup, service recovery and new-directory permission regression coverage.

## Verification

- Fresh Go vet/race tests, 14 Node tests and Linux amd64 build passed.
- Eight Python tests passed (backup plus release source-drift/path/service-recovery/permissions checks).
- Five PHP suites cover automatic/nested/manual rollback, healthy savepoints, deferred commit failure, balances/ledger, schema constraints, competing paid orders, selected stock, balance rollback, outbox failure/backoff/lease recovery, real 64 MiB CLI migration/fulfillment, and both real card-deletion controllers.
- Local macOS has no PHP. PHP validation runs through a task-scoped chroot wrapper using the production PHP 8.2.33 / SQLite 3.46.1 runtime with a newly reconstructed public application; it does not load production vendor/config/customer data. GitHub Actions itself has not been run because this branch has not been pushed.

## Limits

SMTP delivery is at least once: a crash between SMTP success and acknowledgement can duplicate the same notice, never charge or allocate again. Remote shared fulfillment is unchanged and still holds the write transaction if enabled; no shared products were configured at cutover. The worker's 64 MiB setting limits PHP allocations, not total host memory. No host memory/OOM/mount settings are changed.

The live SQLite state must be preserved. Neither the old MySQL snapshot nor a pre-release SQLite copy is an automatic database rollback. Exact operator commands and release behavior are documented in `commerce/README.md`.

## Production evidence

- Release directory: `/root/cardgw/releases/20261003-commerce-review`; `source-hashes.json`, `final-verification.json` and `backup-verification.json` hold the exact checks.
- All 20 deployed PHP source hashes match the reviewed release. All original columns across 29 tables and 138 rows match the pre-release SQLite snapshot. The additive schema adds a notification table and indexed fulfillment retry time; database size is 679,936 bytes. Integrity and foreign-key checks pass.
- Pre-release production contained no orders or cards and no shared products. No customer card, payment or email was used for validation.
- Storefront, maintenance and download-backup are running. MySQL and its old logrotate service remain stopped. The only Supervisor include change adds `commerce-maintenance`; unrelated service configuration and host settings are unchanged.
- Source homepage and administrator login, public homepage and `/redeem` return HTTP 200 with expected content. Gateway health reports `ok` / `329679d`. Several maintenance batches reported zero failures; no new PHP fatal/SQLSTATE/SQLite lock/full error markers appeared in the checked application logs.
- Pre-release full backup: `snapshot-20261003T010132629015-c9a68n`. Post-release backup with the new worker script, worker configuration, application code, databases and release evidence: `snapshot-20261003T010853103448-353_9t`. Required archive entries were independently verified. Recurring 6-hour/28-snapshot backup remains active.
- Follow-up release-tool regression ensures new maintenance configuration and evidence join the recurring backup inventory without replacing existing settings; the backup worker was restarted to load that inventory. No application redeployment or database restore was needed.
- During initial Supervisor registration, a concurrent transition from STARTING to RUNNING caused an already-started response. The release checked actual running state and continued; subsequent status and batches verified the worker. This was not a failed application start.

This work was committed on the isolated feature branch; it was not merged or pushed. Temporary database/application review fixtures were removed. Primary worktree changes remain untouched.
