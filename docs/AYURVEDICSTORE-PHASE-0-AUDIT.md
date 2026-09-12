# AyurVeda Store — Phase 0 Foundation Audit

**Date:** 2026-09-12
**Scope:** Full repository audit (no feature implementation). Evidence-based; every claim below is tagged **FACT** (verified directly from code/live server), **RECOMMENDATION** (architectural suggestion), or **ASSUMPTION** (could not be verified, needs confirmation).
**Method:** Full read of every server file (31 files), every admin/public-site HTML file (23 files), the complete database schema, and live verification by running the server against the project's actual configured Supabase instance (read-only GET requests only — no writes, no login attempts, no destructive actions).

---

## 1. Executive Summary

This is a small (~5,000 total lines), single-developer, pre-launch codebase: a Node/Express + Supabase (Postgres) ecommerce platform with plain server-side-rendered HTML on the storefront and a plain-JS SPA-style admin panel. It already correctly implements the core **Product → Variant** model (no Batch/Inventory layer yet), server-authoritative checkout pricing, JWT-based staff auth with RBAC, and Supabase-Auth-based customer accounts. It is architecturally **not** a marketplace and contains no seller/vendor concepts — consistent with the locked business model.

However, it is **pre-production**, not merely "ready with minor gaps":

- **Zero products are currently published** on the live storefront (verified live — sitemap.xml and homepage both show an empty catalog).
- **A confirmed, live-reproduced rendering bug** breaks the homepage and shop-listing pages whenever the regex-based SSR template substitution runs (see §3.1). This is not theoretical — it was reproduced against the live database.
- **Payment gateway integration does not exist in code at all** — no Razorpay/PayU SDK, no config keys, no payment table, no webhook route (confirmed by exhaustive grep, zero matches for "razorpay", "payu", "webhook" anywhere in `server/src`).
- **No JSON API exists for product browsing/search/detail** — the entire catalog is only reachable as server-rendered HTML with data regex-baked into `<script>` tags. An Android client (or any non-browser client) has nothing to call.
- **Manufacturing/Batch/Inventory is 0% implemented** — only a flat `stock` integer per variant.
- **The project has no version control** — `git status` fails; there is no `.git` anywhere in this directory or its parent. All "do not lose work" git-safety practices are moot until a repo is initialized.
- **Zero automated tests, zero CI/CD** exist anywhere in the repository.
- Live Supabase **service-role key, anon key, and a real admin password** are sitting in plaintext in `server/.env`, which is correctly gitignored but currently unprotected by git history since there is no git repo at all yet.

None of this blocks Phase 1 — the foundation (schema, auth, RBAC, checkout re-pricing discipline) is sound enough to build on. But several items below should be fixed or explicitly scoped into Phase 1 rather than carried forward silently.

---

## 2. Verified Technology Stack

| Layer | Technology | Evidence |
|---|---|---|
| Backend runtime | Node.js (ESM, `"type":"module"`), Express 4.19 | `server/package.json` |
| Database | Supabase Postgres, accessed via `@supabase/supabase-js` service-role client | `server/src/db/supabaseClient.js` |
| Admin auth | Custom JWT (`jsonwebtoken`) + `bcryptjs`, own `staff_users` table | `server/src/auth/adminAuth.js`, `supabase/schema.sql` |
| Customer auth | Supabase Auth, browser talks to Supabase directly via anon key | `server/src/routes/pages.js:31-43` (`injectSupabaseConfig`), `public-site/account.html` |
| Storefront rendering | Server-side regex template substitution (NOT a template engine, NOT React/Vue) | `server/src/routes/pages.js`, `server/src/seo/templates.js` |
| Admin panel | Static HTML + vanilla JS, no build step, no framework | `admin/*.html`, `admin/js/api.js` |
| Image handling | `multer` (memory) → `sharp` (resize/WebP compress) → Supabase Storage | `server/src/storage/imageUpload.js` |
| Security middleware | `helmet`, `cors`, `express-rate-limit`, `compression` | `server/src/index.js:35-60` |
| Analytics | Custom in-memory buffer + `geoip-lite`, flushed to `page_views` table | `server/src/analytics/tracker.js` |
| Payment gateway | **None** — confirmed absent | grep for "razorpay\|payu\|webhook" across `server/src`: 0 matches |
| Testing | **None** | No `*.test.js`/`*.spec.js` files; no test runner dependency |
| CI/CD | **None** | No `.github/` directory anywhere |
| Version control | **None** | `git status` → "not a git repository" (confirmed at this directory and its parent) |

**FACT**, all rows above.

---

## 3. Repository Structure

