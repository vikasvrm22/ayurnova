# AyurNova — Phase 9 Production Readiness Audit

**Audit type:** Read-only. No code, configuration, dependency, or UI changes were made during this session.
**Baseline:** Phase 0 → 8A → 8B → 8C → 8D → Phase UI-1 (PASS WITH DOCUMENTED LIMITATIONS), re-verified against current code, not assumed correct.
**Method:** Direct code inspection (5 parallel domain audits, each citing file:line evidence), execution of the existing `dev-harness/healthcheck.js`, and execution of the full external `ayurvedicstore-qa` Playwright suite (smoke/api/security/regression in API mode, e2e in **headed** browser mode) against a live local instance, plus a headed-browser mobile-viewport check (390×844, simulated — **not** a real Android device).

---

## Executive Summary

The backend commerce core (checkout pricing, Razorpay signature/webhook verification, refund amount validation, FEFO stock allocation with row-level locking, RLS coverage, RBAC gating, invoice-number concurrency safety) is **solid and well-engineered** — 144/144 existing automated tests pass, and five independent domain audits found no exploitable security or money/stock-integrity defect in any of the core money/stock paths. The system's real production risk is **not** in the transaction core; it is in (a) two go-live content/config gaps (legal pages still unpublished drafts; zero published Wellness Assessment questions), (b) a genuine mobile-navigation defect discovered by direct headed-browser testing that breaks the storefront nav on every page at phone width, and (c) a small number of "insecure-fallback-if-env-missing" patterns that are fine today but become critical the moment a required environment variable is forgotten in production. There is also no production hosting/CI/CD configured yet (expected at this stage, not a defect).

## Overall Production Readiness

**READY WITH CONFIGURATION** — contingent on closing the P0 items below (legal content, mobile nav, env-var hardening) and making the P1 business decisions (COD server-side gate, courier integration plan, GST rollout plan). The codebase does not need architectural rework to launch.

---

## P0 — Critical Production Blockers

| ID | Finding | Evidence | Impact | Required Action |
|---|---|---|---|---|
| P0-1 | **Storefront main navigation overflows horizontally on every customer page at mobile width**, breaking the header/nav layout. Confirmed by direct headed-browser measurement: 504px of horizontal overflow on Home/Shop, 275px on Cart/Account at a 390px (iPhone-class) viewport. | `public-site/css/style.css:110-112` — `.main-nav .container{display:flex}` has no `flex-wrap`/collapse, and nav links are `white-space:nowrap`; `.header-icons`/`.header-search` also collide at this width. Screenshots captured this session show "Knowledge Hub"/"About Us" and the account icon visibly cut off/overlapping. | The primary nav is unusable/visually broken for the majority of real-world e-commerce traffic (mobile). This is a UX-breaking regression, not a cosmetic one. | Add a mobile nav pattern (hamburger/collapsed menu or horizontal scroll with wrapping) below a breakpoint before launch. |
| P0-2 | **Legal pages (Terms, Privacy, Return & Refund, Shipping Policy) are seeded as unpublished drafts with literal placeholder text**, so every legal URL currently 404s on the live site. | `supabase/migrations/0009_phase7_notifications_and_legal_cms.sql:87-95` (seed status `'draft'`, placeholder text "DRAFT — BUSINESS CONTENT REQUIRED..."); `server/src/routes/pages.js:634-636` (only `status='published'` is served). | An e-commerce business cannot legally launch checkout without live Terms/Privacy/Refund/Shipping content. The mechanism is correct and safe (no unapproved content can leak) — this is a content gap, not a code bug. | Business must author real legal copy and publish all four pages via Admin → Legal Pages before go-live. |
| P0-3 | **`JWT_SECRET` and `INTEGRATION_ENCRYPTION_KEY` silently fall back to hardcoded, publicly-visible default values** (`"dev-secret-change-me"`, `"dev-insecure-integration-key-change-me"`) if the corresponding env var is unset — no startup check enforces they be set. | `server/src/config.js:9` (JWT), `server/src/config.js:51` (encryption key); confirmed used at `server/src/auth/adminAuth.js:4-10` and `server/src/integrations/crypto.js:16-22`. | If either var is missing in the production environment, admin JWTs become forgeable and/or Razorpay/SMS/email secrets are encrypted with a key visible in the public source tree — effectively as bad as plaintext. This is CRITICAL *if* it happens, and currently unguarded against happening. | Before deploy: confirm both vars are set in the production environment. Recommended: add a startup assertion that refuses to boot in production without them (implementation deferred to Phase 9 build). |

