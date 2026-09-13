# AyurNova — Phase 9A P0 Production Blocker Closure

**Scope:** The 3 confirmed P0 blockers from `AYURNOVA-PHASE-9-PRODUCTION-READINESS-AUDIT.md` (P0-1 mobile nav, P0-2 legal CMS, P0-3 insecure secret fallbacks). No Phase 9B+ work, unrelated refactors, DB migrations, Android/native code, or visual redesign beyond the mobile-nav fix was touched.
**Method:** Direct code inspection before any change, headed-browser Playwright verification (Chromium, `headless:false`) at 390×844 and desktop, the full external `ayurvedicstore-qa` suite (144 API-mode tests + headed e2e), and the in-repo `dev-harness` suites, all run against a live local instance.
**Baseline:** Phase 9 audit (re-verified, not assumed).

---

## Summary

| Blocker | Status |
|---|---|
| P0-1 Mobile navigation overflow | **FIXED + VERIFIED** |
| P0-2 Legal CMS publishing | **BLOCKED** (business content not available — correctly not fabricated) |
| P0-3 Insecure secret fallbacks | **FIXED + VERIFIED** |

**Production-readiness status:** 2 of 3 P0 blockers are closed. The remaining blocker (P0-2) is a business content-authorship gap, not a code/config defect — the CMS mechanism itself was independently re-verified as correct and safe (drafts never leak to the public site). **Do not launch until real, business-approved legal copy is authored and published** through the existing, fully-functional Admin → Legal Pages workflow. Nothing else in this report blocks launch.

---

## P0-1 — Mobile Navigation Overflow

**Root cause:** `public-site/css/style.css:110-112` — `.main-nav .container{ display:flex; }` had no wrap/scroll escape, and every nav link (`.main-nav > .container > a`) was `white-space:nowrap`. Below the header (which already had `flex-wrap:wrap` and rendered correctly), the nav row's total width exceeded the viewport with nowhere for the overflow to go, pushing the whole page 275–504px wider than the screen and visually cutting off/overlapping the trailing links ("Knowledge Hub", "About Us") on every storefront page.

**Fix:** `public-site/css/style.css` — added one scoped `@media (max-width:640px)` block that turns `.main-nav .container` into a horizontally-scrollable strip (`overflow-x:auto`, hidden scrollbar, `-webkit-overflow-scrolling:touch`) instead of hiding/wrapping links. This is one of the two remediation patterns the audit itself named as acceptable ("hamburger/collapsed menu **or horizontal scroll with wrapping**"). It was chosen over a hamburger drawer because:
- It is a single-file, CSS-only change. The public site has no shared header partial — all ~18 page templates (`public-site/*.html`) each embed their own copy of the header/nav markup, with real inconsistencies between them (some use inline SVG icons, some use emoji; nav link sets differ per page). A hamburger toggle would require touching all 18 files with no way to test each one's specific markup shape without materially raising the risk of breaking a page — out of proportion to a P0 CSS bug.
- Because the fix lives entirely in shared `style.css` behind a `max-width:640px` query, it applies uniformly and correctly to every page automatically, and is provably inert on desktop (query never matches).
- Mega-menus (hover-only, no touch equivalent) are explicitly hidden below the breakpoint rather than shipping a broken/mispositioned dropdown against the new scroll container.

**Customer/Admin UI visibility:** Public storefront only (every page with the shared header/nav — Home, Shop, Cart, Account, Product, Checkout, etc.). No admin panel changes.

**Verification (headed Chromium, `headless:false`):**

| Page | Before (390×844) | After (390×844) | Desktop (1440×900) |
|---|---|---|---|
| Home | 504px horizontal overflow | **0px** | 0px (unchanged) |
| Shop | 504px horizontal overflow | **0px** | 0px (unchanged) |
| Cart | 275px horizontal overflow | **0px** | 0px (unchanged) |
| Account | 275px horizontal overflow | **0px** | 0px (unchanged) |

Before numbers exactly reproduce the audit's own measurements, confirming the same defect. After numbers show `document.documentElement.scrollWidth - clientWidth === 0` on all four pages at 390×844, with desktop (1440×900) unaffected pixel-for-pixel — the media query never fires there. Screenshots captured for all 8 combinations (before/after × 4 pages) plus a desktop homepage screenshot showing all 8 nav links rendering normally, unchanged.

**Regression:** Full `ayurvedicstore-qa` `--project=api` suite (144 tests: smoke/api/security/regression) — **144/144 pass**. `dev-harness/healthcheck.js` — **21/21 pass**.

---

## P0-2 — Legal CMS Publishing

**Root cause (confirmed, re-verified, unchanged from audit):** All four legal pages (`terms-and-conditions`, `privacy-policy`, `return-refund-policy`, `shipping-policy`) remain exactly as seeded by `supabase/migrations/0009_phase7_notifications_and_legal_cms.sql` — `status='draft'`, `content_html` still the literal auto-generated placeholder text ("DRAFT — BUSINESS CONTENT REQUIRED..."), `updated_by: null` on all four rows (confirmed via live `GET /api/admin/legal-pages` — no admin has ever edited them). Public URLs 404 (`server/src/routes/pages.js:626-636` only serves `status='published'`).

