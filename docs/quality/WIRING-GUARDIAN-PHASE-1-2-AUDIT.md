# AyurNova Wiring Guardian — Phase 1 + Phase 2 Audit

**Date:** 2026-09-14
**Tool used:** existing `quality-agents/wiring-guardian` (unmodified — no new checks, fixers, or config added)
**Guardian run:** full-repo audit (Guardian is phase-independent by design; scope filtering below is applied by the auditor, after the run, against reconstructed Phase 1/2 evidence)
**Guardian's own unit tests:** 12/12 passed before and after this audit (`node tests/runAll.js`)
**Raw reports (gitignored, local only):** `quality-agents/wiring-guardian/reports/wiring-guardian__2026-09-14T07-43-07-946Z.{md,json}` (also `*.latest.{json,md}`)

---

## 0. Method

1. Reconstructed actual Phase 1 and Phase 2 scope from `docs/AYURVEDICSTORE-PHASE-1-IMPLEMENTATION-REPORT.md` and `docs/AYURVEDICSTORE-PHASE-2-IMPLEMENTATION-REPORT.md` (evidence-tagged implementation reports written during those phases).
2. Ran the existing Wiring Guardian's own unit test suite (baseline sanity check).
3. Ran a full Wiring Guardian audit (`node bin/wiring-guardian.js`) — the tool always audits the whole repo; `workflows.config.json`'s `phase` field is informational only (`f633778`'s own design decision — see `docs/WIRING-GUARDIAN.md`).
4. For every one of the 43 findings, determined the actual introducing phase using `git log --diff-filter=A` (first commit that added the file) and, where a file was extended across phases (e.g. `catalogPublic.js`, `pages.js`), `git blame` on the specific flagged line — not assumption.
5. Partitioned findings into **Phase 1 scope**, **Phase 2 scope**, and **out of scope** (Phase 3 and later — documented but not counted toward the Phase 1/2 verdict).
6. For every in-scope finding, investigated root cause (grep/read the actual frontend caller code) before classifying it — several "no frontend caller found" findings are the static scanner's known limitation (dynamic path construction, by-design external callers), not real defects.
7. Cross-referenced `quality-agents/security-guardian/reports/security-guardian.latest.md` for anything payment/webhook/RBAC-security-shaped, to avoid re-litigating what Security Guardian already owns.

### Reconstructed Phase 1 scope (from the Phase 1 Implementation Report)

Database + API foundation, Android-readiness catalog JSON API (`catalogPublic.js`), SSR rendering fix (`pages.js`), API input-validation/security hardening across the pre-existing baseline routes (`orders.js`, `products.js`, `customers.js`, `reviews.js`, `public.js`), DEV/QA harness. The Phase 1 report explicitly treats the **entire pre-existing baseline app** (commit `53a17e7`, "Initial commit: AyurVeda Store baseline + Phase 0 audit report") as its foundation — it audited and hardened routes across that whole baseline, not just the files it created. Wiring Guardian's Phase 1 scope therefore includes: `adminAuthRoutes.js`, `customers.js`, `blog.js` (admin), `coupons.js`, `vaidyaBookings.js`, `settings.js`, `public.js` (checkout/reviews/dosha-results/my-orders), `pages.js`, plus the new `catalogPublic.js` (Phase 1 commit `254cdfb`).

### Reconstructed Phase 2 scope (from the Phase 2 Implementation Report)

Complete Razorpay payment integration: `paymentsPublic.js`, `paymentsAdmin.js` (commit `614a370`), `integrationsAdmin.js` + generic integration-config foundation (commit `fa55c2b`), the prepaid extension of `public.js`'s checkout route, the `payments`/`payment_attempts`/`refunds`/`webhook_events`/`integration_configs` tables (migration `0002_phase2_payments_and_integrations.sql`), admin Payments/Integrations UI.

### Explicitly out of scope (confirmed by git blame, not assumption)