```
ayur-app/                      (NOT a git repository — FACT)
├── README.md, SETUP.md
├── supabase/schema.sql         (323 lines, single migration-style file, no migrations directory)
├── server/                     (Express API + SSR renderer, 31 .js files, 2,185 lines)
│   ├── .env                    (contains LIVE Supabase service-role key + real admin password — see §9)
│   └── src/{auth,routes,seo,storage,validation,analytics,db,scripts,middleware}/
├── admin/                      (14 HTML pages + 2 shared JS files, 2,474 HTML lines incl. inline scripts)
└── public-site/                (9 HTML pages + 1 shared JS file)
```

No monorepo tooling, no root `package.json`, no workspaces. **FACT**.

### 3.1 CONFIRMED LIVE BUG — SSR template substitution is broken for nested-HTML sections

**FACT — reproduced live**, not theoretical. `server/src/routes/pages.js` renders the homepage and shop-listing page by regex-replacing a placeholder block:

```js
template.replace(
  /(<h3 class="section-title">Product Highlights<\/h3>[\s\S]*?<div class="product-grid">)[\s\S]*?(<\/div>)/,
  `$1${highlights.map(productCardHtml).join("")}$2`
)
```

The non-greedy `[\s\S]*?` stops at the **first** `</div>` it finds after `<div class="product-grid">`. Because the placeholder markup inside that grid contains nested `<div>`s (e.g. `<div class="product-card"><div class="badge-sale">On Sale</div>...`), the regex closes at the *first nested* `</div>` — not the real closing tag of `.product-grid`. The rest of the old placeholder markup (hardcoded fake products: "Amlant Tablet", "Organic Ashwagandha Tablets", etc.) is left dangling in the page as broken, unclosed HTML, directly after the grid.

**Reproduced by starting the server against the live configured Supabase project and fetching `GET /` and `GET /shop`:**
```
<div class="product-grid"></div>
    <div class="img">Product Image</div>         ← orphaned leftover placeholder markup
    <div class="body">
      <div class="title">Amlant Tablet — ...
```
Same bug pattern confirmed on `/shop`'s product grid. The real grid renders correctly-but-empty (0 published products); the leftover hardcoded demo cards render outside the grid container as broken HTML. **If real published products existed**, the bug would still truncate the new product-card markup at the first nested `</div>` and leave old placeholder cards dangling alongside it — this is a rendering-breaking defect independent of catalog content.

Root cause: using regex substitution on HTML with nested elements of the same tag instead of an HTML template engine / DOM-aware substitution / clearly-delimited markers (e.g. `<!--PRODUCTS_START-->...<!--PRODUCTS_END-->`).

**Not affected** (verified safe): `product.html`'s `.pd-packs` and `.gallery-main` replacements, because those placeholder blocks contain no nested `<div>` children — the first `</div>` found actually is the correct closing tag.

**RECOMMENDATION:** Phase 1 should replace this regex-splice SSR approach with either (a) distinct HTML comment markers for every repeated-block injection point, or (b) a real templating approach, before any real catalog content is published. This is the single highest-priority frontend defect.

### 3.2 CONFIRMED LIVE FACT — zero published products in the live database

`GET /sitemap.xml` against the live configured Supabase project returns no `/product/...` URLs; the homepage's real product grid renders empty. The store currently has no live catalog. **FACT.**

---

## 4. Existing Product/Commerce Features — KEEP / MODIFY / NEW / REMOVE / REBUILD