## P1 — High Priority

| ID | Finding | Evidence | Impact | Required Action |
|---|---|---|---|---|
| P1-1 | **Wellness Assessment (Dosha Test) has zero published questions** in the current database — the feature is prominently linked from the main nav and homepage but is currently non-functional for real users (shows an honest "not available yet" state, not a crash). | Confirmed live: `GET /api/public/wellness/assessment` → `{"items":[]}`; `public-site/dosha-test.html:73-76` (empty-state branch). | A featured, nav-visible capability is dead on arrival. | Author and publish Wellness Assessment questions via Admin → Wellness before launch, or remove the nav/homepage entry points until content exists. |
| P1-2 | **No real courier/shipping provider integration exists** — "manual" is the only registered provider; every shipment field (AWB, courier, status, tracking URL) is staff-typed, with no live tracking pull from any courier API. | `server/src/integrations/shipping/registry.js:10-16`; `server/src/integrations/shipping/manual/provider.js:61-81` (no outbound HTTP calls). | Any claim of "real-time tracking" to customers would be inaccurate. Acceptable for a manual-fulfillment launch, but a real capability gap if live tracking is promised. | Business decision: launch with manual tracking entry, or integrate a real courier (Shiprocket/Delhivery/etc.) first. The provider-abstraction pattern is ready for this. |
| P1-3 | **COD eligibility is not enforced server-side** — the admin "COD Available" toggle only controls a cosmetic storefront badge; a direct API call to `/api/public/checkout` with `payment_method:"cod"` succeeds even if COD has been disabled by an admin. | `server/src/routes/public.js:26` (setting read for display only), `:75` (validation has no `trust_badges` check). | Business-rule bypass (not a payment-security or fraud hole) — an admin who disables COD cannot actually stop COD orders via the API. | Add a server-side check of `settings.trust_badges.cod` in the checkout route's payment-method validation. |
| P1-4 | **No credit-note mechanism, and the return-refund amount cap is documented as incorrect in GST-exclusive mode.** Both are currently dormant because `gst_registered` defaults `false` (all rates 0). | `supabase/migrations/0010_phase8a_tax_invoicing.sql:96-98` ("credit notes are explicitly out of scope"); `server/src/routes/returnsAdmin.js:96-116` (cap formula flagged as inclusive-mode-only in its own comment). | Becomes a real compliance/financial-correctness gap the moment GST registration is turned on and GST-exclusive pricing with any refund is used. | Resolve before flipping `gst_registered=true` in exclusive mode: either restrict launch to inclusive-mode GST, or implement credit-note logic and fix the exclusive-mode refund cap. Needs GST-advisor sign-off either way (see GST section). |
| P1-5 | **No persistent, centralized error/exception log.** The global error handler only `console.error`s (server-side only, not visible to admins); analytics-flush failures and any exception thrown *before* a notification's own try/catch (e.g. inside `resolveRecipient`) leave zero trace an admin could find after the fact. | `server/src/middleware/errorHandler.js:21-32`; `server/src/analytics/tracker.js:33,46,52`; `server/src/notify/notificationService.js:211-213`. | A background failure outside the paths that already write to `notification_log`/`webhook_events` (item confirmed elsewhere as well-covered) is invisible to operations. | Add a minimal persistent error log (even a simple DB table) for unhandled exceptions before launch, or ensure stdout/stderr is captured by the hosting platform's log aggregation as a stop-gap. |
| P1-6 | **Notifications are single-attempt with no retry.** A transient SMTP/SMS/WhatsApp outage permanently fails that one customer notification; there is no scheduled or admin-triggered resend. | `server/src/notify/notificationService.js:134-175` (one `send()` call, no retry loop); `server/src/routes/notificationsAdmin.js:1-7` (explicitly "no write routes at all — no manual resend action"). | A customer may never receive an order/shipment notification if the provider had a brief outage at the exact send moment. Failures ARE visible in admin history (not silent). | Consider a retry-with-backoff or an admin "resend" action in a future phase; not a launch blocker given failures are visible, but a real operational gap. |
| P1-7 | **SSR page cache is not invalidated on publish**, and the HTML **template cache never expires without a server restart.** | `server/src/routes/pages.js:19-27` (5-min in-memory `Map`, `config.ssrCacheTtlMs` default 300000ms); `server/src/seo/templates.js:10-20` (`clearTemplateCache()` exported but never called anywhere — confirmed via repo-wide grep). | A newly published product can be invisible on Home/Shop for up to 5 minutes (self-heals). More importantly: **any HTML template edit requires a full server restart to go live** — an easy-to-forget operational gotcha that looks like a broken deploy. | Document this restart requirement prominently in deployment runbook; consider wiring `clearTemplateCache()` into the admin publish/save flows in a future phase. |
| P1-8 | **No true bank/gateway settlement reconciliation** — confirmed by direct grep that the string "settlement" appears nowhere in the payment logic except a comment self-disclosing the gap. Reconciliation only compares local payment status against Razorpay's Payments API, never a Settlements/bank-transfer record. | `server/src/routes/paymentsAdmin.js:78-85`. | Finance/accounting cannot use the in-app Reconciliation screen to confirm money actually settled to the bank account. This was already correctly self-disclosed in the Phase UI-1 report, re-confirmed here as accurate, not overstated. | Out of scope for a UI/code fix — requires a genuinely new integration (Razorpay Settlements API) if/when needed; treat as a known, accepted gap for launch. |

