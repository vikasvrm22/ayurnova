# AyurvedicStore — Phase 3 Scope & Dependency Audit
## Ayurveda Discovery & Knowledge

**Type:** Audit only — no code modified. Every claim below is evidence-tagged: **FACT** (verified by reading the actual code/schema), **RECOMMENDATION**, or **DECISION NEEDED** (a real open question, not something this audit can resolve unilaterally).

---

## 1. Executive Status

Phase 3's planned scope — Ayurveda Ingredients, Concerns, Benefits/Goals, Shop-by-X discovery, a Knowledge Hub, product relationships, FAQs, comparison, and search — is **almost entirely unbuilt**. What exists is a single flat `categories` table (concern/benefit only, one per product), a free-text `ingredients` field, a staff-only blog CMS with no public delivery page, and a public catalog JSON API (`/api/public/*`) that is the correct foundation to extend but currently only supports single-category filtering and title-only search.

Nothing found conflicts with the single-brand model, the deterministic/no-AI rule, or the REST→service→DB layering — Phase 3 can be built entirely as additive schema + services + routes in the same pattern Phase 1/2 already established. **The architecture is READY. The content model and UI are NOT.**

**Recommendation: NOT READY for implementation to start today.** The blocking gap isn't code quality — it's that no schema design decision has been made yet for the two structural changes Phase 3 actually needs (many-to-many product relationships, and a defined "Goal" taxonomy that doesn't exist in any form today). See §6 Blockers.

---

## 2. Scope Matrix

| Item | Status | Evidence |
|---|---|---|
| Ingredient entity / ingredient knowledge | **MISSING** | `products.ingredients` is one free-text column (§3.1). No `ingredients` table, no slug, no detail page, no product↔ingredient relation. |
| Concerns | **PARTIAL** | `categories.type='concern'` exists; backend filter (`?concern=slug`) works server-side (§3.2); public UI never calls it (§3.4); category is single-valued per product. |
| Benefits | **PARTIAL** | Same as Concerns — `categories.type='benefit'`, same single-FK and UI-wiring limitations. |
| Goals | **MISSING** | No `type='goal'` in the `categories` check constraint, no goal concept anywhere in code, docs, or UI. Not a synonym currently in use for Benefit either — genuinely absent. |
| Shop by Ingredient / Concern / Goal | **PARTIAL / MISSING** | Concern/Benefit: backend-capable, UI unwired (§3.4). Ingredient: not filterable at all (no entity to filter by). Goal: not possible (no taxonomy). |
| Ayurveda Knowledge Hub / educational content | **PARTIAL** | Admin CMS exists and is reusable (`blog_posts` table, `admin/blog.html`, `server/src/routes/blog.js` — full CRUD + publish). **Zero public delivery**: no `public-site/blog.html`, no `/blog` or `/blog/:slug` route in `pages.js` (§3.5). Content authored today has nowhere for a shopper to read it. |
| Product ↔ Ingredient/Concern/Benefit relationships | **MISSING** | `products.category_id` is a single nullable FK to one `categories` row — a product can carry at most one concern *or* one benefit total, never both, never more than one of either (§3.2). No relational model for ingredients at all. |
| Ayurveda / Product FAQs | **MISSING** | No `faqs` table, no admin UI, no public UI. Every "FAQ" reference in the codebase is a dead `<a href="#">FAQ</a>` footer link (§3.6). |
| Product comparison | **MISSING** | No schema, service, route, or UI reference anywhere in the repo. |
| Search/discovery integration | **PARTIAL/MISSING** | `GET /api/public/search` exists and works, but matches `products.title` only (`ilike`) — it does not search concerns, benefits, or the ingredients text, despite the header search placeholder promising "Search products, concerns, ingredients...". The header `<form>` itself has no JS wiring at all — it cannot submit a search (§3.7). |

---

## 3. Existing Implementation / Evidence

### 3.1 Ingredients — free text only
`supabase/schema.sql:50` — `products.ingredients text`. Rendered as one plain block:
- `admin/product-form.html:52` — a single `<textarea id="f-ingredients">`.
- `server/src/routes/pages.js:187` — SSR injects the raw text into one `<div id="tab-ingredients">`.
- `server/src/routes/catalogPublic.js:60` — the JSON API's `toDetail()` exposes it as one `ingredients: string` field.

No ingredient has an id, slug, description, dosha association, or link back to which other products contain it.

### 3.2 Concerns/Benefits — flat taxonomy, single FK
- `supabase/schema.sql:30-37` — `categories(id, name, slug, type check (type in ('concern','benefit','product_type')), sort_order)`. No `description`, `hero_image`, `seo_title`/`seo_description`, or any rich-content field — cannot power a real landing page today, only a filter.
- `supabase/schema.sql:47` — `products.category_id uuid references categories(id)` — **one** FK, shared across all three `type` values. A product cannot be tagged as both "Immunity" (concern) and "Boosts Energy" (benefit) simultaneously; it can only ever point at one `categories` row, period.
- `server/src/services/catalogService.js:86-118` (`listPublishedProducts`) — `?concern=` and `?benefit=` **are** implemented and functionally correct (`resolveCategoryId(slug, type)` constrains the slug to the right `type`, then filters `products.eq("category_id", categoryId)`), but inherit the single-FK ceiling above.
- `server/src/routes/pages.js:101-134` (`GET /shop`) — SSR already reads `req.query.concern`/`req.query.benefit` and passes them straight through to `listPublishedProducts`. **A hand-built URL like `/shop?concern=<real-slug>` genuinely filters correctly today.**

### 3.3 Admin category management — API only, no UI
`server/src/routes/categories.js` has full CRUD (`GET/POST/PUT/DELETE`, RBAC-gated on `manageProducts`), but no admin HTML page calls the POST/PUT/DELETE endpoints. `admin/product-form.html:104` only does a `GET /categories` to populate one `<select>`. **Staff cannot create or edit a concern/benefit category through the admin panel today** — only via direct API calls.

### 3.4 Public discovery UI — not wired to the working backend
- `public-site/shop.html:32-60` — the entire filter sidebar ("Health Concern", "Price Range", "Product Type", "Rating") is static markup: plain `<input type="checkbox">` elements with no `name`, no `value`, no `onclick`, no fetch call. Clicking them does nothing.
- `public-site/index.html:40`, `:48`, `product.html:24`, `shop.html:24` — the "Shop by Health Concern" / "Shop by Benefit" nav links point to `/shop?f=concern` / `/shop?f=benefit`. `f` is not a parameter `pages.js` reads (it reads `concern`/`benefit` directly) — these links carry no real slug and do not filter anything.
- This exact gap was already flagged in Phase 0 (`docs/AYURVEDICSTORE-PHASE-0-AUDIT.md:248`): the homepage mega-menu's category links ("Oral Care", "Diabetes Care", etc.) are hardcoded `<a href="/shop">` with no matching `categories` row at all — confirmed still true.

### 3.5 Knowledge Hub — CMS exists, no public page
- `supabase/schema.sql:213-225` — `blog_posts(title, slug, excerpt, body, cover_image, status, seo_title, seo_description, published_at)`.
- `server/src/routes/blog.js` — full staff CRUD + publish endpoint, RBAC-gated.
- `admin/blog.html` — working authoring UI.
- **`public-site/` has no `blog.html`, and `pages.js` has no `/blog` or `/blog/:slug` route.** A published post is currently unreachable by any shopper, on web or (since no API route exists either) Android.
- `blog_posts` has no relationship to `products`, `categories`, or ingredients — even once public pages exist, a post can't be surfaced contextually on a related product/concern page without new columns/join tables.

### 3.6 FAQs — do not exist
Every occurrence of "FAQ" in the codebase (`public-site/index.html:112`, `product.html:94`, `shop.html:82`) is the literal string `<a href="#">FAQ</a>` in the footer. No schema, no route, no admin surface.

### 3.7 Search — backend exists, unreachable from the UI, and narrower than advertised
- `server/src/routes/catalogPublic.js:141-151` — `GET /api/public/search?q=` works, requires `q`, reuses `listPublishedProducts`.
- `server/src/services/catalogService.js:109` — `if (q) query = query.ilike("title", ...)` — **matches product title only.** It does not search category (concern/benefit) names or the ingredients free-text field.
- Every page's `<form class="header-search">` (`index.html:25`, `shop.html:16`, `product.html:16`, etc.) has a plain `<input>` and a `<button type="button">` (not even `type="submit"`) with **zero JavaScript anywhere in the codebase wiring it up** (`public-site/js/site.js` has no search-related code at all). The placeholder text "Search products, concerns, ingredients..." currently over-promises what even a wired-up version of `/api/public/search` could deliver.

### 3.8 Related pattern already proven: Phase 1's public catalog API
`server/src/routes/catalogPublic.js` + `server/src/services/catalogService.js` is the correct, already-working template for Phase 3: platform-neutral `{success, data, meta}` JSON envelope (`server/src/utils/apiResponse.js`), input validation (`server/src/validation/validators.js`), RBAC-free public reads vs. RBAC-gated admin writes (`manageProducts` permission, same pattern used for Integrations' `manageIntegrations` in Phase 2). Any new Phase 3 entity (ingredients, FAQs, knowledge-hub posts) should follow this exact shape — it is what makes the API Android-ready today, and nothing in Phase 3's scope requires deviating from it.

---

## 4. Architecture Compatibility Check

| Constraint | Compatible? | Notes |
|---|---|---|
| Single-brand/manufacturer model | **Yes** | No seller/vendor concept exists anywhere in `products`/`orders`; nothing in Phase 3's scope requires one. |
| Deterministic/rule-based discovery | **Yes** | All existing filtering is plain SQL equality/`ilike` — no AI/ML anywhere in the catalog path. Phase 0 already scoped Phase 4's recommendation engine the same way ("explicit tag-matching, not a model") — Phase 3's product↔ingredient/concern/benefit relations are exactly the tag data that future rule-based logic would need. |
| REST API → business logic → DB layering | **Yes** | `catalogPublic.js` (routes) → `catalogService.js` (business logic) → `supabaseAdmin()` (DB) is a clean, already-proven 3-layer split Phase 3 can replicate for each new entity. |
| Future Android client | **Yes, and this is the right extension point** | `catalogPublic.js`'s JSON envelope is Phase 1's Android-readiness deliverable. New Phase 3 endpoints (ingredients, FAQs, richer categories, knowledge-hub posts) extending this same file/contract impose no Android rewrite risk — they're purely additive. The risk is the *opposite* direction: if Phase 3 UI work is done only as new SSR/`pages.js` templates without also exposing the same data via `catalogPublic.js`, Android would silently fall behind web. **Recommendation:** build every new Phase 3 data surface in the public JSON API first, then have both SSR and Android consume it — not the other way around. |

**No Android rewrite risk identified** — the existing API-first pattern already absorbs this phase's scope.

---

## 5. Gaps, Dependencies & Recommended Sequence

Dependency order (each step needs the one before it):

1. **Schema (additive only)** — new tables, no destructive changes to `products`/`categories`:
   - `ingredients (id, name, slug, description, ...)`
   - `product_ingredients (product_id, ingredient_id)` — many-to-many
   - `product_concerns` / `product_benefits` (or a single generalized `product_categories (product_id, category_id)` join table) — many-to-many, replacing the single-FK ceiling in §3.2. **`products.category_id` itself should likely stay** (cheap backward compatibility for existing single-select admin UI/API consumers) with the new join table(s) additive alongside it — a decision, not a given (§6).
   - Enrich `categories` with `description`, `hero_image`, `seo_title`, `seo_description` so a concern/benefit slug can back a real landing page, not just a filter.
   - `faqs (id, question, answer, product_id nullable, sort_order)` — nullable `product_id` supports both global and per-product FAQs in one table.
   - A `type='goal'` addition to `categories`' check constraint, or a decision that Goals are out of scope / a rename of Benefit (§6).

2. **Admin CMS** — category CRUD UI (currently API-only, §3.3), ingredient CRUD, product↔ingredient/concern/benefit relationship editor (multi-select, replacing the current single `<select>` in `product-form.html`), FAQ CRUD.

3. **Public JSON API extensions** (`catalogPublic.js` pattern) — `/ingredients`, `/ingredients/:slug`, `/faqs`, richer `/categories/:slug` (for landing-page content), multi-value concern/benefit filtering on `/products`.

4. **Public UI** — wire the existing `shop.html` sidebar to real `?concern=`/`?benefit=` URLs (the backend already works — this is pure front-end wiring), wire the header search form to `/api/public/search` and broaden that search to cover category/ingredient names, build ingredient/concern/benefit landing pages, build the public blog/knowledge-hub pages + route, add an FAQ section, build comparison UI.

5. **SEO cleanup** (ties into the Phase 0 §13 gap) — once real concern/benefit slugs exist with content, fix the hardcoded homepage mega-menu links (§3.4) to point at real, indexable `/shop?concern=...` landing pages instead of the generic `/shop`.

Product comparison has no natural dependency on the above (it can be built off `product_variants` + whatever attributes are chosen) but needs its own scope decision first (§6).

---

## 6. Blockers / Decisions Required

These are genuine open questions — this audit does not resolve them, since resolving them means designing Phase 3, not auditing the current state:

- **DECISION NEEDED:** Keep `products.category_id` as-is (single "primary" category, back-compat) and add new many-to-many join tables alongside it, or migrate away from `category_id` entirely? Affects every admin/API consumer of the existing field.
- **DECISION NEEDED:** What is a "Goal" as distinct from a "Benefit"? No prior definition exists anywhere in the codebase or Phase 0-2 docs. Needs a content/product decision before any schema work, not an engineering guess.
- **DECISION NEEDED:** FAQ scope — global site FAQs, per-product FAQs, or both (schema above assumes both via nullable `product_id`, but this needs confirming).
- **DECISION NEEDED:** Product comparison scope — compare variants within one product (pack sizes), or compare across different products? The latter needs a defined, finite set of comparable attributes (price, weight, ingredients?) decided up front.
- **DECISION NEEDED:** Search scope — is "search concerns/ingredients" (already implied by the existing, currently-false placeholder text) an explicit Phase 3 requirement, or should the placeholder simply be corrected to match the narrower title-only reality until Phase 3 lands?

---

## 7. Recommendation

**NOT READY for Phase 3 implementation to begin.**

The architecture is ready — REST/service/DB layering, RBAC pattern, and the Android-facing JSON envelope all extend cleanly with zero rewrite risk. What's missing is the Phase 3 content model itself: no structured ingredient/FAQ/rich-category schema exists yet, the one structural relationship that does exist (`category_id`) is a single FK that cannot represent the many-to-many reality Discovery needs, and several scope terms in the brief (Goals, FAQ scope, comparison scope) have no prior definition anywhere in this codebase to build from.

**Before writing any code:** resolve the five decisions in §6, then implement in the order given in §5 (schema → admin CMS → public API → public UI → SEO). Every piece of that sequence has a directly analogous, already-working precedent elsewhere in this codebase (Phase 1's catalog API, Phase 2's Integration Management CRUD+RBAC pattern) — this is additive engineering on a proven shape, not a design-from-scratch effort, once the content decisions above are made.