| Feature | Status | Evidence |
|---|---|---|
| Product + Variant model | **KEEP** | `products`, `product_variants` tables; matches the locked Product→Variant→Batch→Inventory direction (Batch/Inventory layer missing, see §10) |
| Product images | **KEEP** | `product_images` table, `imageUpload.js` auto-compresses to WebP |
| Categories (concern/benefit/product_type) | **MODIFY** | Single `categories` table with a `type` enum column doing triple duty — works as a taxonomy but has no dedicated content (description, icon, SEO fields) per concern/benefit, so "Ingredient Explorer"/"Concern pages" (target scope §23) cannot be built on it as-is |
| Ingredients | **REBUILD (if structured ingredient pages are wanted)** | Currently a single free-text field on `products.ingredients` — no ingredient master table, no ingredient↔product relationship, no ingredient detail pages |
| Cart | **KEEP** | Client-side `localStorage` cart (`public-site/js/site.js`), correctly treated as non-authoritative — server re-prices everything at checkout (`public.js:57-77`) |
| Checkout (COD) | **KEEP** | Fully functional, re-prices server-side, decrements stock atomically via `decrement_variant_stock` RPC with a safe fallback |
| Checkout (Prepaid) | **NEW (gateway integration)** | Applies a discount % and marks `payment_status:"unpaid"` — there is no actual payment collection step. This is a placeholder, exactly as README states (rare case doc matches code) |
| Orders / Order items | **KEEP** | `orders`/`order_items` tables with price/title snapshots (correct pattern — protects historical order data from later product edits) |
| Coupons | **KEEP** | Percent/flat, min-order, usage-limit, validity window — reasonably complete for a single-brand store |
| Reviews | **KEEP** | Moderation workflow (`pending`/`approved`/`rejected`), rating recompute on approve/reject |
| Q&A | **NEW** | No Q&A feature exists anywhere (no table, no route, no UI) |
| Wishlist | **NEW** | No table, no route, no UI exists anywhere |
| Product search | **NEW** | Header search box exists on every storefront page but has **zero JS wiring** — `<button type="button">Search</button>` with no event listener anywhere in `site.js` or any page's inline script. It is decorative. **FACT**, confirmed by reading every public-site file. |
| Shop filters (concern/benefit/price/rating/product-type checkboxes) | **NEW** | Only `concern`/`benefit` category filtering is real (via `?concern=`/`?benefit=` query params, server-side). Price, rating, and product-type checkboxes in `shop.html`'s sidebar are static hardcoded markup with no `name`/`value` wiring and no JS — decorative only |
| Sort dropdown on shop page | **PARTIALLY IMPLEMENTED** | Server supports `?sort=` param; the `<select>` UI has no `onchange` handler wired to it |
| Shipping | **MODIFY** | Flat ₹60 fee / free-above-threshold only; no shipment/tracking entity beyond a single `tracking_number` text field on `orders` |
| Returns/Refunds | **NEW** | No table, no route, no UI; `orders.payment_status` has a `refunded` enum value but nothing ever sets it |
| Blog/CMS | **MODIFY** | Minimal (`blog_posts` table: title/slug/excerpt/body/cover/SEO/status). No Guides, FAQs, or structured content types beyond blog posts |

---

## 5. Backend/API Audit

All 13 route modules were read in full. Summary table (method/path/auth/notes); full detail available on request.

| Route file | Base path | Auth | Key gaps found |
|---|---|---|---|
| `adminAuthRoutes.js` | `/api/admin/auth` | Mixed | Staff login, change-password, invite/deactivate with role-rank checks (cannot self-elevate above own rank) — **solid** |
| `products.js` | `/api/admin/products` | Staff + RBAC | No public (non-admin) product-listing/detail JSON API exists anywhere — see §6 |
| `categories.js` | `/api/admin/categories` | Staff + RBAC | OK |
| `orders.js` | `/api/admin/orders` | Staff + RBAC | `q` search param interpolated directly into a PostgREST `.or()` filter string (`orders.js:13`) — see §7.3 |
| `customers.js` | `/api/admin/customers` | Staff + RBAC | Uses Supabase Auth admin API to list registered users — OK |
| `coupons.js` | `/api/admin/coupons` | Staff + RBAC | OK; `computeCouponDiscount` shared correctly with checkout |
| `reviews.js` | `/api/admin/reviews` | Staff + RBAC | OK |
| `vaidyaBookings.js` | `/api/admin/vaidya-bookings` | Staff (list has no RBAC gate beyond staff auth) | Listing has no `requirePermission` check — any authenticated staff role (including Viewer) can view all bookings; acceptable for this data sensitivity level but inconsistent with other list routes |
| `blog.js` | `/api/admin/blog` | Staff + RBAC | OK |
| `settings.js` | `/api/admin/settings` | Staff + RBAC | `PUT /:key` accepts arbitrary JSON into `value` with no schema validation — a typo could silently corrupt a settings row (low risk, admin-only) |
| `dashboard.js` | `/api/admin/dashboard` | Staff | OK |
| `analyticsRoutes.js` | `/api/admin/analytics` | Staff | OK |
| `public.js` | `/api/public` | Mixed (customer-optional) | Checkout correctly re-prices server-side and validates stock — **this is the most important correctness property in the whole codebase and it holds up**. No public product listing/detail/search endpoints exist — see §6. |

**No pagination cap**: every paginated list route (`products`, `orders`, `reviews`) accepts client-supplied `pageSize` with no server-side maximum — a client could request `pageSize=999999`. Low severity at current scale; **RECOMMENDATION** to clamp in Phase 1.

**Response-shape consistency**: list endpoints generally return `{items, total, page, pageSize}` consistently — **FACT, good foundation for an API contract.**

---

## 6. Android Readiness Audit — the single biggest architectural gap

**FACT.** There is no JSON API for any customer-facing catalog browsing:
- No `GET /api/public/products` (list/search/filter)
- No `GET /api/public/products/:slug` (detail)
- No `GET /api/public/categories`
- No search endpoint of any kind

Product data reaches the browser only two ways: (1) baked directly into server-rendered HTML strings via regex substitution (`pages.js`), or (2) a single small JSON blob injected as `window.__PRODUCT__` on the product detail page for the client-side pack-selector script. Neither is consumable by a native Android client.

