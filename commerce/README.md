# Commerce SQLite overlay

## Migration

`migrate.php` reads live MySQL `information_schema` and creates one private SQLite file per non-system database, including empty databases. Run with the same PHP SQLite/BCMath runtime used by the storefront:

```sh
php commerce/migrate.php --defaults-file=/private/mysql-client.cnf --output-dir=/private/new-export
php commerce/tests/migration.php /private/new-export/acg_faka.sqlite
```

The MySQL client file must contain a `[client]` section with `host`, `port`, `user`, and `password`; use the existing read-only backup account. Neither credentials nor row data are logged. The output directory must not exist; database files use exclusive creation and mode `0600`. Failed exports are not valid cutover artifacts. The migrator requires `overlay/kernel/Database/DecimalStorage.php` beside it.

Each export preserves actual columns, defaults, primary/unique/index keys, foreign keys and actions, nullability, numeric ranges, auto-increment high-water marks and rows. It rejects unsupported views, generated columns, source CHECK constraints, triggers, routines, events, prefix/expression/non-BTREE indexes, cross-database foreign keys, and out-of-range integers. Every table is reconciled by a canonical typed full-row SHA-256 stream and row count; the final manifest is written only after all databases pass referential and SQLite integrity checks. Monetary values retain NUMERIC affinity and original scale. Atomic storage triggers use the application's BCMath-backed `decimal_round` function, because this PHP SQLite runtime's built-in `round(1.005,2)` returns `1.00`. Every writer must register that function; ordinary read-only backup integrity checks need no custom function. Values outside the original numeric range are rejected before normalization.

MySQL case-insensitive text columns map to SQLite `NOCASE`, which folds ASCII only. Unicode accent/case folding and trailing-space equality differ; the manifest reports affected text and unique-key value counts without exposing values. The 2026-10-02 rehearsal found no non-ASCII or trailing-space values in unique keys across all 13 databases. Newly entered Unicode values follow SQLite semantics. This is a deliberate limitation, not a claim of MySQL collation equivalence.

A normal rehearsal reads InnoDB from one consistent read-only snapshot; MyISAM cannot participate in that snapshot. **Final cutover requires all storefront writes stopped**, a separate recoverable MySQL backup, then a fresh export with `--quiesced` (an operator attestation recorded in the manifest, not an automatic write lock). Do not deploy a non-quiesced rehearsal. The active database contains two MyISAM tables (`acg_config`, `acg_manage_log`). Preserve all exported databases and the original MySQL backup/datadir; switch only the active storefront database to its private configured path. Once SQLite accepts writes, restoring an old MySQL snapshot loses those writes and is not a safe rollback.

The schema test loads DDL into an in-memory database, never copies or changes customer records. It validates positive/negative half-cent rounding, three-decimal payment rates, maximum balance precision, overflow and unsigned rejection, numeric sorting, mandatory fields, ASCII uniqueness, foreign-key rejection, trigger rollback, and integrity.

## Runtime and deployment

The HTTP and CLI entry points share `Kernel\Database\Bootstrap`. Outer transactions acquire `BEGIN IMMEDIATE` before reading mutable balances/inventory; nested transactions use Illuminate savepoints. Busy writers wait at most 5 seconds. Existing callbacks use one transaction attempt: do not add transaction retries around payment or fulfillment side effects. Connections are nonpersistent, use a 2 MiB page cache, WAL, `synchronous=FULL` and foreign-key enforcement. The database must already exist in WAL mode; a bad path cannot silently create an empty shop.

The original MySQL installer is not a SQLite installer. Existing installation locks remain in place. Upstream extension install/update/uninstall and automatic application updates are rejected before filesystem changes: those packages can contain MySQL DDL or overwrite this overlay. Deploy reviewed SQLite-compatible packages through the release process. There are no installed external payment plugins or shared fulfillment products at this cutover. If remote fulfillment is enabled later, its network call currently holds the write transaction and must be evaluated against the 5-second competing-write timeout.

Run the complete regression suite from a clean checkout with PHP 8.2, Python 3 and the PHP extensions `bcmath`, `pdo_sqlite`, `sqlite3`, `mbstring`, `curl`, `gd`, `zip` and `openssl`:

```sh
make check-php
# Included in the same checks required by CI:
make check
# If PHP is installed outside PATH:
PHP=/path/to/php make check-php
```

The runner downloads the public `lizhipay/acg-faka` source at commit `a4cf9eb4dd9a41ca663689fde0f52bfa7478e716`, verifies its SHA-256 and builds a fresh private temporary application for every run. This exact upstream version matches the reviewed production PHP source. Its bundled vendor tree is covered by the archive hash; installed package versions and source/dist references are additionally checked against the tracked `tests/fixtures/composer.lock` (Illuminate 7.30.6). No Composer update, install scripts, private repository, server login, production vendor directory or customer database is needed. The first run requires access to the pinned GitHub archive; later runs use the verified download cache (`COMMERCE_TEST_CACHE` can select its directory). No application fixture or generated database is reused.

`tests/fixtures/schema.sql` contains only the migrated 29-table DDL, indexes and decimal triggers. It has no customer records, sequence values or secrets. The runner checks its hash, validates the schema and asserts every table is empty before tests create synthetic data. Tests never load a production config or contact a payment provider. All six suites (transactions, billing, migration, orders, card deletion and storefront bootstrap) run on every `make check` and CI run; a missing PHP runtime or extension fails the checks instead of silently skipping them. Temporary applications and schema databases are removed after success or failure. The migration test can also validate a separately exported schema with `php commerce/tests/migration.php /private/new-export/acg_faka.sqlite`; it copies DDL only into memory and does not read customer rows.

## Standalone storefront API

