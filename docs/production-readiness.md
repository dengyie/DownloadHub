# Production readiness and release procedure

## Status and evidence boundary

The gateway is deployed at `329679d`, schema 1. **Operational stability is not
fully accepted:** MySQL has experienced repeated SIGKILLs under host memory pressure. CDN asset
byte verification has passed; the dedicated storefront Apache pool is now bounded
to 16 workers with 2–3 idle workers. Host configuration remains unchanged. See [the current release record](release-2026-10-01.md).
The inventory table below is the historical pre-release baseline, not the current
status of every gate. Dedicated disposable acceptance cards were created/revoked;
no pre-existing customer card was consumed. MySQL was recovered to a clean datadir,
OpenList and nginx configuration were updated, and persistent backups are running.

Read-only inventory: 2026-09-30, through the existing `ssh pxed` alias. Authority:
Obsidian **下载站项目总览**, specifically its 2026-09-29 pxed migration record.
Older xinyun/systemd commands in that note are historical, not this deployment.
Credentials were read only inside the remote process when needed; none are included here.

| Gate | Observed evidence | Remaining release requirement |
|---|---|---|
| V1 runtime and revision | Supervisor runs `/root/cardgw/cardgw serve -config /root/cardgw/config.yaml`; directory contains only binary, configuration and DB. Binary SHA256 `f97e6fba994bc988f63f1bbdd7e234fd6e136a4e7fcd008c9890ac45c791d9f4`. | Exact source revision cannot be established. Preserve this binary and record the new revision/build digest. |
| V2 authorization boundary | nginx aliases `/pub/` to `/data/share/pub/`, publicly cached for 86400 seconds. The only card binds `pub/manual.txt`. An unauthenticated local HEAD with the production Host returns 200. | Owner must classify this file as public/sample or protected. Do not silently relocate it. A protected resource must leave all public aliases and caches before selling access. |
| V3 signer contract | OpenList local storage `/` maps to `/srv/share`; `sign_all=true`, site URL empty. No expiry-related setting row found. Admin API request timed out. | Verify actual returned URL host, externally reachable path, signature lifetime and behavior after restart/credential rotation. Absence of a setting does not establish a default. Set `openlist_min_url_ttl_seconds` only after verification. |
| V4 database and compatibility | `/root/cardgw/cards.db` is on `overlay /`. One resource card, zero prefix-only cards, zero nonempty plaintext secrets; one unrevoked quota-positive card (expiration not included). Tokens: five unused, one used. | Confirm overlay persistence and backup restore. Prefix data has no current users, but a complete legacy URL observation window is absent. Any retirement must account for the existing card and previously distributed links. |
| V5 request boundary and logs | nginx gateway locations do not forward client IP. Main access log uses default format, not documented `download_safe`. Current ~1.69 MB log contains no `/dl/` request in aggregate scan. | Install and validate safe logging and the trusted-proxy chain. Zero downloads in this log does not prove legacy URL retirement. Existing logs may contain other sensitive queries; restrict and retire them under the retention policy without printing their contents. |
| V6 commerce dependency | acg-faka runs in `/srv/acg-rootfs` chroot. MySQL TCP 3306 refused multiple connections; supervisor later reported MySQL uptime 13 seconds versus roughly one day for other services. | Diagnose MySQL availability separately. Orders, payment configuration, active goods and enabled functions were not readable. This is why M5 remains a read-only inventory and acg-faka is retained. Do not remove commerce tables, Redis, MySQL or the application based on guessed usage. |
| V7 recovery | No download/cardgw/OpenList/acg-named backup found in `/personal/pxed/backups` or `/personal/pxed/config-backups`. | This limited search does not prove backups are absent elsewhere. Locate the authoritative backup job, confirm retention and perform isolated restore before release. |

Current supervisor definitions are under `/personal/pxed/supervisor-*.conf`.
nginx uses `/personal/pxed/nginx/nginx.conf` and `conf.d/download.conf`.
OpenList uses `/root/openlist/data`; original MySQL `/var/lib/mysql-dl` is retained for recovery. Current MySQL uses `/data/mysql-restored-20261001`.
Do not copy an old systemd or Docker deployment procedure to this host.

## Network and configuration contract

The accompanying `deploy/download-nginx.conf.example` is a **review template**, not
an automatically installable replacement for the host's complete nginx config.
It assumes Cloudflare Tunnel is the only ingress, forwarding to
`http://localhost:80` over IPv4/IPv6 loopback; direct public access to this listener is impossible because
it binds loopback. Audit other nginx listeners before relying on that condition.
Local processes are in the trusted computing boundary.

Only the IPv4/IPv6 loopback cloudflared peer may supply `CF-Connecting-IP`. nginx resolves
that address and overwrites `X-Real-IP` for cardgw. Cardgw binds
`127.0.0.1:8080` and trusts only `127.0.0.1/32` (and `::1/128` only if actually
used). Never configure `0.0.0.0/0`, trust arbitrary `X-Forwarded-For`, or expose
the cardgw port publicly. For direct Cloudflare HTTP ingress, use a separately
reviewed firewall and current official CF address ranges instead of this template.