**What IS Android-ready today (FACT):**
- Checkout (`POST /api/public/checkout`), coupon validation, reviews submission, vaidya bookings, dosha-result saving, cart-item lookup, and order history are all plain JSON REST endpoints with no browser-specific assumptions (no cookies, no session state — customer identity is a bearer token). These would work from an Android app as-is.
- Admin API is entirely JSON + bearer JWT — reusable by a future admin mobile app with no changes.
- Customer auth uses Supabase Auth, which has an official Android SDK — the same backend-authoritative checkout model works unchanged if an Android app uses that SDK directly.

**What would force rework for Android (RECOMMENDATION to address in Phase 1):**
1. Build a real `GET /api/public/products` + `GET /api/public/products/:slug` + `GET /api/public/categories` JSON API. The SSR pages should then consume this same API server-side, not duplicate the query logic — this also fixes the template-substitution fragility in §3.1 by giving SSR a clean JSON→HTML boundary.
2. Implement product search server-side (currently does not exist at all, for web or API).
3. The SSR in-memory page cache (`pageCache` Map in `pages.js`) is per-process — fine for a single web dyno, irrelevant to Android once a proper JSON API exists, but worth noting it won't survive horizontal scaling of the web tier either.

---

## 7. Security Audit

### 7.1 Critical — Secrets exposure (ASSUMPTION-checked, now FACT)
`server/.env` contains a **live** Supabase `SUPABASE_SERVICE_ROLE_KEY` (bypasses all RLS), `SUPABASE_ANON_KEY`, and a real seed admin password, committed to local disk in plaintext. **FACT.**
- `.gitignore` correctly excludes `server/.env` (`.gitignore:2`) — **good**, so if/when this project is put under version control, the file itself won't be committed by default.
- However: **there is currently no git repository at all** (§3), so this protection has never actually been exercised, and the values have now additionally been displayed in this audit's tool output/transcript.
- **RECOMMENDATION (do before any further sharing of this project or its logs):** rotate the Supabase service-role key and the seed admin password once a git repo + secret-scanning discipline is in place, purely because they have been displayed in this session. This is not urgent if the Supabase project is not yet public-facing, but should not be deferred indefinitely.

### 7.2 Medium — Error messages leak internals
`server/src/middleware/errorHandler.js` returns `err.message` directly to the HTTP client for every uncaught error, including raw Supabase/Postgres error text. **FACT.** Example: a malformed query could leak a column/table name. **RECOMMENDATION:** return a generic message for 5xx in production, log the real error server-side only (the code already does `console.error(err)` — just stop also sending `err.message` to the client for non-validation errors).

### 7.3 Low-Medium — Unvalidated filter-string interpolation
`server/src/routes/orders.js:13`:
```js
if (q) query = query.or(`order_number.ilike.%${q}%,guest_email.ilike.%${q}%,guest_phone.ilike.%${q}%`);
```
`q` is interpolated directly into a PostgREST filter-expression string passed to `.or()`. This is **not** classic SQL injection (PostgREST parses its own filter grammar, not raw SQL), but a crafted `q` containing commas/operators could alter which columns/conditions are evaluated, or trigger a PostgREST parse error that (per §7.2) leaks internals. Admin-only endpoint, so blast radius is limited to staff accounts. **RECOMMENDATION:** escape or reject PostgREST special characters (`,`, `.`, `(`, `)`) in `q`, or use parameterized `.ilike()` calls per field with explicit `.or()` array syntax instead of string interpolation.

### 7.4 Auth/RBAC — verified sound
- **FACT, live-verified:** `GET /api/admin/products` without an `Authorization` header returns `401 {"error":"Missing auth token"}`; with a garbage token returns `401 {"error":"Invalid or expired token"}`. Admin route gating works as coded.
- Role-rank logic prevents staff from assigning/self-elevating to a role higher than their own (`adminAuthRoutes.js:102`,`122`).
- Cannot deactivate the last remaining active SuperAdmin (`adminAuthRoutes.js:141-147`) — good defensive check.
- Customer auth correctly verifies the bearer token against Supabase itself rather than trusting client-asserted identity (`customerAuth.js:18`).
- Checkout correctly re-prices and re-validates stock server-side from the database on every request — **this is the most important anti-fraud property for an ecommerce checkout and it is implemented correctly.**

### 7.5 Input validation / XSS — reasonable for current scope
- `sanitizeText()` HTML-entity-escapes user text before storage (`validators.js`); `escapeHtml()` re-escapes on SSR output. Double-escaping (escape on write AND on read) is redundant but not a vulnerability — just wasted work (`&amp;` would never double-encode since the escaping function is idempotent-safe for already-plain text, but if ever removed from one layer, the other still protects — **low-priority cleanup, not a security bug**).
- Tried an XSS probe against `POST /api/public/coupons/validate` with a `<script>` payload in the `code` field — live-verified it is rejected as "Invalid or inactive coupon code" with no reflection. No injection observed.
- Image upload validates MIME type against an allowlist and re-encodes every image through `sharp` to WebP (strips EXIF, discards original format/any embedded payload) — a genuinely good defensive pattern against malicious image uploads.

