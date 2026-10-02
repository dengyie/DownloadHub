# Storefront SQLite release — 2026-10-02

The existing acg-faka storefront now runs on SQLite. Cardgw remains version `329679d` and OpenList retains its existing database. No host memory, OOM, mount or unrelated service settings were changed.

## Production state

- Application: `/srv/acg-rootfs/var/www/html`; Apache Supervisor `acg-faka`.
- Database: host `/srv/acg-rootfs/var/lib/acg-faka/shop.sqlite`, chroot `/var/lib/acg-faka/shop.sqlite`; mode 0600, www-data owner, outside document root. Initial live size 667,648 bytes (~652 KiB).
- Original MySQL datadir `/data/mysql-restored-20261001` remains preserved. MySQL and `download-logrotate` are stopped with autostart/autorestart disabled. Port 3306 has no listener.
- Quiesced export: `/srv/acg-rootfs/var/lib/acg-faka/mysql-export-20261002`; all 13 databases, 140 tables, 354 rows preserved, full-row typed reconciliation and FK/integrity checks passed. Active `acg_faka`: 29 tables, 138 rows, 21 foreign keys. Existing orders, recharge orders, users and card inventory were empty; the administrator and configuration rows were preserved.
- Release evidence and original overlay/config: `/root/cardgw/releases/20261002-sqlite-cutover`.
- Final MySQL snapshot: `snapshot-20261002T084903545398-grnhxs`; pre-open SQLite snapshot: `snapshot-20261002T084922497455-jkk234`; verified ongoing SQLite snapshot after retiring MySQL: `snapshot-20261002T085232240706-3t8rg5`. All below `/personal/pxed/backups/download/snapshots`, mode-restricted, retained 28 snapshots at six-hour intervals.
- Snapshot config now backs up cardgw, OpenList and commerce via SQLite's backup API, plus application files, archives and release evidence. There is no recurring MySQL dump.

The final cutover took place around 16:49 CST. Homepage and administrator login returned HTTP 200 with expected page content from Apache; the public homepage and `/redeem` also returned 200. Cardgw health returned `ok` / `329679d`. Authenticated administrator login/session, dashboard HTML and dashboard JSON were verified in the isolated full application using a dedicated fixture; production administrator credentials were not altered.

## Correctness and verification

- Real native PDO reproduced the manual-BEGIN tracking failure. The adapter tracks immediate outer transactions so Illuminate's PDO commit/rollback and savepoints operate correctly.
- Real tests passed for commit-time FK failure rollback, nested savepoints, lock contention before callback execution, bounded busy timeout, connection reuse, JSON extraction and invalid payment amounts.
- The original Bill implementation failed the stale-user regression. Updated Bill passed stale snapshots, exact balance exhaustion, nested credits, outer/inner rollback, ledger-insert failure, invalid amounts/currencies, overflow and repeated cent arithmetic.
- Against final migrated schema, real Order/Recharge services passed random inventory/JSON SKU/race, duplicate and concurrent callbacks, exactly-once delivery/accounting, fees, wrong amounts and inventory-write failure rollback. Payment provider signing and outbound hooks were isolated fixtures; no real payment was sent.
- Native SQLite `round(1.005,2)` produced `1.00`; shared BCMath storage normalization now produces `1.01`. Schema tests passed positive/negative half-cent rounding, three-decimal rates, maximum DECIMAL(14,2), numeric sorting, uniqueness, nullability, unsigned bounds and FK/rollback checks. Python backup integrity checks require no custom functions.
- Source hashes matched the original capture before deployment; all overlay PHP passed syntax checks. Both HTTP and CLI use the same adapter.

## Operational limits

SQLite removes the separate MySQL daemon. Immediately before retirement mysqld RSS was 103,820 KiB (~101 MiB). After retirement the four Apache processes had summed RSS of 53,600 KiB (shared pages counted repeatedly); this is a point-in-time measurement, not a whole-host memory limit or an OOM guarantee.

MySQL Unicode/accent/trailing-space collation is not reproduced: text uses SQLite ASCII NOCASE where the source was case-insensitive. Existing unique keys contained no non-ASCII or trailing-space values; newly entered Unicode keys follow SQLite semantics. Original MySQL plugin/automatic updates are gated before mutation; reviewed compatible releases are required. Remote fulfillment inside a write transaction remains a conditional contention risk if enabled; no shared products were configured at cutover.

Do not restore the old MySQL snapshot after SQLite has accepted writes. Preserve and repair the live SQLite state or reconcile newer writes explicitly. Backups and the old datadir are retained for recovery, not as an automatic fallback database.