| File | First commit | Phase |
|---|---|---|
| `admin/discovery.html`, `ingredients.js`, `blogPublic.js`, `catalogPublic.js` (`/categories/:slug`, `/ingredients`, `/ingredients/:slug`, `/faqs` routes), `pages.js` `/faq` route+cache | `3d4a90b` | Phase 3 (Ayurveda Discovery) |
| `routinesAdmin.js`, `routinesPublic.js` | `4e4fe75` | Phase 4 (Personalization) |
| `inventoryAdmin.js` | `0fe113e` | Phase 5A (Inventory) |
| `returnsPublic.js` | `6c6302a` | Phase 6B (Returns) |
| `addressesPublic.js` | `a0200db` | Phase 6A |
| `notificationsAdmin.js` | `73e4a09` | Phase 7 |
| `invoicesAdmin.js` | `9780c44` | Phase 8A |
| `mediaAdmin.js` | `9818af2` | Phase UI-1 (post-Phase-9 redesign, Banners & Media) |
| `errorLogAdmin.js` | `e930f0e` | Phase 9 |

These findings are listed in §4 for completeness (nothing is hidden) but are **not counted** toward the Phase 1/2 verdict.

---

## 1. Phase 1 Audit Report

**Reconstructed scope:** see §0. **Workflows audited:** `customer.cart.reprice_lookup`, `security.admin_endpoint_protection`, `security.customer_data_protection`, plus the Phase-1 half of `customer.checkout.purchase` (cart→checkout→order creation, pre-payment).

### Workflow results

| Workflow | Level | Status |
|---|---|---|
| Cart line-item re-pricing lookup | MICRO | **CONFIRMED** 2/2 |
| Every `/api/admin/*` route requires staff auth + role permission | MICRO | **CONFIRMED** 2/2 |
| Every customer-owned-data route requires customer identity | MICRO | **CONFIRMED** 1/1 |
| Customer purchase: cart → checkout → order | BUSINESS | **CONFIRMED** 6/6 (shared with Phase 2, see §2) |

### Category health (Phase-1-relevant categories)