### 7.6 Rate limiting — present but coarse
Global API limiter (400 req/15min), stricter limiters on login (20/15min) and checkout (30/15min) (`index.js:54-60`). **FACT.** No per-account or per-IP+account combination limiting, no CAPTCHA on login — acceptable for current scale, worth revisiting before high-traffic launch.

### 7.7 CORS
`corsOrigin: process.env.CORS_ORIGIN || "*"` (`config.js:6`) — defaults to wildcard if unset. The actual `.env` sets a specific origin (`http://localhost:5500`) — fine for dev, but **RECOMMENDATION:** ensure this is explicitly set to the real production domain before launch, not left at `*`.

---

## 8. Payment / Razorpay Readiness Audit

**FACT, exhaustively verified (grep across entire `server/src` for "razorpay", "payu", "webhook" → zero matches):**
- No payment gateway SDK dependency in `package.json`.
- No payment/transaction/payment_attempts table in the schema — only `orders.payment_method` (`cod`/`prepaid`) and `orders.payment_status` (`unpaid`/`paid`/`refunded`) columns.
- No webhook route of any kind.
- "Prepaid" checkout only applies a discount percentage and marks the order `unpaid` — no actual charge is ever attempted.
- Admin Settings page explicitly tells the admin "Razorpay / PayU keys configured via server .env — not editable here for security" (`admin/settings.html:31`) — **this UI text is misleading/aspirational**: no such config keys exist anywhere in `config.js` or `.env`. **Documentation-vs-code mismatch, per audit requirement §28.**

**Target model for Phase 2** (per the locked architecture) requires:
```
Order → Payment → Payment Attempts/Transactions
```
None of this exists yet. Current `orders.payment_status` is a single flat enum with no history/audit trail — cannot currently distinguish "payment attempted and failed twice then succeeded" from "paid on first try," and there is no `PENDING`/`INITIATED`/`CANCELLED`/`PARTIALLY_REFUNDED` granularity, only `unpaid`/`paid`/`refunded`.

**RECOMMENDATION (Phase 2 scope, not Phase 0/1):** introduce a `payments` table (one-to-many from `orders`) capturing gateway order id, gateway payment id, status, raw webhook payload, and signature-verification result, with `orders.payment_status` becoming a derived/denormalized summary rather than the sole source of truth. Server-side webhook signature verification is mandatory — the frontend payment callback must never set `payment_status` directly (current code doesn't let the frontend do this today, which is good — there's simply no payment flow yet to get this wrong).

---

## 9. Manufacturing / Batch / Inventory Audit

**FACT: 0% implemented.** The only inventory representation anywhere in the system is `product_variants.stock` (a single integer). There is no:
- Manufacturer/manufacturing-metadata table or fields
- Batch table (batch number, mfg date, expiry date, QC status, quantity)
- Inventory movement/adjustment log
- Low-stock or near-expiry alerting (the admin dashboard *does* compute low-stock/out-of-stock **counts** from `product_variants.stock` — `dashboard.js:23-26` — but this is a live query over current stock, not a stored alert/notification system)
- Batch-level traceability of any kind

**Schema evolution assessment:** the current `products → product_variants` structure is a clean base to extend. Adding a `batches` table (FK to `product_variants`) and repointing `stock` to be derived from `sum(batches.quantity)` (or keeping `product_variants.stock` as a cached total, recomputed on batch changes) is a straightforward additive migration — **no destructive schema changes required** to reach the target `Product → Variant → Batch → Inventory` model. This is Phase 5 scope; nothing here blocks Phase 1-4.

---

## 10. Ayurveda Domain Audit

**FACT:**
- Ingredients: free-text field only (`products.ingredients`), no structured ingredient entity, no ingredient↔product many-to-many, no ingredient detail pages.
- Concerns/Benefits: modeled as `categories` rows with `type IN ('concern','benefit','product_type')` — a single flat taxonomy table, no per-category rich content (description, hero image, SEO fields, related-ingredients), so it can filter the shop grid but cannot power a real "Ingredient Explorer" or content-rich concern/benefit landing page as described in the target scope (§23).
- No educational content types beyond a generic blog (no Guides, FAQs, or "Ayurveda Knowledge Hub" structure).
- Category mega-menus on the homepage (`index.html:39-53`) are entirely **hardcoded links that all point to `/shop`** regardless of the concern/benefit named — e.g. "Oral Care", "Diabetes Care" etc. are listed but none of these categories exist in the actual taxonomy and clicking any of them just loads the generic shop page with no filter applied. **FACT**, confirmed by reading the markup — these are static `<a href="/shop">` links, not `/shop?concern=...` links. This is a real SEO and UX gap: the categories advertised in the main navigation don't functionally exist.

