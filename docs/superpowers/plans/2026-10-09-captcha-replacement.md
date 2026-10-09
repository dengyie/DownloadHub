# Xianyu-style CAPTCHA Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execute inline in the existing worktree; do not dispatch new agents.

**Goal:** Replace session-slot image captchas with independently identified, expiring, single-use challenges across the download site's active customer/admin flows.

**Architecture:** Port the protocol of `dengyie/xianyu-auto-bot@a2bfe978222a9f20940359b9d41cc6536b39ebc2` (`app/api/routers/login.py`, `static/login.html`) into PHP. Keep challenge state in a private, bounded, temporary SQLite database outside the document root; do not modify the commerce database. One dependency-free frontend controller pairs each PNG with its `X-Captcha-Id`, rejects stale loads and releases resources; both the SPA and active PHP pages use it.

**Tech Stack:** PHP 8.2 / PDO SQLite / GD; Vanilla ES modules; Node test runner / Playwright; existing nginx deployment.

## Global Constraints

- Work only in `/Users/mango/project/cardgw-ui-api`, branch `codex/download-ui-api`; primary main remains protected.
- UTF-8 without BOM; edits through apply_patch. No file deletion without individual user confirmation.
- Do not change xianyu, email/SMS business codes, SSO, administrator TOTP, payment or order semantics.
- No production credentials, customer DB, real orders or real payment tests. No migration replay.
- No User-Agent bypass, session fallback, new Python service or heavy UI dependency.
- Protocol: GET `/user/captcha/image?action=<scene>`, PNG 150×50, `X-Captcha-Id` (16 random bytes, base64url), no-store; POST `captcha_id` + `captcha_code`, four characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, case insensitive, 300 seconds.
- Retain challenge rate accounting until expiry even after consumption: 60 images/IP/300 seconds, 10,000 live records total; fail closed on unavailable storage. Any attempted answer for a matching scene/IP consumes that challenge atomically.
- The previously staged UI release is obsolete after these changes; build and verify a new candidate before activation.

## Evidence and root cause

- User-reported: correct visible captcha is rejected. No claim that one specific browser sequence is the user's only trigger.
- Reproduced using the pinned upstream fixture on isolated PHP 8.2: generating a second `login` image makes the first correct answer fail while the newest passes; stored `0000` fails unconditionally.
- Root cause: one mutable session value per scene plus integer answer conversion. The issuing request and visible image have no independent identity; client refresh also lacks response-order protection.
- Initial CLI reproduction exposed fixture session-handler differences; rerun explicitly used file sessions in its private temporary directory and a bounded loop. This was not a change to production PHP configuration.

## Task 1: Shared PHP challenge lifecycle

**Files:** Create `commerce/overlay/app/Util/CaptchaStore.php`, replace via overlay `app/Util/Captcha.php`, `app/Controller/User/Captcha.php`; test `commerce/tests/captcha.php`, register in `commerce/tests/run.py`.

**Interfaces:** `CaptchaStore(PDO $db)`, `issue(string $scene, string $ip, ?int $now = null): array{id:string,code:string}`, `consume(mixed $id, mixed $code, string $scene, string $ip, ?int $now = null): bool`. `Captcha::check(mixed $id, mixed $code, string $scene): bool` obtains the existing trusted client address. Only the image renderer sees the plaintext generated answer.

- [x] Establish the old failure signal (two images / latest-only success / 0000 rejection).
- [x] Establish the failing old implementation evidence, add independent lifecycle regressions and run them against the replacement:

```php
$first = $store->issue('login', '192.0.2.1', 1000);
$second = $store->issue('login', '192.0.2.1', 1000);
check($store->consume($first['id'], strtolower($first['code']), 'login', '192.0.2.1', 1001));
check($store->consume($second['id'], $second['code'], 'login', '192.0.2.1', 1001));
check(!$store->consume($first['id'], $first['code'], 'login', '192.0.2.1', 1001));
```

- [x] Implement private storage creation, random ID/code, indexed expiry/rate accounting, `BEGIN IMMEDIATE` consumption, scene/IP binding, and readable PNG output.
- [x] Verify correct/wrong/expired/replayed/missing/array input, cross-IP/scene, generation limits, no session dependency, private file modes and two-process consumption. Use only the isolated `COMMERCE_TEST_APP`; `captcha.php` passes 106 assertions, including the actual trusted proxy client parser.

## Task 2: Existing PHP callers and active legacy UI

**Files:** Overlay `app/Controller/User/Api/{Authentication,Order,Security}.php`, `app/Controller/Admin/Api/Authentication.php`, `app/View/Admin/Authentication/Login.html`, `assets/admin/controller/auth/login.js`, `assets/user/controller/security/{email,phone}.js`.

**Interfaces:** All graphic checks use `Captcha::check($fields['captcha_id'] ?? null, $fields['captcha_code'] ?? null, $scene)`; no separate scene-wide destroy. Admin keeps throttling and TOTP. Recovery's final `captcha` field remains the SMS/email code.