**Investigation performed:** Searched the entire project (`docs/product-strategy/`, migrations, and the live database) for any business-approved legal copy that simply hadn't been published yet. **None exists anywhere in the project.** The only content present is the auto-generated placeholder.

**Action taken:** None to the content — per explicit instruction, no legally authoritative Terms, Privacy, Return/Refund, or Shipping copy was invented. Fabricating plausible-sounding legal text and publishing it would be **worse** than the current safe-by-default 404 state (it would look real to a customer or regulator while being unapproved and potentially wrong).

**What was verified instead** (the CMS *mechanism*, independently re-confirmed safe and fully functional, so the business can publish the moment real copy exists):
- `GET/PUT/POST /api/admin/legal-pages/*` correctly reject unauthenticated requests — `401` confirmed live for both GET and PUT.
- `requirePermission("manageSettings")` gates the whole router (SuperAdmin/Admin only).
- Server-side rich-text re-sanitization on both save (`legalAdmin.js:58`) and public render (`pages.js:641`) — never trusts the browser alone.
- The public route checks `status='published'` **outside** the render cache specifically so a publish takes effect immediately, not after a stale-cache delay.
- Admin → Legal Pages UI (`admin/legal-pages.html`) loads correctly and lists all four pages with accurate `draft` status and per-page Edit actions (screenshot captured, logged in as SuperAdmin via the same JWT flow the login page uses).
- Public URL `/terms-and-conditions` confirmed live `404` (screenshot captured) — draft content never leaks, exactly as designed.

**Customer/Admin UI visibility:** No change. Public: all four legal URLs still 404. Admin → Legal Pages: all four pages still show `draft`, fully editable/publishable the moment real content is supplied.

**Remaining blocker:** Genuine business-content approval is missing. **Required action before launch:** the business must author real Terms & Conditions, Privacy Policy, Return & Refund Policy, and Shipping Policy copy and publish each via Admin → Legal Pages → Edit → Publish. No code or config change can close this gap — this is explicitly reported as a **remaining P0 blocker**, not fixed.

---

## P0-3 — Insecure Secret Fallbacks

**Root cause (confirmed, re-verified):** `server/src/config.js` previously read `JWT_SECRET` and `INTEGRATION_ENCRYPTION_KEY` with a hardcoded, source-committed fallback (`"dev-secret-change-me"`, `"dev-insecure-integration-key-change-me"`) whenever the env var was unset, with no startup check. If either were ever missing in production: admin JWTs (`server/src/auth/adminAuth.js`) become forgeable, and/or Razorpay/SMS/email/WhatsApp credentials (`server/src/integrations/crypto.js`, AES-256-GCM) get encrypted with a key visible in the public source tree — effectively plaintext.