---

## 11. Wellness Assessment (Dosha Test) Audit

**FACT:**
- Entirely client-side: 8 hardcoded questions/options/scoring logic embedded in `dosha-test.html`'s inline `<script>`. Dosha result (vata/pitta/kapha) is computed in the browser by simple vote-counting — deterministic and simple, **correctly avoids any AI/ML**, consistent with the "AI out of scope" business rule.
- Result is optionally POSTed to `/api/public/dosha-results` for storage (`dosha_results` table) but nothing ever reads it back — no profile page shows past results, no recommendation logic consumes it. It's a write-only sink today.
- Not reusable by Android as-is (logic lives in a `<script>` tag, not a shared/exported module or server endpoint) but trivially portable since it's already simple deterministic JS — **RECOMMENDATION:** move the question/scoring logic to a small server endpoint (e.g. `POST /api/public/dosha-test/score` taking answer indices, returning the result) so both web and Android compute the same result the same way, and so the question set can be edited without a code deploy.

---

## 12. Rule-Based Recommendation Audit

**FACT:** No recommendation functionality of any kind currently exists — no "related products," no "you may also like" backed by real logic (the "You May Also Like" carousel on `product.html` is 100% hardcoded static markup, not server-rendered from any query), no concern/goal-based product suggestions, no dosha-result-driven suggestions. This is fully greenfield for Phase 4. No AI/ML leakage risk exists today since nothing is implemented yet — important to keep that discipline explicit in Phase 4 design (rules should be explicit SQL/JS conditionals on category/ingredient/concern tags, not a model).

---

## 13. SEO Audit

**FACT, generally solid for what exists:**
- Per-page `<title>`, meta description, canonical URL, Open Graph, Twitter Card tags generated server-side (`seoHelpers.js:renderHeadMeta`) — good foundation.
- `Product` and `BreadcrumbList` JSON-LD structured data on product pages (`seoHelpers.js:57-95`) — correctly includes price, availability, aggregate rating.
- `sitemap.xml` dynamically includes all published products (`pages.js:249-267`); `robots.txt` correctly disallows `/cart` and `/account`.
- Clean, human-readable URLs (`/product/:slug`, `/shop?concern=...`).
- **Gap:** the hardcoded mega-menu category links (§10) are dead-end from an SEO perspective — they don't lead to distinct indexable category landing pages with unique content, they all resolve to the same generic `/shop`.
- **Gap:** no `GET /shop?concern=X` page currently returns a 404/empty-state distinctly from "no filter" if the concern slug doesn't exist in the `categories` table — untested edge case, low priority.

---

## 14. Performance Audit

