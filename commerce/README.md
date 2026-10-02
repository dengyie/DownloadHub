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

Run the tests with the production PHP/vendor runtime, using only an isolated application copy and disposable databases:

```sh
php -d error_reporting=24575 commerce/tests/sqlite.php
php -d error_reporting=24575 commerce/tests/bill.php
php commerce/tests/migration.php /private/export/acg_faka.sqlite
COMMERCE_TEST_APP=/tmp/sqlite-app COMMERCE_SCHEMA_DB=/private/export/acg_faka.sqlite php -d error_reporting=24575 commerce/tests/orders.php
```

`source-baseline.json` pins the reviewed upstream PHP hashes; `null` denotes a new file that must not already exist. `deploy.py` is the one-time pxed migration runner, not a recurring deploy command. It checks those hashes and syntax before stopping the storefront, backs up MySQL and application files, performs a quiesced migration, creates `/var/lib/acg-faka/shop.sqlite`, applies the overlay, verifies a complete SQLite backup, then starts the storefront. It rejects a second run once the destination exists. The operator must retire the MySQL services after verifying there are no other consumers. Original data and cutover exports remain archived.

For later code releases, hash-check the currently deployed overlay, preserve a fresh SQLite backup and apply only reviewed files; never run the original one-time migration again. Once the storefront has accepted SQLite writes, restoring the old MySQL backup is not a rollback: it discards new business data. Repair the current SQLite deployment or explicitly reconcile all post-cutover writes.