## P2 — Medium Priority

| ID | Finding | Evidence | Impact | Required Action |
|---|---|---|---|---|
| P2-1 | Admin order-cancellation route has an unguarded read-then-write window that could let two near-simultaneous admin cancel actions on the same order both trigger a restock (double-credit stock), unlike the customer-facing cancel route which is correctly guarded. | `server/src/routes/orders.js:96-150` (no `.eq("status", existing.status)` guard) vs. `server/src/routes/orderDetailPublic.js:161-186` (guarded). | Low-likelihood (requires two near-simultaneous admin writes to the same order), stock-inflating, not stock-negative. | Add the same conditional-update guard used on the customer route. |
| P2-2 | CORS origin defaults to `"*"` when `CORS_ORIGIN` is unset. | `server/src/config.js:16`. | Low real risk given the app's same-origin architecture, but a latent misconfiguration if ever fronted differently with credentialed requests. | Set `CORS_ORIGIN` explicitly in production env. |
| P2-3 | Payment `/retry` has no cap on the number of retry attempts per order. | `server/src/routes/paymentsPublic.js:41-60`; `server/src/services/paymentService.js:32-83`. | Could be used to spam Razorpay order-creation on one order indefinitely; mitigated somewhat by the generic 400-req/15-min rate limiter, not a dedicated cap. | Add a reasonable per-order retry cap. |
| P2-4 | No admin warning/banner when both Test and Production Razorpay environments are simultaneously enabled. | `admin/integrations.html:66` (text-only explanation). | Credential-hygiene risk (stale test webhook secret left active indefinitely), not a charge-routing bug — the actual payment call always deterministically picks one environment. | Add an admin-facing warning banner in a future phase. |
| P2-5 | `INTEGRATION_ENCRYPTION_KEY` is used in code but missing from `server/.env.example` — a setup-documentation gap that makes it easier to accidentally omit in production. | `server/src/config.js:51` vs. `.env.example` contents. | Increases the odds of hitting P0-3 by omission. | Add it to `.env.example` with a clear "must be set in production" comment. |
| P2-6 | No images anywhere in `public-site/*.html` use `loading="lazy"`. | Confirmed via repo-wide grep, 0 matches. | Slower first paint / higher bandwidth on image-heavy pages (Shop grid, Home). | Add `loading="lazy"` to below-the-fold product images. |
| P2-7 | No cron/scheduler infrastructure exists anywhere (no `node-cron`/`agenda`/equivalent) — only an in-process `setInterval` for analytics flushing. | Repo-wide grep, no matches. | Any future need for periodic jobs (abandoned-cart emails, low-stock/near-expiry alerts, session cleanup) has no runner to build on yet. | Add a scheduler when the first such feature is actually needed; not required for launch as no current feature depends on one. |
| P2-8 | Shop-page canonical URL collapses when a `category` filter (or multiple simultaneous filters) is applied — canonicalizes to the unfiltered `/shop` instead of the filtered URL. | `server/src/routes/pages.js:315` (only one filter type is used to build the canonical `url`). | Minor duplicate-content SEO risk, not a missing-canonical defect (canonical tag is always present). | Extend the canonical-URL builder to account for `category` and multi-filter combinations. |
| P2-9 | `robots.txt` does not explicitly disallow `/admin`. | `server/src/routes/pages.js:786-788` (only disallows `/cart`, `/account`, `/compare`, `/for-you`). | Defense-in-depth gap only — admin isn't linked from any public page and requires auth regardless. | Add `/admin` to the disallow list for completeness. |
| P2-10 | Notification templates are hardcoded strings, not admin/DB-editable. | `server/src/notify/notificationService.js:55-107`. | Any copy change requires a code deploy. No placeholder/lorem-ipsum content ships — this is a flexibility gap, not a defect. | Consider admin-editable templates in a future phase. |