**FACT:**
- Product listing queries select a trimmed column set rather than `*` (`pages.js:69-70`) — good practice, explicitly commented as intentional.
- Images are auto-compressed to WebP with a configurable target size (default 200KB) and resized to max 1600px width (`imageUpload.js`) — solid control on bandwidth/storage cost.
- SSR output is cached in-memory per route+params combination for a configurable TTL (default 5 min) — reduces DB load for a single-process deployment; **RECOMMENDATION:** note for Phase 1 that this cache does not invalidate on publish (a newly-published product can take up to the full TTL to appear) and does not share state across multiple server instances if ever scaled horizontally — acceptable at current scale, worth a cache-bust-on-publish improvement later.
- `gzip`/`compression` middleware is globally enabled.
- No N+1 query patterns observed in the routes read (list endpoints batch-fetch related rows rather than looping per-item, e.g. dashboard's top-products calculation batches `order_items` by the order-id set rather than querying per order).

---

## 15. Responsive / Accessibility Audit

**FACT:**
- `public-site/css/style.css` has 6 `@media` breakpoints, all at 800-900px, collapsing grid column counts for tablet — reasonable tablet support.
- **No breakpoint targets phone width specifically**, and there is no mobile navigation pattern (no hamburger menu, no collapsing mega-menu) anywhere in the markup or JS — the desktop nav/mega-menu markup is the only nav that exists. At ~400px width the header (logo + search + login/cart icons) and the multi-item nav bar would rely on CSS flex-wrap alone, with no verified mobile-specific UX. **RECOMMENDATION:** add a mobile nav pattern in Phase 1/6 frontend work.
- `admin/css/admin.css` has **zero** `@media` queries — the admin panel has no responsive design at all (acceptable if admin is desktop-only by policy, but should be an explicit decision, not a default).
- Accessibility: form inputs generally have visible `<label>` elements (good); no `aria-*` attributes observed anywhere in any HTML file; color-contrast and focus-state styling not verified (would require a rendered-page visual check, not performed in Phase 0).

---

## 16. Testing Audit

**FACT: zero automated tests exist.** No `*.test.js`, no `*.spec.js`, no test runner (`jest`/`vitest`/`mocha`/`playwright`) in any `package.json`. No manual test plans or QA checklists found in the repository. This is a complete gap — **RECOMMENDATION:** Phase 1 should introduce at minimum (a) API integration tests for checkout pricing/stock-decrement correctness (the highest-risk code path in the app) and (b) a smoke test that hits every public route and asserts 200/expected-404.

---

## 17. DevOps / Production Audit

**FACT:**
- **No version control** — `git status` fails at this directory and its parent; there is no `.git` folder anywhere. Every git-safety practice (branch review, commit history, diff review before staging) is currently inapplicable because there is nothing to apply it to.
- `.env` is correctly gitignored (moot until a repo exists) but contains live secrets in plaintext on disk (§7.1).
- No CI/CD configuration of any kind (no `.github/workflows`, no other CI config).
- No health-check beyond `GET /api/health` (present and functional — `index.js:82`).
- No structured logging (uses `console.error`/`console.log` only) — acceptable for current scale, will need upgrading (e.g. to a log aggregator) before production traffic.
- `helmet` CSP is configured with `'unsafe-inline'` for scripts (`index.js:42`) — necessary given the current inline-`<script>`-heavy architecture, but weakens XSS defense-in-depth; would need tightening if the rendering approach changes.
- No documented backup strategy for the Supabase database (Supabase itself provides automated backups on paid tiers — **ASSUMPTION**: not verified whether the configured project is on a tier with backups enabled).

---

## 18. Target Architecture Comparison (Admin Panel)

Mapping the target admin structure (program brief §17) against what exists today:

| Target section | Existing → Gap |
|---|---|
| Dashboard | **Exists**, functional (revenue/orders/top-products/visits chart) |
| Catalog (Products/Categories/Collections/Variants/Images) | Products+Categories+Variants+Images exist; **no Collections concept** |
| Ayurveda (Ingredients/Concerns/Benefits/Relationships) | Concerns/Benefits exist only as flat category rows; **no Ingredients entity, no relationship management UI** |
| Manufacturing (Batches/QC/Traceability) | **Entirely missing** |
| Inventory (Stock/Batch Inventory/Adjustments/Alerts) | Only a flat stock number per variant; **no adjustment log, no alerts beyond a live-computed dashboard count** |
| Orders (All/Returns/Cancellations) | All Orders exists; **no Returns workflow** (cancellation is just a status value, no distinct returns entity) |
| Payments (All/Attempts/Failed/Refunds/Reconciliation) | **Entirely missing** (§8) |
| Shipping (Shipments/Tracking) | Single free-text `tracking_number` field only; **no shipment entity** |
| Customers | **Exists**, functional |
| Reviews & Q&A | Reviews exist; **Q&A entirely missing** |
| Content/CMS (Blog/Guides/FAQs/Homepage) | Blog only; **no Guides/FAQs; homepage content is hardcoded HTML, not CMS-editable** |
| Wellness (Assessments/Recommendation Rules) | Dosha results are stored but not surfaced anywhere in admin; **no recommendation-rule management UI** |
| Vaidya (Bookings) | **Exists**, functional |
| Marketing (Coupons/Promotions) | Coupons exist; **no broader Promotions concept beyond coupons** |
| Analytics | **Exists** (page views, geo breakdown) |
| Notifications | **Entirely missing** — no order-status email/SMS, no admin alerting |
| Staff & RBAC | **Exists**, functional, correctly enforced server-side |
| Audit Logs | **Partially exists** — `activity_log` table used for product/order status changes; no UI to browse it, not used for all entity types (coupons, settings, staff changes aren't logged) |
| Settings | **Exists**, functional, but advertises non-existent Razorpay config (§8) |

---

## 19. P0 / P1 / P2 Prioritization

### P0 — Must have before/alongside Phase 1
- Fix the SSR template-substitution bug (§3.1) — currently corrupts any page with real published-product content.
- Initialize version control for this project (currently none exists at all) before further development continues.
- Build the missing public product/category/search JSON API (§6) — required both for Android readiness and to give the SSR layer a clean, testable data boundary instead of ad-hoc regex splicing.
- Rotate/secure the live Supabase credentials given their exposure in this audit session (§7.1), and stop returning raw error messages to clients (§7.2).
- Clamp/validate pagination parameters and the `orders.js` filter-string interpolation (§7.3) before exposing the admin API beyond a trusted internal network.

### P1 — Important, not launch-blocking
- Wishlist, Q&A, structured Ingredient entity, richer Concern/Benefit content pages, real shop-page filters (price/rating/product-type — currently decorative), working header search, dosha-test server-side scoring, Returns workflow, Shipment entity, basic order-status notifications (email/SMS).
- Batch/Inventory schema (Phase 5 scope, additive, not urgent before launch of a small catalog but needed before manufacturing-traceability claims can be made).
- Payments/Payment-Attempts schema + Razorpay integration (Phase 2 scope — explicitly out of Phase 0/1, but the schema gap should be scoped now so Phase 1's `orders` table design doesn't need late rework).

### P2 — Nice to have / defer
- Mobile-responsive admin panel.
- Audit-log coverage for every entity type (currently only products/orders).
- Collections concept, Promotions beyond flat coupons, CSV export (currently a dead button), advanced analytics beyond page-view geo breakdown.
- Loyalty/subscription automation, advanced Vaidya scheduling — no indication these are needed yet; nothing in the current codebase suggests partial work toward them.

**Reasoning note:** P0 items were selected because they either (a) actively corrupt output the moment real content exists (§3.1), (b) are structural prerequisites the rest of the roadmap depends on (Android JSON API, version control), or (c) are security exposures already realized, not hypothetical. Everything in P1 is real functionality gap but does not block a correct, secure Phase 1-2 launch of the currently-scoped feature set.

---

## 20. Seven-Phase Roadmap — Dependencies & Acceptance Notes

This section does not re-implement the full phase template from the brief; it records what Phase 0's findings specifically change about each later phase's starting assumptions.

- **Phase 1 (DB + API Foundation + Android Readiness):** Must include the public product/category/search API (§6) and the SSR template-bug fix (§3.1) as foundational work, not as later cleanup — both are load-bearing for everything after. Must NOT touch: `staff_users` RBAC logic, checkout re-pricing logic, image compression pipeline — all verified sound, leave alone.
- **Phase 2 (Ecommerce + Razorpay + Orders/Shipping):** Needs a new `payments`/`payment_attempts` schema (§8) designed before wiring Razorpay, not bolted onto the existing flat `payment_status` column. Shipment entity needed if tracking beyond one text field is required.
- **Phase 3 (Ayurveda Discovery):** Needs a structured `ingredients` table and richer `categories` content fields (§10) before Ingredient Explorer / rich concern pages can be built — current schema would need additive tables, not a rewrite.
- **Phase 4 (Wellness + Recommendations):** Dosha test logic should move server-side first (§11) so Android can reuse it; recommendation rules are fully greenfield (§12) — design as explicit tag-matching logic per the "no AI" constraint.
- **Phase 5 (Manufacturing/Batch/Inventory):** Additive schema only (§9) — `products`/`product_variants` do not need to change shape, just gain a `batches` child table and a derivation path for `stock`.
- **Phase 6 (Admin/CMS/Vaidya/Retention):** Notifications (order email/SMS) and Returns workflow are the biggest real gaps here (§18); Vaidya bookings admin already works and needs no rework.
- **Phase 7 (Integration/Security/QA/Production):** Needs the testing foundation (§16) and CI/CD (§17) to exist by this point — currently zero of either, so this phase's scope is larger than "polish," it's "build the safety net for the first time."

---

## 21. Open Questions / Assumptions Requiring Confirmation

1. **ASSUMPTION:** Whether the configured Supabase project (seen live during this audit) is the intended production project or a throwaway dev project — the presence of a real-looking admin email (`ayurnovaherbs@gmail.com`) suggests it may already be considered "real." Please confirm before deciding how urgently to rotate credentials.
2. **ASSUMPTION:** Whether this codebase should be placed under git version control as part of closing Phase 0 — recommended, but not performed without confirmation since it's a repository-level decision.
3. **NOT VERIFIED:** Whether the Supabase project's billing tier includes automated backups.
4. **NOT VERIFIED:** Actual rendered visual/contrast/focus-state accessibility — only markup/CSS was statically reviewed, no browser rendering inspection was performed.
5. **ASSUMPTION:** Whether the hardcoded "10 Lakh+ customers," toll-free number, and named Vaidya doctors on the homepage (§10, `index.html`) are real business facts to keep, or placeholder copy to replace in Phase 6 content work.

---

## Appendix: Live Verification Log

Performed against the project's own configured Supabase instance, read-only:
- `GET /api/health` → `200 {"ok":true}`
- `GET /` → `200`, confirmed template bug (§3.1), confirmed 0 published products
- `GET /shop` → `200`, confirmed same template bug
- `GET /product/nonexistent-slug` → `404`, correct custom 404 page
- `GET /sitemap.xml` → `200`, confirmed 0 product URLs
- `GET /api/admin/products` (no auth header) → `401 {"error":"Missing auth token"}`
- `GET /api/admin/products` (garbage bearer token) → `401 {"error":"Invalid or expired token"}`
- `POST /api/public/coupons/validate` with `<script>` payload in `code` → `400`, no reflection, no injection observed

No write/state-changing operations were performed against the live database during this audit (no checkout, no login, no admin credential use).