`GET/HEAD /user/api/storefront/bootstrap` projects only public site/authentication settings and `{id, username, avatar, balance, group_name}` for the current user, or `null` for a visitor. It retains the existing Waf/UserVisitor interceptors, business-subdomain branding and customer session. Responses use `Cache-Control: no-store`; HEAD has no response body. Config records, password hashes, payment credentials, JWT/session tokens and administrator fields are never serialized.

The independently built UI uses the existing product/price/stock/payment/order/authentication APIs; custom checkout widgets remain top-level form fields, while SKU fields keep PHP bracket notation. Only order numbers may appear in a query URL; contacts, query passwords, card credentials and retrieved secrets remain in memory and POST bodies. No trade request is automatically retried. See [the interface map](../docs/frontend-architecture.md).

The added `Storefront.php` and `StorefrontPayload.php` entries in `release-baseline.json` use `null` for the historical pre-UI deployment. If a target already contains them (including another UI release), the gate intentionally fails. Review that target and its prior release evidence, then explicitly pin the correct hashes before a source-only release; never replace the baseline from an unreviewed live tree or rerun the historical MySQL cutover.

`source-baseline.json` pins the reviewed upstream PHP hashes; `null` denotes a new file that must not already exist. `deploy.py` is the one-time pxed migration runner, not a recurring deploy command. It checks those hashes and syntax before stopping the storefront, backs up MySQL and application files, performs a quiesced migration, creates `/var/lib/acg-faka/shop.sqlite`, applies the overlay, verifies a complete SQLite backup, then starts the storefront. It rejects a second run once the destination exists. The operator must retire the MySQL services after verifying there are no other consumers. Original data and cutover exports remain archived.

For later code releases, hash-check the currently deployed overlay, preserve a fresh SQLite backup and apply only reviewed files; never run the original one-time migration again. Once the storefront has accepted SQLite writes, restoring the old MySQL backup is not a rollback: it discards new business data. Repair the current SQLite deployment or explicitly reconcile all post-cutover writes.

## Settlement, stock retries and notification delivery

`ImmediateConnection` owns SQLite transaction recovery. After a failed statement it checks whether SQLite still has the transaction; automatic rollback discards the connection and invalidates enclosing callbacks. The original exception is preserved, a caught inner failure cannot accidentally commit outer work, and the next independent transaction reconnects. Ordinary savepoint rollbacks remain local. Callback bodies are never retried automatically.

Local balance/free purchases abort their transaction if matching stock is unavailable. A valid external payment is recorded as paid with `delivery_status=0` and an empty secret until matching stock is available. `retryDelivery` only allocates inventory and changes delivery state; it never repeats payment totals, debits, commissions or payment hooks. Paid pending selected-card references cannot be removed through either administrator or merchant card deletion. A sold/deleted selection never silently falls back to another card.

The `commerce-maintenance` application worker processes at most 20 pending local orders and 20 due notices per batch, then exits PHP and waits 60 seconds. PHP uses `memory_limit=64M`; this is a PHP allocation limit, not a whole-host RSS guarantee. An exhausted order gets a future retry time so it cannot monopolize the batch. Only the original product/race/SKU is eligible. To explicitly replace a pending selected card (IDs below are examples):

```sh
chroot --userspec=33:33 /srv/acg-rootfs php /var/www/html/bin/commerce-maintenance.php --retry-order=123 --replacement-card=456
```

Exit 0 means delivered (including an already delivered order), 3 means matching inventory remains unavailable, and 1 means the operation failed. Replacement must match the product and variant. Run without `--replacement-card` to retry the existing selection. The worker automatically retries ordinary stock shortages after replenishment.

Actual delivery enqueues one `order_notification` row in the same transaction, including manual fulfillment. SMTP runs in a separate process after commit with no transaction held. Failed notices remain queued with exponential backoff (60 seconds to 1 hour), and a 5-minute lease allows recovery after process death. SMTP provides no atomic transaction with SQLite: a crash after successful SMTP submission but before acknowledgement may send the same notice again. It cannot reallocate stock or repeat financial writes. Notification rows store order IDs and scheduling state, not duplicate card secrets. Worker logs contain aggregate counts and safe error classes.

## Source-only releases after the SQLite cutover

`release.py` checks every overlay file against `release-baseline.json`, lints PHP and shell, checks SQLite integrity and validates worker configuration before stopping application writers. The baseline in this commit describes the preceding reviewed deployment; a later release must deliberately update it from the previous release's verified source hashes. A drift or unexpected file is a hard failure, never an automatic overwrite.

Extract the reviewed `commerce/` package below `/srv/acg-rootfs/tmp/` and run:

```sh
python3 /srv/acg-rootfs/tmp/RELEASE/commerce/release.py --release-dir /root/cardgw/releases/RELEASE --preflight-only
python3 /srv/acg-rootfs/tmp/RELEASE/commerce/release.py --release-dir /root/cardgw/releases/RELEASE
```

Use a new release directory. The release stops only the storefront, this maintenance worker if running, and download backup; saves a full configured backup plus an independent SQLite snapshot; atomically installs source; applies additive `CommerceSchema`; starts the storefront and maintenance worker; restores backup service even if another service fails. New app directories remain traversable despite private evidence permissions. Only the named worker is updated in Supervisor. Its script/configuration and this release’s evidence directory are added to the recurring backup inventory before the backup service resumes. The database is never restored. Before the storefront can accept requests, failed deployment restores source only; after a start attempt, failures require forward repair because requests may already have written data.

Do not run `deploy.py` again: it is exclusively the historical MySQL cutover. The former MySQL logrotate implementation and test have been removed from this repository; the stopped legacy service is not restarted by releases.