## P3 — Low / Polish

| ID | Finding | Recommendation |
|---|---|---|
| P3-1 | The external `ayurvedicstore-qa` suite's `storefront.e2e.spec.js` still asserts the pre-rebrand brand text `"AyurVeda Store"` and fails against the current (correct, approved) `"AyurNova"` branding. | Update that one assertion in the QA repo to match the approved rebrand — expected staleness, not a product defect. |
| P3-2 | Site has no favicon (pre-existing, noted in the Phase UI-1 report). | Add a favicon; cosmetic only. |
| P3-3 | Several Phase UI-1 admin screens (Integrations/Razorpay Config layout, Payments List stat-card row, dedicated Refund Detail page) were intentionally kept on their existing functional layouts rather than fully rebuilt to match the reference design, per that phase's own documented, time-boxed scope decision. | Optional polish for a future UI phase; all underlying functionality is real and already verified working. |
| P3-4 | GST rounding is per-line rather than per-order-total; acceptable practice but not independently validated against the business's actual GST-filing rounding convention. | Confirm with GST advisor before high-volume use. |

---

## Completed / Verified Areas

Confirmed correct with direct evidence in this audit (no gap found): customer JWT verification (real Supabase round-trip, never locally trusted), admin bcrypt+JWT auth, RBAC gating on every inspected route including all new Phase UI-1 endpoints, RLS enabled and correctly scoped on all 50 tables checked, service-role key never exposed client-side, parameterized queries everywhere (no raw SQL/injection surface found), generic error responses (no stack/internal leakage), webhook signature verification (timing-safe, correctly rejects invalid signatures without a quiet 200), server-computed checkout pricing, payment-verify/webhook idempotency (unique-constraint + conditional-update guards), refund amount validation and failure-safe state handling, FEFO stock allocation with real row-locking (no oversell/negative-stock path found), cancellation restock traceability (customer path), delivered_at atomicity, COD-refund server-side gating, RTO QC intake, duplicate-shipment prevention (app + DB constraint), non-blocking notification dispatch (verified bulletproof by design), wishlist/buy-again ownership and dedup/live-pricing logic, dosha scoring (real vote-counting, no AI/randomness), invoice numbering (Postgres sequence, concurrency-safe), tax snapshotting (historical orders immune to later setting changes), SEO meta/canonical/JSON-LD coverage, sitemap generation (live data, not hardcoded), custom 404, image compression pipeline (product + Banners & Media), and full catalog query batching (no N+1 on listing pages).

## Phase 0–UI-1 Regression Status

No regressions found in any previously-completed phase's core logic. All phase-specific fixes previously documented in commit history (duplicate-shipment precedence `fb7646d`, `delivered_at` null bug `0c7ca45`) were independently re-verified as still correct in the current code, not merely assumed. The one genuine UI-era regression found is P0-1 (mobile nav overflow), introduced by Phase UI-1's nav restyle.