**Fix — `server/src/config.js`:**
- Removed both hardcoded fallback literals entirely.
- Added `requireSecret(envVar, { minLength: 32 })`, called for both `JWT_SECRET` and `INTEGRATION_ENCRYPTION_KEY`, that throws a fatal, boot-blocking error (before the server ever binds a port, in **every** environment — not gated behind `NODE_ENV`, since the audit's own finding was that no check existed at all) when the variable is:
  - **missing/empty**, or
  - **too short** (< 32 characters), or
  - a **known placeholder/weak value** — including the two old hardcoded defaults themselves (so copy-pasting them into `.env` is still rejected) and the literal example text from `.env.example`.
- Every error message names only the variable and a generic remediation hint (with a one-line command to generate a real secret) — **never the configured value itself**, satisfying "never expose secret values in logs/errors/UI."

**Supporting changes:**
- `server/.env.example` — added the previously-undocumented `INTEGRATION_ENCRYPTION_KEY` (closing audit item P2-5 as a direct side-effect of this fix) and strengthened both secrets' comments with the new fail-fast requirement and a generation command.
- `server/.env` (local, gitignored, never committed) — both secrets replaced with real 96-hex-char random values generated via `crypto.randomBytes(48)`, so local dev now explicitly supplies real config rather than relying on any fallback.
- **Necessary consequence handled:** rotating `INTEGRATION_ENCRYPTION_KEY` made the one pre-existing encrypted credential in the local dev DB (a Razorpay Test key secret + webhook secret) undecryptable under the new key. This was **not** left broken: a one-off migration re-encrypted that row from the old key to the new key (decrypt-old → re-encrypt-new, direct DB update, no application code touched), verified by re-checking the Admin → Integrations page shows the identical masked secret (`••••••••••••••••••••FDKM`) as before the rotation, with `Last test: success` intact and no error. In a real production rotation this same step (or re-entering credentials via Admin → Integrations) is required and is noted for ops.
- Added `server/dev-harness/test-phase9a-secrets.js` (wired to `npm run dev:test-phase9a-secrets` in `server/package.json`) — spawns fresh Node processes with each variable forced missing / too-short / a known placeholder, and asserts config load throws before boot and never echoes the rejected value. **9/9 assertions pass.**

**Customer/Admin UI visibility:** None directly. This is a startup/config-layer change; admin login and all integration-secret-dependent flows (Razorpay) were verified still functioning identically after the change.

**Security impact:** Eliminates the two "secure only if an env var happens to be set" findings the audit flagged as the sole MEDIUM-severity security gaps in the entire codebase. Production can no longer silently boot with a forgeable admin JWT secret or a publicly-known encryption key.

**Verification:**
- Server restarted clean with the new strong secrets — `GET /api/health` → `200`.
- `node dev-harness/test-phase9a-secrets.js` — **9/9 PASS** (boots with real secrets; fails fast on missing/weak/placeholder JWT_SECRET and INTEGRATION_ENCRYPTION_KEY; never leaks the rejected value in error output).
- `npm run dev:healthcheck` — **21/21 PASS**.
- `ayurvedicstore-qa --project=api` (smoke/api/security/regression) — **144/144 PASS**.
- Admin → Integrations page reloaded post-rotation: Razorpay Test row still shows `Key Secret: configured`, `Webhook Secret: configured`, `Last test: success` (screenshot captured) — no data loss, no 500.

---

## Regression Status (Phase 0–8 / UI-1)

- `ayurvedicstore-qa --project=api`: **144/144 pass** (smoke, api, security, regression) — matches the Phase 9 audit's own baseline count exactly.
- `ayurvedicstore-qa --project=chromium` (headed e2e): **5 passed, 2 failed** — both failures are **pre-existing and out of this session's scope**, confirmed by direct inspection, not introduced by any Phase 9A change:
  - `storefront.e2e.spec.js` — asserts the pre-rebrand brand text `"AyurVeda Store"` against the current, correct `"AyurNova"` branding. This is audit item **P3-1**, already documented as a stale QA-repo assertion, not a product defect.
  - `dosha-test` quiz — `#quiz-question` renders empty because `/api/public/wellness/assessment` currently returns zero published questions. This is audit item **P1-1** (Wellness Assessment has zero published content), explicitly scoped to Phase 9B, not 9A.
- `server/dev-harness/healthcheck.js`: **21/21 pass**.
- `server/dev-harness/test-phase7-notifications.js`, `test-phase8a-tax.js`, `test-phase8b-shipping.js`, `test-phase8c-wishlist.js`, `test-phase8d-buy-again.js`: all pass (DB-write lifecycle sections remain gated behind `DEV_HARNESS_ALLOW_WRITE`, their existing, unchanged design).

No regression was introduced in any Phase 0–8/UI-1 area by this session's changes.

## Android/Mobile Impact

None beyond P0-1 itself. This remains a **headed-Chromium viewport simulation (390×844)**, not a real Android device test — consistent with the Phase 9 audit's own stated limitation. The CSS fix is a standard responsive pattern (`overflow-x:auto` on a flex row) with no JavaScript and no native/WebView-specific behavior, so no additional Android-specific risk is introduced, but real-device verification remains untested, same as before this session.

## Remaining Blockers / Limitations

1. **P0-2 (Legal CMS content)** — genuinely unresolved, requires a business action (author + publish real legal copy), not an engineering fix. Everything else needed for launch on this item is already correct and verified.
2. All P1/P2/P3 items from the Phase 9 audit are unchanged and explicitly out of this session's scope (Phase 9B+), including: Wellness Assessment has zero published questions (P1-1), COD eligibility not enforced server-side (P1-3), no persistent error log (P1-5), and the rest of the P1/P2/P3 table in the Phase 9 audit.
3. Production vs. dev Supabase project identity is still unconfirmed (unrelated to any P0 item; flagged again here only because the Phase 9 audit's own "Recommended Phase 9 Implementation Order" lists it alongside the P0s as a pre-launch business action item, not a P0 finding itself).

## Production-Readiness Status

**READY WITH ONE REMAINING CONDITION.** P0-1 and P0-3 are fixed and verified with no regressions. P0-3 removes the last MEDIUM-severity security gap the audit found anywhere in the codebase. P0-2 cannot be closed by engineering work — it requires the business to author and publish real legal content through the now-independently-reverified Admin → Legal Pages workflow. **Do not launch checkout to real customers until that content is published.**

## Commit

See the Phase 9A commit in `feature/phase-8a-tax-invoicing` (not pushed, per instructions). Files changed:
- `public-site/css/style.css` (P0-1)
- `server/src/config.js` (P0-3)
- `server/.env.example` (P0-3 documentation)
- `server/package.json` (new regression-test script)
- `server/dev-harness/test-phase9a-secrets.js` (new regression test)
- `docs/product-strategy/AYURNOVA-PHASE-9A-P0-CLOSURE.md` (this report)

`server/.env` was updated locally with real random secrets and is gitignored — never committed.