Route only `/assets/redeem.js` and `/assets/redeem.css` to cardgw: acg-faka also
uses `/assets/`, so a broad replacement would break its images and scripts.
`/ready`, `/health` and `/metrics` are blocked at public ingress; probe cardgw
directly on loopback. There is currently no dedicated metrics endpoint: readiness
contains counters and DB status. Readiness does not prove OpenList availability.

Credentials belong in the restricted host config (mode 0600), never shell command
arguments, Git, copied logs or terminal output. Use `umask 077`; do not run
`set -x`, dump environments, or print raw signed URLs. Configuration now requires
verified URL lifetime and validates unknown keys. Review existing config before
switching binary. Keep `public_prefixes: ["pub/"]`; disabling this guard to retain
the public `manual.txt` card would conceal the boundary problem.

## Operator release checklist

1. Resolve V1–V7, particularly public-resource classification, signer lifetime,
   MySQL availability and restore evidence. Obtain a maintenance window and tell
   users about any legacy URL retirement. Do not silently revoke or migrate cards.
2. Run the repository's full Go race tests, vet, frontend tests and build checks.
   Build a Linux amd64 candidate with a revision in `-ldflags '-X main.version=…'`.
   Record candidate digest and configuration revision without credentials.
3. Rehearse on an isolated copy of the production SQLite snapshot. The new binary
   performs schema migration when opening the DB; even CLI commands must point to
   the rehearsal DB. Compare card/quota/resource aggregates, verify schema and
   `PRAGMA integrity_check`, and test recovery with disposable fixture cards only.
4. Prepare a maintenance nginx configuration that blocks `/api/` and `/dl/` with
   503 and `Retry-After`. Validate with the actual `nginx -t -c
   /personal/pxed/nginx/nginx.conf` before reload. Stop cardgw gracefully through
   `supervisorctl -c /personal/pxed/supervisord.conf stop cardgw`; also suspend CLI
   writers. Check it stopped before the final snapshot. Do not kill an active
   transaction to force the maintenance window shorter.
5. With restrictive permissions, take a SQLite-consistent backup using SQLite's
   backup API (Python `sqlite3.Connection.backup` is acceptable), not a live `cp`
   of the main file without WAL. Keep the pre-migration binary, config, DB,
   nginx/supervisor definitions and manifest together. Verify the backup's
   `integrity_check`, hashes and aggregate counts. Back up OpenList DB/config,
   resource files and the acg-faka data using each engine's consistent backup
   procedure; raw copying a running MySQL datadir is not a valid backup.
6. Stage the candidate separately, verify hash and executable permissions, then
   atomically switch the stopped service's binary. Install reviewed config and
   template changes. Start the single cardgw writer; verify version, loopback
   health/readiness, schema, migration result and card/quota counts before opening
   traffic. A failed migration must stop release; do not edit schema-version
   markers manually to bypass it.
7. Verify public `/redeem`, its exact asset routes, acg-faka assets and home page;
   verify public readiness/metrics are denied, `/files/` stays 404, unsigned `/p/`
   is denied, and private files have no `/pub/` alias. Check cache/no-referrer
   headers and confirm access logs omit query strings. Test trusted-client IP
   behavior from separate clients and reject spoofed headers at untrusted ingress.
8. Check signer/download behavior with a separately authorized disposable test
   resource/card; never reuse formal customer cards for repeated smoke tests.
   Confirm retry returns the same grant without another quota debit. Reopen traffic
   only after acceptance; monitor failures, backend latency and quota-event counts.

## Rollback and reconciliation

**Never start the old binary against the migrated database.** Old code can write
an incompatible schema even if a smoke test appears to work. Binary rollback and
database rollback are one operation, with all writers stopped.

Before traffic is reopened, a failed rehearsal/release may restore the verified
pre-migration snapshot and its matched binary/config. First archive the failed new
DB with its WAL state using a consistent snapshot for diagnosis. Restore into a
separate path, verify it, then switch while the process is stopped; do not leave
stale WAL/SHM files from the replaced DB attached to the restored file.

After traffic has been accepted, restoring the old snapshot loses new cards,
revocations, grants and quota changes. It can re-enable revoked access or give
quota back. Prefer a forward fix. If rollback is necessary, enter maintenance,
freeze all writers, snapshot both versions, reconcile quota events/card changes
and already issued authorizations, and obtain operator sign-off on the resulting
ledger before resuming. Previously delivered signed URLs may remain valid and
cannot be undone by restoring SQLite. Do not call an online snapshot restore a
zero-loss rollback.

Record final deployed digest, migration outcome, restore proof and any remaining
risks in the canonical operations documentation after an actual deployment.