## Real Commerce Flow Status
Customer → Product → Variant → Cart → Checkout → Payment/COD → Order → Inventory → Invoice → Notification → Shipment → Delivery → Return → Refund: every transition was traced with evidence; no money-inconsistency, stock-inconsistency, or security-bypass path was found in the core flow. The two process gaps found (P1-3 COD server-side gate, P2-1 admin-cancel race) are both real but narrow (business-rule bypass and a low-likelihood stock over-credit, respectively) — neither can create negative stock or lose/duplicate money.

## Payment/Razorpay Status
READY, with two CONFIGURATION REQUIRED items (P0-3 secret env vars; P1-3 COD gate) and one self-disclosed, accurately-classified NOT IMPLEMENTED item (P1-8 settlement reconciliation — genuinely does not exist, confirmed by evidence, not assumed).

## GST/Invoice Status
Mechanically READY (snapshotting, HSN/rate flow-through, state-code comparison, sequence-based numbering all verified correct). Currently dormant (`gst_registered=false`). NEEDS GST-ADVISOR CONFIRMATION before enabling: place-of-supply defaulting logic, missing-state-code fallback, credit-note absence (P1-4), and invoice PDF legal-format completeness (not verifiable from code).

## Inventory Status
READY. Atomic, row-locked, real FEFO allocation; no oversell/negative-stock path found. One LOW-severity admin-side race (P2-1).

## Shipping Status
Functionally READY for **manual** fulfillment only (P1-2) — no real courier API integration exists. Status-sync and duplicate-prevention logic are solid.

## Notification Status
READY (non-blocking by design, verified bulletproof), with two acknowledged operational gaps: no retry (P1-6), no persistent generic error log (P1-5, partially covered by `notification_log` for send failures specifically).

## Security Status
No CRITICAL or HIGH findings in code as currently configured. Two MEDIUM findings are both "secure only if an env var is actually set" (P0-3, elevated to P0 here because the consequence of the fallback firing is critical) and CORS default (P2-2). All other inspected surfaces (auth, RBAC, RLS, injection, error leakage, file upload, webhook signatures) show no issue.

## Admin Operational Coverage
Verified via the Phase UI-1 work itself (first-hand) plus this audit: Dashboard, Products, Categories, Orders, Customers, Inventory, Payments, Refunds, Reconciliation (scope-limited, self-disclosed), Integrations, Webhooks, Notifications, Legal CMS, Tax Settings, Invoices, Shipping (manual-only), and Banners & Media (Image Manager) are all present and functional. No required operational UI is missing for the features that exist. Two backend capabilities have no UI by design (Activity Log browsing, a standalone Reports page) — correctly not invented per that phase's scope discipline.

