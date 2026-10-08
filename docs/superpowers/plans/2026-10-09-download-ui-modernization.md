# Download storefront separation and UI implementation plan

> For agentic workers: execute the independently verifiable tasks below in the isolated `codex/download-ui-modernization` branch. Use subagents for the independent PHP API slice; integrate and review their committed changes before final verification.

**Goal:** Deliver a standalone, responsive MangoQWQ resource storefront covering public downloads, card redemption, products, checkout, order lookup and customer authentication, backed by explicit JSON APIs.

**Architecture:** `frontend/` owns HTML, styles, ES modules and a deterministic static build. Go owns card authorization and an explicitly curated public-resource catalog; PHP retains commerce, payment and customer sessions and exposes a whitelisted storefront bootstrap API. A same-origin reverse proxy composes independently deployable frontend/API artifacts. Neither frontend code nor public configuration receives administrator secrets or database access.

**Tech stack:** Go 1.26.4, existing SQLite storage, PHP 8.2 commerce overlay, Node 22+ build/test tooling, browser ES modules, awesome-ui Vanilla UiIcon and ThemeToggle (MIT).

## Global constraints

- Preserve the primary worktree and the unrelated dirty `codex/download-ui-refactor` worktree. Baseline is committed `cf021cd`, not their uncommitted UI work.
- UTF-8 without BOM. No production writes, card consumption, payments, source-file deletion or large dependency downloads without the applicable user authority.
- The user approved creating a new UI branch. Existing authorization grants, SQLite schema and financial transaction behavior remain the business contract.
- Use actual published public resource paths and existing commerce records; never invent downloads, stock, customers or service-health claims.
- Keep credentials in memory only; redemption is POST; viewing resources does not debit; retry the same grant credential after a lost response; GET/HEAD never debit.
- Rich text and URLs cross an explicit sanitization boundary. Payment/session routes and legacy `/dl/` links must remain usable.

## 1. API and deployment boundaries

Files: `commerce/overlay/app/Controller/User/Api/Storefront.php`, `commerce/overlay/app/Util/StorefrontPayload.php`, `commerce/tests/storefront.php`, `public_catalog.go`, `catalog/public.json`, `frontend_handler.go`, `config.go`, `http_handlers.go`, `deploy/download-nginx.conf.example`.

Interfaces:

```text
GET /api/catalog
  {code:200, resources:[{id,name,description,category,version,platform,path,filename,bytes,updated_at,kind,featured}]}
GET /user/api/storefront/bootstrap
  {code:200,data:{name,title,notice,support_url,closed,default_category,from,
    auth:{registration_enabled,registration_type,registration_captcha,
      email_verification,phone_verification,login_captcha,username_min_length,recovery_type},
    user:null|{id,username,avatar,balance,group_name}}}
GET /user/api/index/data                         existing categories
GET /user/api/index/commodity                    existing paginated catalog
GET /user/api/index/commodityDetail?commodityId= existing product contract
POST /user/api/index/{valuation,stock,card,pay}   existing purchase preparation
POST /user/api/order/trade                       existing order creation
POST /user/api/index/{query,secret}              existing order retrieval
POST /user/api/authentication/*                  existing customer authentication
POST /api/{redeem,grants}                        existing card authorization
```

- [ ] Add a bootstrap presenter that explicitly selects public settings and user fields, honors business-site overrides, accepts GET/HEAD only and sends no-store. Verify malicious/private input fields never appear in serialized output.
- [ ] Publish a curated catalog; validate unique IDs, required fields and public-only local paths before exposing it. An external catalog file allows updates independently of frontend code.
- [ ] Add standalone frontend hosting (configured filesystem) and API-only mode. Only known document routes fall back to the shell; missing assets and unknown APIs return 404. Retain compatible legacy hosting until explicit deployment switches the frontend.
- [ ] Update nginx examples with a dedicated `/ui/` namespace, immutable versioned files, no-store HTML and exact frontend route matches. Preserve commerce API, payment, admin, file transfer and public distribution routing.