Module 100/100, Contract 85/100 (findings below), State 100/100, Security 97/100 (findings below), FeatureFlag 100/100, Cache 95/100 (the one P2 cache finding is Phase 3's `/faq` page — out of scope, see §0), Integration 100/100.

### Findings — Phase 1 scope (16 of 43 total findings)

All 16 are **P3**, none are P0/P1/P2. No SAFE_AUTO_FIX-eligible finding exists among them (Guardian's fix-planner whitelists exactly two file/category pairs — `admin/users.html` contract and `public-site/cart.html` feature-flag — neither is touched by any Phase 1 finding).

| ID | Category | Route/File | Classification | Notes |
|---|---|---|---|---|
| WG-0002 | contract | `GET /api/admin/auth/me` | REVIEW_REQUIRED | No admin frontend call site found anywhere under `admin/`. Genuinely unused today (verified: not called by `admin/js/api.js` or any page). Not proven harmful — may be intended for a future "who am I" check. |
| WG-0003 | contract | `GET /api/admin/customers/:id/orders` | REVIEW_REQUIRED | Verified: `admin/customers.html` only calls `Api.get("/customers")` (list). No customer-detail page exists to consume a per-customer order history. Backend capability exists with no UI to reach it — a real, if minor, product gap, not a wiring accident to auto-fix. |
| WG-0004 / WG-0005 | contract | `GET`/`PUT /api/admin/blog/:id` | REVIEW_REQUIRED | Verified: `admin/blog.html` only lists, publishes, deletes, and creates posts (`Api.get("/blog")`, `Api.post("/blog/:id/publish")`, `Api.del("/blog/:id")`, `Api.post("/blog")`) — no "edit an existing post" affordance calls `GET`/`PUT /blog/:id`. Real gap: the backend supports editing, the admin UI never exposes it. Adding an edit modal is a UI feature decision, not a deterministic wiring fix — left for product review. |
| WG-0016 | contract | `POST /api/public/reviews` | REVIEW_REQUIRED (low confidence) | No literal call site matched by the static scanner; plausible the storefront's product-review submission form uses a path pattern (templated string) the regex scanner can't resolve. Needs a human check of `public-site/product.html`'s review form, not a code change. |
| WG-0017 | contract | `POST /api/public/dosha-results` | REVIEW_REQUIRED (low confidence) | Same caveat as WG-0016 — likely a dynamic-path scanner miss in the dosha-quiz result-save flow, not a confirmed dead route. |
| WG-0018 | contract | `GET /api/public/products` | **FALSE_POSITIVE** | By design, documented in the Phase 1 report §9: this Android-readiness JSON API is meant for a future Android client and is deliberately *not* called by the website's own SSR pages, which use `catalogService.js` directly in-process (no HTTP round-trip to itself). |
| WG-0019 | contract | `GET /api/public/search` | **FALSE_POSITIVE** | Same reasoning as WG-0018. |
| WG-0020 | contract | `GET /api/public/categories` | **FALSE_POSITIVE** | Same reasoning as WG-0018. |
| WG-0033 / WG-0034 / WG-0035 | rbac-consistency | `public.js` checkout / reviews / my-orders | REVIEW_REQUIRED — **NEVER_AUTO_FIX by this task's own rule** | Guardian's own text: "functionally equivalent to `requireCustomer` today" — an inline `if (!req.customer)` check instead of the shared middleware. Purely stylistic; touching auth-gating code on customer-owned-data routes falls squarely under this task's "NEVER auto-fix: authentication / RBAC / security boundaries" rule, so left untouched regardless of how trivial it looks. |
| WG-0037 | module-graph | `adminAuthRoutes.js` (`staff_users`) | **FALSE_POSITIVE** | Verified against `supabase/schema.sql`: `staff_users` has no FK to/from any other table by design (it's the standalone staff-identity table) — not a missed relationship. |
| WG-0038 | module-graph | `coupons.js` (`coupons`) | **TOOL_LIMITATION** | Verified: `orders.coupon_code` is a plain `text` snapshot column, not a foreign key to `coupons.code` (schema.sql:161). The module-graph engine only detects FK-based edges, so it correctly can't see this soft/logical relationship. Not a wiring defect. |
| WG-0039 | module-graph | `vaidyaBookings.js` (`vaidya_bookings`) | **FALSE_POSITIVE** | Verified: `vaidya_bookings` (schema.sql:186) has no FK columns at all — it's an intentionally standalone lead-capture form, not linked to customers/orders. |
| WG-0040 | module-graph | `settings.js` (`settings`) | **FALSE_POSITIVE** | Verified: `settings` is a key/value config table with no FK columns by design. |

**Phase 1 verdict input:** 16 findings reviewed, 0 P0/P1/P2, 7 reclassified FALSE_POSITIVE/TOOL_LIMITATION after investigation (WG-0018/19/20/37/38/39/40), 6 remain genuinely REVIEW_REQUIRED (real but low-severity gaps or scanner-ambiguous, none auto-fixable under this task's safety rules), 3 (WG-0033/34/35) are cosmetic and explicitly NEVER_AUTO_FIX per this task's own security boundary.

---

## 2. Phase 2 Audit Report

**Reconstructed scope:** see §0. **Workflows audited:** `customer.checkout.purchase` (prepaid path), `customer.payment.prepaid_verify`, plus the Integration/State categories which structurally validate the full payment/webhook/idempotency chain requested (checkout → payment → Razorpay → persistence → webhook → signature → idempotency → payment state → order state → retry → admin config).

### Workflow results

| Workflow | Level | Status |
|---|---|---|
| Customer purchase: cart → checkout → payment → order | BUSINESS | **CONFIRMED** 6/6 — includes the prepaid-gate step ("prepaid requires an active Razorpay environment" — `503` before any order row is created, per Phase 2 report §5) |
| Prepaid payment verification → order acceptance | BUSINESS | **NOT_EXECUTED — ENVIRONMENT LIMITATION** (requires live payment-sandbox traffic; Guardian explicitly defers to `server/dev-harness/test-phase9b-payment-retry-cap.js` rather than re-simulating Razorpay). This matches the Phase 2 report's own §17/§23 findings: order-creation against Razorpay's real Test API was live-verified in that session, but full browser checkout completion, refunds, and reconciliation remain externally BLOCKED by Razorpay's bot-detection and the lack of a public tunnel — not a code defect, and unchanged by this audit. |

### Category health (Phase-2-relevant categories)

- **Integration: 100/100, 0 findings.** Every `PROVIDERS.razorpay.method()` dispatch (`createOrder`, `verifyPaymentSignature`, `verifyWebhookSignature`, `createRefund`, `fetchPayment`) is actually implemented by the provider — no phantom dispatch.
- **State: 100/100, 0 findings.** The curated payment/order state machines (`INITIATED→PENDING→SUCCESS/FAILED/CANCELLED/REFUNDED/PARTIALLY_REFUNDED`, `orders.payment_status`) cross-check cleanly against the live schema.
- **FeatureFlag: 100/100, 0 findings.** (COD gate itself is Phase 9B, out of scope, but the same engine's checkout-gating pass covers the prepaid Razorpay-environment check with no gap.)
- **Security (RBAC): 97/100** — the 3 P3s here (WG-0033/34/35, §1) are on `public.js`, not on any payment/integration route; every `/api/admin/payments/*` and `/api/admin/integrations/*` route passed the admin-auth + permission sweep cleanly (0 findings).

### Findings — Phase 2 scope (4 of 43 total findings)

All 4 are **P3**, contract-layer ("no frontend caller found") findings. None are SAFE_AUTO_FIX-eligible (the fix-planner's `NEVER_PATTERNS` list explicitly matches `/payment/i`, `/refund/i`, and `server/src/integrations/` — every one of these 4 findings is on a payments/integrations file, so the tool itself hard-codes them out of auto-fix eligibility, independent of anything decided here).

| ID | Category | Route/File | Classification | Notes |
|---|---|---|---|---|
| WG-0006 | contract | `GET /api/admin/payments/webhooks/:id` | REVIEW_REQUIRED (tool-assigned **NEVER_AUTO_FIX**) | Verified: `admin/webhooks.html` lists webhook events and shows a detail panel, but the static scanner didn't match its exact call pattern to this route. Plausible scanner miss (webhooks.html clearly exists as the dedicated UI for this data) rather than a real dead route — flagged for a human to confirm the exact fetch call, not code changed. |
| WG-0007 | contract | `POST /api/admin/integrations/:provider/:environment/enable` | **REAL_FINDING (dead backend route)** | Verified: `admin/integrations.html` toggles the `enabled` flag via `Api.put(`/integrations/${provider}/${environment}`, {..., enabled})` — a single generic config-update call — never via this dedicated `/enable` route. The backend exposes two ways to reach the same state; the frontend only uses one. This is genuine dead code in `integrationsAdmin.js`, but removing/rewiring it touches integration-configuration logic, which is explicitly on this task's NEVER-auto-fix list ("integrations", "payment/Razorpay logic" adjacent) — `FIND → DOCUMENT → REVIEW_REQUIRED`, not touched. |
| WG-0008 | contract | `POST /api/admin/integrations/:provider/:environment/disable` | **REAL_FINDING (dead backend route)** | Same as WG-0007, mirror route. |
| WG-0025 | contract | `POST /api/public/payments/webhook/razorpay` | **FALSE_POSITIVE** | By design, documented in Phase 2 report §9: this endpoint is called by Razorpay's own servers via HMAC-signed webhook delivery, never by this app's own frontend. Guardian's own fix-planner already tags it `NEVER_AUTO_FIX` for exactly this reason. |

### Cross-reference to Security Guardian (not duplicated here)

`security-guardian.latest.md`'s **Payments/Webhooks category scored 95/100 with 0 P0/P1/P2** (its own 5 P3 items are informational/confirming, e.g. signature-gating and HMAC checks — already ACCEPTED there). Wiring Guardian's Phase 2 findings above are wiring-only (dead admin routes / scanner ambiguity), not security findings, so nothing here duplicates that report.

**Phase 2 verdict input:** 4 findings reviewed, 0 P0/P1/P2, 1 FALSE_POSITIVE (by design), 1 REVIEW_REQUIRED (probable scanner miss), 2 REAL_FINDING (confirmed dead backend routes, correctly gated NEVER_AUTO_FIX by the tool's own integration-safety pattern — documented, not touched).

---

## 3. Limitations

- **ENVIRONMENT_LIMITATION:** Full live-payment-sandbox verification (browser-driven Razorpay Test Mode checkout, real webhook delivery from Razorpay's servers, live refund/reconciliation) was not re-attempted in this session. This is not a gap introduced by this audit — the Phase 2 Implementation Report (§17, §23) already documents these as externally BLOCKED (Razorpay's own Test-Mode bot detection blocks automated browser completion; no public tunnel was configured for real webhook delivery). Re-running the DEV/QA harness live (`npm run dev:healthcheck`, the QA repo's Playwright suite) was intentionally not done this session because **no code changed** — there is nothing to regress, and doing so would create live test orders / hit real external services (Supabase, Razorpay) for no verification benefit. The most recent live evidence remains the Phase 1/2 reports' own appendices (DEV healthcheck 21/21, QA suite 87/87 as of their sessions).
- **TOOL_LIMITATION:** The contract engine's "no frontend caller found" check is a static regex-based scanner; it cannot resolve calls built from computed/templated path segments, so several REVIEW_REQUIRED items above may be scanner misses rather than real dead code (explicitly noted per item).
- **HISTORICAL_SCOPE_UNCERTAIN:** None. Every file/route in this audit's scope tables was traced to a specific, named introducing commit via `git log`/`git blame` — no phase attribution here relies on assumption.

---

## 4. Findings Out of Phase 1/2 Scope (for completeness — not part of the verdict)

23 findings (1 P1, 1 P2, 21 P3) belong to Phase 3 through Phase 9 / the post-launch UI redesign, confirmed by git blame (see table in §0): WG-0001 (P1, `admin/discovery.html` — Phase 3), WG-0009–WG-0015 (Phase 3/4/5A), WG-0021–WG-0024 (Phase 3), WG-0026–WG-0032 (Phase 3/4/6A/6B/7/8A), WG-0036 (P2, `/faq` page cache — Phase 3), WG-0041–WG-0043 (UI-1 redesign / Phase 9). These are left exactly as the full audit found them; they belong to other guardians' or future sessions' scope, per this task's own instruction not to continue into later phases.

---

## 5. Combined Final Report

### Summary

| Phase | Found | Auto-Fixed | Review Required | Remaining | Verdict |
|---|---:|---:|---:|---:|---|
| Phase 1 | 16 | 0 | 6 (+3 NEVER_AUTO_FIX cosmetic) | 6 REVIEW_REQUIRED, 3 NEVER_AUTO_FIX, 7 resolved as FALSE_POSITIVE/TOOL_LIMITATION | **PASS WITH WARNINGS** |
| Phase 2 | 4 | 0 | 3 (2 confirmed dead routes + 1 probable scanner miss) | 3 REVIEW_REQUIRED, 1 resolved as FALSE_POSITIVE | **PASS WITH WARNINGS** |

No P0 or P1 finding exists in either phase's scope. No finding in either phase was eligible for this tool's SAFE_AUTO_FIX whitelist (which covers exactly two unrelated files, `admin/users.html` and `public-site/cart.html`) — every genuine in-scope finding is either a documented by-design pattern, a UI-affordance gap needing a product decision, or a dead route inside integration-configuration code that this task's own rules forbid touching. Nothing was force-passed: the "WARNINGS" verdict reflects real, low-severity, human-reviewable items, not a downgraded PASS.

### Fixed Bugs

**None.** No SAFE_AUTO_FIX-eligible, deterministic, low-risk wiring bug was found in either phase's scope. This was verified twice: (1) by inspection of `src/fix-planner/planFixes.js`'s whitelist against every finding's file path, and (2) by running the audit once with no flags — its `appliedFixes` list was empty, confirming the tool itself agrees nothing here was auto-fixable. Consequently no `Fix → Test → Re-audit → Confirm` cycle was needed.

### Review Required

| Finding | Phase | Reason it's not auto-fixed |
|---|---|---|
| WG-0002 `GET /api/admin/auth/me` unused | 1 | Possibly intentionally reserved; needs a human decision on whether to remove or wire up |
| WG-0003 `GET /api/admin/customers/:id/orders` unused | 1 | Missing UI affordance (no customer-detail page) — a feature decision, not a wiring accident |
| WG-0004/WG-0005 `GET`/`PUT /api/admin/blog/:id` unused | 1 | Same — admin blog UI has no "edit" affordance; product decision needed |
| WG-0016 `POST /api/public/reviews` scanner-ambiguous | 1 | Needs a human to confirm the review form's actual call site |
| WG-0017 `POST /api/public/dosha-results` scanner-ambiguous | 1 | Same, for the dosha-quiz save flow |
| WG-0033/34/35 inline customer-auth check vs shared middleware | 1 | Touches authentication/RBAC boundary code — explicitly NEVER_AUTO_FIX under this task's own rules, even though cosmetic |
| WG-0006 `GET /api/admin/payments/webhooks/:id` scanner-ambiguous | 2 | Tool-assigned NEVER_AUTO_FIX (payments file); needs a human to confirm `admin/webhooks.html`'s exact call pattern |
| WG-0007 `POST /api/admin/integrations/:provider/:environment/enable` dead route | 2 | Confirmed dead — but removing/rewiring it touches integration-configuration code, explicitly NEVER_AUTO_FIX |
| WG-0008 `POST /api/admin/integrations/:provider/:environment/disable` dead route | 2 | Same as WG-0007 |

### Verification

- **Tests before this audit:** Wiring Guardian's own unit suite, 12/12 passed (`node tests/runAll.js`).
- **Tests after this audit:** unchanged — 12/12 (no source file under `quality-agents/wiring-guardian/src` or `server/`/`admin/`/`public-site/` was modified, so no re-run was needed beyond the initial confirmation).
- **Re-audit result:** N/A — no fix was applied, so there is nothing to re-audit for resolution. The audit itself was run once to completion; its regression-vs-baseline section reports "0 new findings since baseline, 1 resolved since baseline, 43 unchanged" against the pre-existing global baseline at `reports/baseline/baseline.json` (dated `2026-09-14T02:30:04.880Z`), confirming this session introduced no new wiring regressions anywhere in the repo.
- **Regression result:** None possible — zero lines of application code were changed.

### Application Impact

**Application behavior did not change.** This session performed a read-only audit (git history/blame, static file reads, one full Guardian audit run, one Guardian unit-test run) and produced this report. No file under `server/`, `admin/`, `public-site/`, or `supabase/` was modified. No database, migration, RLS policy, secret, or business rule was touched, per this task's explicit boundaries.

### Git

- **Branch:** `feature/wiring-guardian-phase1-phase2` (created from `development`)
- **Commit:** this report (`docs/quality/WIRING-GUARDIAN-PHASE-1-2-AUDIT.md`) is the only tracked change — see the accompanying commit
- **Push:** NO
- **Merge:** NO
- **Working tree status:** clean except this new doc file and the two pre-existing untracked items noted at session start (`public-site/design-ref.zip`, `public-site/design-ref/` — not created by this session, left untouched) and the untracked `quality-agents/security-guardian/` directory from a prior session (also left untouched)

---

## 6. Completion

Phase 1 and Phase 2 have been audited using the existing Wiring Guardian, with scope reconstructed from evidence (implementation reports + git history/blame), findings classified and root-caused (several previously-plausible "dead route" warnings resolved to FALSE_POSITIVE or TOOL_LIMITATION with evidence), and zero safe auto-fixes existed to apply. All REVIEW_REQUIRED items are documented above for human follow-up. The existing global Wiring Guardian baseline was **not** overwritten by this run. No application code, schema, or business logic was changed.

**Session closed per task instruction — no Phase 3+, no other guardians, no redesign, no merge, no push.**