## Customer UX/UI Coverage
Home, Shop, Search, Product Detail, Cart/Checkout, Login/Account, Order Detail, Wishlist, Buy Again, and all documented payment states are implemented with real data, honest empty/loading/error states, and correct out-of-stock handling (all independently re-verified as still true in this audit's Notifications/Discovery/Wishlist agent pass). The one real UX defect found is P0-1.

## Android/Mobile Status
**Viewport simulation only (headed Chromium at 390×844) — no real Android device was tested.** Found: P0-1 (nav overflow, confirmed on Home/Shop/Cart/Account). Not tested this session: touch-target sizing, on-screen keyboard behavior, real-device rendering differences.

## SEO Status
Strong overall (meta/canonical/OG/JSON-LD/sitemap/404 all real and dynamic). Minor gaps only: P2-8 (canonical collapse on filtered shop URLs), P2-9 (robots.txt admin path).

## Performance Status
No architectural performance problem found (queries are properly batched, images are compressed). Two real, actionable gaps: P2-6 (no lazy-loading) and P1-7 (cache staleness/restart-required gotcha).

## Observability Status
Payment, refund, webhook, and notification failures are all visible to admins via existing screens. Generic/background exceptions (P1-5) and analytics-flush failures are not persistently logged anywhere.

## Production Configuration Checklist

| Configuration | Required? | Current State | Owner/Action |
|---|---|---|---|
| `JWT_SECRET` | Yes | Falls back to an insecure default if unset (P0-3) | Ops: set a strong random value in production |
| `INTEGRATION_ENCRYPTION_KEY` | Yes | Falls back to an insecure default if unset (P0-3); missing from `.env.example` (P2-5) | Ops: set a strong random value in production |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Yes | Configured for the one existing Supabase project | Confirm this project is the intended production database (see below) |
| `CORS_ORIGIN` | Recommended | Defaults to `*` if unset (P2-2) | Ops: set to the real production domain |
| `SITE_BASE_URL` | Yes | Used for canonical URLs/sitemap/OG | Ops: set to production domain |
| Razorpay Production credentials | Yes (for live payments) | Stored encrypted via Admin → Integrations, not env vars | Business: enter live Key ID/Secret/Webhook Secret via Admin UI |
| Razorpay webhook URL (in Razorpay dashboard) | Yes | N/A | Ops: point to `https://<production-domain>/api/public/payments/webhook/razorpay` |
| Email/SMS/WhatsApp provider credentials | Yes (per channel desired) | Configured via Admin → Integrations | Business: enter real provider credentials |
| GST registration + tax profile | Business decision | Currently off (`gst_registered=false`) | Business + GST advisor: confirm before enabling (see GST section) |
| Legal page content | **Yes — P0** | Draft placeholders (P0-2) | Business: author and publish |
| Wellness Assessment questions | Recommended — P1 | None published (P1-1) | Business: author and publish, or hide the feature |
| Shipping/courier decision | Business decision | Manual-only today (P1-2) | Business: decide manual-launch vs. courier-integration-first |
| Hosting/CI-CD | Yes | Manual deployment documented (Railway example in SETUP.md); no CI/CD pipeline exists | Ops: provision production hosting per SETUP.md or an equivalent platform |
| Environment separation (dev vs. production Supabase project) | **Unresolved since Phase 0** | Only ONE Supabase project is configured anywhere in the codebase; Phase 0 could not confirm whether it's throwaway-dev or already production — the user opted to rotate its credentials rather than resolve this | **Business must explicitly confirm** whether this is the production database before go-live, or provision a separate one |

## Recommended Phase 9 Implementation Order

**9A — Go-live blockers (must complete before launch)**
1. Fix mobile nav overflow (P0-1).
2. Publish real legal page content (P0-2) — business action.
3. Verify/set `JWT_SECRET` and `INTEGRATION_ENCRYPTION_KEY` in production, add a startup guard against the insecure fallback (P0-3).
4. Confirm production vs. dev database identity (Production Configuration Checklist, last row) — business action.

**9B — High-priority hardening (strongly recommended before or immediately after launch)**
5. Server-side COD eligibility gate (P1-3).
6. Publish Wellness Assessment content or hide the feature (P1-1).
7. Add a minimal persistent error log for unhandled exceptions (P1-5).
8. Decide and document the shipping approach (manual vs. courier integration) (P1-2).
9. Resolve the GST-exclusive refund/credit-note gap before enabling GST registration (P1-4) — needs GST advisor.

**9C — Operational polish (post-launch acceptable)**
10. Admin-cancel restock race guard (P2-1).
11. Retry cap on payment retry (P2-3); CORS origin lockdown (P2-2); `.env.example` completeness (P2-5).
12. Lazy-loading images (P2-6); canonical/robots SEO polish (P2-8, P2-9).
13. Notification retry/resend tooling (P1-6); admin dual-environment warning banner (P2-4).

## Deferred / Future Work
Real courier API integration (beyond the 9B decision to launch manual-only), Razorpay Settlements reconciliation (P1-8, no code path to build on without a new integration), admin-editable notification templates (P2-10), scheduled-job infrastructure (P2-7) until a feature actually needs it, CI/CD pipeline, Phase UI-1's remaining cosmetic polish items (P3-3). None of these block launch.

## Final Recommendation
**Do not launch today as-is.** Close the four 9A items first — three are small, well-scoped fixes (nav CSS, env-var verification/guard) and one is a business content task (legal pages) that can proceed in parallel with the engineering fixes. Once 9A is complete, the system is genuinely ready for a real production launch: the transaction-critical code (payments, inventory, tax, security) is sound, tested, and shows no exploitable defect across five independent domain audits and 144 passing automated tests.

---

*Audit performed entirely read-only. No files in `ayur-app` or `ayurvedicstore-qa` were modified. `git status` in both repositories is clean except pre-existing untracked reference-design assets in `ayur-app` (`public-site/design-ref/`, `public-site/design-ref.zip`), unrelated to this audit and unchanged by it.*