## 2. Frontend application and build

Files: `frontend/package.json`, `frontend/index.html`, `frontend/build.mjs`, `frontend/dev.mjs`, `frontend/src/{app,api,dom,theme,router}.js`, `frontend/src/vendor/{UiIcon,ThemeToggle}.js`, `frontend/src/styles.css`, `frontend/THIRD_PARTY_NOTICES.md`.

Interfaces:

```js
export async function request(path, {method = 'GET', fields, signal} = {}) {}
export function fields(body) {} // nested sku[field] form encoding
export function safeURL(value, {sameOrigin = false} = {}) {}
export function richText(html) {} // explicit element/attribute/URL allowlist
export function mountPage(container, context) {} // each page returns cleanup
```

- [ ] Build a standalone static artifact with a deterministic content-hashed `/ui/<release>/` directory. Build output must not contain tests, secrets or backend code; stale assets are not accidentally selected by new HTML.
- [ ] Implement a shared responsive navigation, MangoQWQ brand, accessible forms, inline feedback, copy fallback and persisted auto/light/dark themes using the requested awesome-ui sources.
- [ ] Centralize JSON errors, timeout/abort behavior and POST encoding; never retry mutations automatically. Only server-validated URLs may navigate to a payment/download endpoint.
- [ ] Provide local frontend development with explicitly configured API proxies and an opt-in synthetic fixture mode. Fixture mode must be visibly labeled and never be packaged as production data.

## 3. Complete customer workflows

Files: `frontend/src/pages/{home,resource,redeem,product,orders,auth,account,help}.js`.

- [ ] Home: searchable/category-filtered public resources and live commerce items, grid/list view, stable URL state, honest empty/loading/error states, redeem shortcut and clear public/card distinction.
- [ ] Public detail: actual file metadata, direct download and copy URL, version/platform information, no debit and no automatic script execution.
- [ ] Redemption: card/key form, optional old prefix path, resource results, explicit grant issuance, zero-quota recovery, expiry handling and manual copy. Preserve a previous successful resource list if a subsequent redemption request fails.
- [ ] Product: server-priced race/SKU/quantity/coupon changes, stock state, required contact/password/custom fields, optional card choice, captcha, login-only and timed availability, duplicate-submit protection and payment/free-order results.
- [ ] Orders: private POST lookup, password-protected secret retrieval, paid/pending-delivery distinctions, pagination and copy. Do not place contacts, passwords or secrets in URLs or storage.
- [ ] Authentication: login/register/recovery driven by bootstrap settings, captcha refresh, email/SMS code requests and safe return paths. Account overview links to existing account operations without intercepting merchant/admin APIs.
- [ ] Help/404: navigation, download authorization semantics, expired links and support; respect prefers-reduced-motion and keyboard focus.

## 4. Verification and handoff

Files: `frontend/tests/*.test.mjs`, `frontend/tests/browser.mjs`, `public_catalog_test.go`, `frontend_handler_test.go`, `docs/frontend-architecture.md`, `README.md`, `Makefile`, `.github/workflows/check.yml`.

- [ ] Run existing Node baseline (14 passing), Go race suite once locked dependencies are available, Python release/backup tests and isolated real PHP regressions.
- [ ] Add meaningful boundary tests: public-only catalog, secret-free bootstrap, exact SPA routing, traversal/missing assets, malicious rich text/URLs, retained credentials, stale product quotes and duplicate submit prevention.
- [ ] Browser-test desktop/mobile, light/dark, real public catalog reads and synthetic complete redemption/checkout/order/auth journeys. Inspect screenshots and fix overflow, clipped text, disabled recovery controls and console errors.
- [ ] Verify static build, backend build, formatting and `git diff --check`; document exact verification evidence and remaining environment/deployment limits.
- [ ] Update the canonical Obsidian project entry in place with branch/development status, link architecture documentation, update the existing router/MOC entry and run vault health checks. Distinguish verified production facts from the un-deployed UI branch.