- [x] Add caller regression coverage for login/register, send-code scenes, order, admin default-on/off and security scenes, preserving business-code callsites (72 assertions).
- [x] Update callers and remove only superseded methods/calls inside changed files, including obsolete email/phone helper scene arguments.
- [x] Admin loads `/ui/captcha.js` and submits its exact image/ID pair. Security prompts use the same controller; confirm captures fields before prompt disposal, cancellation makes no request.
- [x] Verify all supported customer document routes are SPA-owned. Old upstream customer templates are not new fallback routes and are not copied into the overlay.

## Task 3: Frontend controller and delivery

**Files:** Create `frontend/src/captcha.js`; modify `frontend/src/pages/{auth,product}.js`, `frontend/src/commerce-model.js`, `frontend/{build,dev}.mjs`, `frontend/src/styles.css`, `deploy/download-nginx.conf.example`; tests `frontend/tests/{build,dev,commerce}.test.mjs`, `frontend/tests/browser/captcha.spec.mjs`, synthetic fixture.

**Interfaces:** `mountCaptcha({action, image, input, status, trigger, signal, onChange})` returns `{refresh, dispose, get id(), get ready(), fields()}`. `fields()` returns exactly `{captcha_id, captcha_code}` and rejects an unloaded/expired image. The explicit trigger stays available even when an invalid image is hidden. The controller has no imports so the build can also expose its same bytes at `/ui/captcha.js` (no-store) for PHP pages; SPA uses its fingerprinted module.

- [x] Add failing browser evidence for payload identity and decoder timeout; cover delayed/out-of-order refresh, missing ID, decode/network failure, unload cleanup, independent tabs and exact form payload pairing.
- [x] Implement one cancellation/sequence-aware loader with a 10-second timeout spanning response/body/decode, a 300-second expiry, image decode gate and object URL revocation; use existing input/button/status primitives per awesome-ui-kit.
- [x] Wire auth/send-code/trade fields and readiness; reserve both new protocol fields against custom widget collisions.
- [x] Copy the single controller during build, serve it through an exact nginx/dev route, forward `X-Captcha-Id` in dev and add `blob:` only to `img-src`.
- [x] Run `make check-frontend` (44 tests/build/format) and Chrome `make check-browser` (52 tests); inspect a real rendered PNG and mobile form.

## Task 4: Verification, release and records

**Files:** `commerce/release-baseline.json`, `docs/frontend-architecture.md`, `docs/review-2026-10-09-ui-api.md`, `docs/release-2026-10-09-ui-api.md`, canonical Obsidian entry and its two indexes.

- [x] Record hashes of the exact currently deployed 33 overlay paths before replacement and cross-check against pinned upstream/already deployed sources. Only CaptchaStore is new; keep old source and new candidate in private release evidence, with no business data rollback or schema replay.
- [x] Run the full Node/browser/Go/Python/nginx/PHP gates, then review the final diff and make a verified branch commit. Core commit 1c5150e and cache fix 8835d86 both passed GitHub CI and were fast-forwarded into main after rebase.
- [x] Obtain separate approval and remove the two retired Go UI files, then rerun Go race/vet. The static-backup release gate is also complete below.
- [x] Configure the existing PHP client parser for nginx's overwritten X-Real-IP (mode 1, trusted peers only 127.0.0.1/::1), preserving prior files/absence. Real production probes with two TEST-NET addresses confirmed independent IP binding; Client/nginx regressions pass.
- [x] Add the standalone UI and release evidence to recurring backups after preserving the exact oldest completed snapshot outside retention scanning; keep retention/interval unchanged and verify a fresh snapshot. All 28 recurring snapshots remain; the post-cache-fix snapshot was created in a separate retained directory without service restart or pruning.
- [x] Deploy paired frontend/PHP changes in a short controlled window, verify PNG headers and read-only endpoints, then confirm GitHub state. Activated at 2026-10-09 07:53:54 Asia/Shanghai. Two original visible images both passed correct-answer validation, replay failed, and no account credentials were sent. Business schemas and databases were not migrated or restored.
- [x] Update existing Obsidian canonical note, AI-DOC-ROUTER and 项目索引 in the same task; run `python3 .local/bin/scan-stale-docs`. No stale hits or new warnings; three unrelated pre-existing metadata warnings remain.

## Final cache-boundary follow-up

Public validation exposed 404 heuristic caching even without immutable. Five stricter nginx assertions failed before explicit status-based no-store, then all 12 nginx tests passed. The shared Cloudflare /pub/ override still produced a second-request HIT; a download-host-only trailing respect_origin rule corrected this without changing the three existing rules. After edge propagation, all 18 public checks passed, including repeated missing-file BYPASS and successful public-file MISS→HIT. Exact hashes, backups and evidence are in the release record.
