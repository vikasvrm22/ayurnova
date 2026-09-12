# AyurVeda Store — Phase 2 Implementation Report

**Scope:** Core Ecommerce + Complete Razorpay Payment Integration
**Baseline:** Phase 1 final commit `0053116` (PASS verdict) — preserved, not rewritten.
**DEV repo commits added this phase:** `f56eeb0` (local port config, see §0), `fa55c2b`, `614a370`, `29263ac`, `587be40`, `a13aca2`.
**QA repo commits added this phase:** `40c8e02` (port config), `52fdacc`, `b6139d9`.

Every claim below is evidence-tagged: **VERIFIED** (implemented and tested, with proof), **IMPLEMENTED** (built, not yet live-testable), **PARTIAL**, **BLOCKED** (external dependency, explicit reason), **DEFERRED** (explicit reason), or **RECOMMENDATION**.

---

## 0. A Note on Session Continuity

Mid-session, a separate local-dev port-configuration request (moving the app's default port from 4000 to 5100 to avoid a conflict with an unrelated local project) was handled and closed as its own unit of work — commit `f56eeb0` (DEV) / `40c8e02` (QA). It is unrelated to Phase 2's scope and is not re-documented here beyond this pointer.

**Post-migration update:** the user applied `supabase/migrations/0002_phase2_payments_and_integrations.sql` via the Supabase SQL Editor after the rest of this report was originally drafted. The migration-dependent verification below was completed immediately afterward and is reflected in place (not as a separate addendum) since this is a direct continuation of the same Phase 2 work, not a new task. See §9 for the single most significant new result: **live-verified webhook idempotency**.

---

## 1. Executive Summary

Phase 2's full scope - cart/checkout hardening, the Payment/Attempt/Refund data model, complete Razorpay integration (order creation, Checkout.js verification, webhooks, retries, refunds), a generic Integration Management foundation, Admin Payments, reconciliation, and QA coverage - is **implemented, committed, and now live-verified against the real applied schema**. The HMAC-SHA256 signature verification that the entire "never trust the frontend" rule rests on was unit-tested with synthetic data (valid/tampered/wrong-secret/missing-field cases all behave correctly); every new endpoint's input validation, auth gating, and safe-failure behavior was verified live; all five new tables (`integration_configs`, `payments`, `payment_attempts`, `refunds`, `webhook_events`) are confirmed live and reachable; **webhook idempotency was proven live** (a duplicate event delivery correctly returned `duplicate:true` via the database's unique constraint); and the full QA suite passed completely clean: **85 passed, 0 skipped, 0 failed**.

**One external dependency remains genuinely BLOCKED, explicitly anticipated by the brief's Step 13:**

**No real Razorpay Test/Sandbox credentials were available in this session** (the user's explicit, informed choice). Every code path that calls Razorpay's live API (order creation, refund, fetch-for-reconciliation) is implemented, schema-verified end-to-end up to the point of the actual external API call, and has not been exercised against Razorpay's actual servers. This is not worked around - no credentials were invented, no test was weakened to hide it.

A recurring, unrelated connectivity issue - the same intermittent Supabase DNS/network outage observed repeatedly since Phase 1 - also recurred several times during this session; external, not caused by anything in this phase (confirmed each time via a direct `fetch()` to Supabase independent of the app).

---

## 2. Scope

Implemented: server-authoritative cart/checkout (COD unchanged, prepaid extended), Payment/Attempt/Refund data model, generic Integration Management foundation, complete Razorpay flow (order creation, Checkout.js verification, webhook, retry, refund, reconciliation), Admin Payments module, customer-facing payment UI, QA/DEV harness coverage.

Explicitly not implemented (per the brief's own scope boundary): Phase 3 Ayurveda discovery features, Phase 4 wellness/recommendation engine, Phase 5 manufacturing/batch/inventory, any AI/ML functionality, any seller/marketplace functionality.

---

## 3. Architecture

```
Web (public-site/cart.html) ──POST /api/public/checkout──▶ server/src/routes/public.js
                                                                  │ (prepaid only)
                                                                  ▼
                                          server/src/services/paymentService.js
                                           startPaymentAttempt()
                                                                  │
                                                                  ▼
                                  server/src/integrations/razorpay/provider.js
                                           createOrder() ──▶ Razorpay Orders API
                                                                  │
                              ◀── { razorpay: { orderId, keyId, amount } } ──
                                                                  │
Web: Razorpay Checkout.js opens, customer pays ──────────────────┘
                                                                  │
         ┌────────────────────────────────────────────────────────┤
         ▼ (customer's browser, same session)                     ▼ (Razorpay's servers, independent)
POST /api/public/payments/verify                  POST /api/public/payments/webhook/razorpay
         │                                                          │
         ▼                                                          ▼
paymentService.verifyCheckoutPayment()              paymentService.processWebhookEvent()
  (HMAC-SHA256 signature check)                        (HMAC-SHA256 signature check,
         │                                              unique event_id = idempotency)
         └──────────────────┬───────────────────────────┘
                             ▼
              paymentService.markAttemptOutcome()
         (idempotent conditional UPDATE - whichever
          path verifies first wins; decrements stock
          exactly once; updates orders.payment_status)
```

Android readiness: every new endpoint is plain JSON over HTTP with bearer-token auth (admin) or optional customer auth (public) - no browser-specific assumptions. The one browser-specific piece, loading Razorpay's Checkout.js and opening its UI, is inherent to any web Razorpay integration; Razorpay's Android SDK performs the equivalent native step, calling the exact same backend endpoints (`/checkout`, `/payments/verify`) unchanged - see §14.

---

## 4. Database Changes

**File:** `supabase/migrations/0002_phase2_payments_and_integrations.sql` - **APPLIED, VERIFIED live** (user ran it via the Supabase SQL Editor; confirmed below).

| Table | Purpose | Live status |
|---|---|---|
| `integration_configs` | Generic, provider/environment-keyed credential store (encrypted secrets, enabled flag, last connection-test result) | **VERIFIED** - prepaid checkout's `getActiveEnvironment()` query against it returns `503` (no config yet), not `500` (table missing) |
| `payments` | One row per order; `status` (INITIATED/PENDING/SUCCESS/FAILED/CANCELLED/REFUNDED/PARTIALLY_REFUNDED), `refunded_amount` | **VERIFIED reachable** (created in the same script, before `payment_attempts` which is directly confirmed) |
| `payment_attempts` | Many per payment; `attempt_number`, `gateway_order_id` (unique), `gateway_payment_id`, `method`, `status` | **VERIFIED** - `POST /payments/verify` with a nonexistent order now returns `404 ATTEMPT_NOT_FOUND`, not `500` |
| `refunds` | Many per payment; `amount`, `reason`, `gateway_refund_id`, audit fields | **VERIFIED reachable** (created in the same script, between `payments`/`payment_attempts` and `webhook_events` which are directly confirmed) |
| `webhook_events` | `unique(gateway, event_id)` - the actual idempotency guard for duplicate webhook deliveries | **VERIFIED, including the idempotency behavior itself** - see §9 |

`orders.payment_status`'s check constraint is widened (additive: `'unpaid'`/`'paid'`/`'refunded'` remain valid; `'partially_refunded'`/`'failed'` added). No existing column, row, or table is dropped, renamed, or altered in a way that could lose data.

**FACT:** this project has no direct Postgres connection string anywhere in its configuration (confirmed by grepping `.env`/`.env.example` for any variable name resembling one) - only the Supabase REST API via anon/service-role keys, which cannot execute DDL. The migration must be applied via the Supabase SQL Editor, identical to how the original `schema.sql` was set up (documented in `README.md`/`SETUP.md`).

---

## 5. Cart/Checkout

**VERIFIED.** `server/src/routes/public.js`'s `POST /checkout`:
- COD path: **byte-for-byte unchanged** from Phase 1 (re-pricing, stock validation, stock decrement at order creation) - verified by diff review.
- Prepaid path: checks a Razorpay environment is active **before** creating the order row (live-verified: with no integration configured, returns `503 PAYMENT_GATEWAY_UNAVAILABLE` rather than creating an unpayable order — see Appendix). Once the order/order_items are created, stock is **not** decremented (moved to `markAttemptOutcome`, see §7) and `paymentService.startPaymentAttempt()` is called, returning `{ payment_required: true, razorpay: { orderId, keyId, amount, currency } }`.

Server-authoritative pricing/stock validation, quantity bounds, and address validation are all **unchanged from Phase 1** (not touched - confirmed by diff). No client-controlled price or quantity reaches the order total; the client only ever supplies `variant_id`/`qty` pairs, re-priced from the database every time (Phase 0/1's existing, preserved guarantee).

---

## 6. Order Flow

```
pending/unpaid ──(COD)──▶ stock decremented immediately, order complete
pending/unpaid ──(prepaid)──▶ payment attempt started, stock NOT YET decremented
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                             ▼
         verified SUCCESS                   verified FAILED/abandoned
   (signature check passed)                        │
                    │                               ▼
                    ▼                    customer can Retry Payment
  orders.payment_status = 'paid'          (new attempt, same order,
  stock decremented (once, idempotent)      new Razorpay order)
```

**VERIFIED** up to the external-API boundary: the schema exists and is reachable end-to-end (§4); a real order successfully reaching `startPaymentAttempt` and receiving `SUCCESS` requires a real Razorpay order-creation call, which is **BLOCKED** on real credentials (§17 #2, unchanged).

---

## 7. Razorpay Integration

`server/src/integrations/razorpay/provider.js` is the **only** file importing the `razorpay` SDK. Functions: `getClient`/`getActiveEnvironment` (production preferred over test, never silently mixed), `testConnection` (non-mutating - lists at most 1 order), `createOrder`, `verifyPaymentSignature`, `verifyWebhookSignature`, `createRefund`, `fetchPayment`.

**VERIFIED - signature verification (the security-critical core):**
```
$ node --input-type=module -e "... verifyPaymentSignature/verifyWebhookSignature assertions ..."
valid signature accepted: true
tampered signature rejected: true
wrong secret rejected: true
missing signature rejected: true
tampered orderId rejected: true
webhook valid signature accepted: true
webhook tampered body rejected: true
```
All 7 assertions passed, using synthetic secrets - no real Razorpay credentials needed to prove this logic is correct, per the brief's Step 13 guidance.

**BLOCKED - live Razorpay API calls** (`createOrder`, `createRefund`, `fetchPayment`, `testConnection`): no real Test/Sandbox credentials were available this session (user's explicit choice) - unaffected by the migration being applied, since this is a separate, external dependency. Code reviewed for correctness against Razorpay's documented API shapes; not exercised against Razorpay's actual servers.

---

## 8. Payment Attempts

**VERIFIED reachable; full multi-attempt lifecycle BLOCKED on Razorpay credentials.** `payment_attempts` supports exactly the brief's example (`Order #10025: Attempt 1 -> UPI -> FAILED, Attempt 2 -> UPI -> SUCCESS`) - each attempt has its own `gateway_order_id` (Razorpay requires a fresh order per retry), `status`, `method`, `failure_reason`, `raw_event`. `paymentService.startPaymentAttempt` computes the next `attempt_number` from the existing max; the `unique(payment_id, attempt_number)` constraint is a safety net against a race producing duplicate attempt numbers.

Table existence and query-ability confirmed live:
```
$ curl -X POST .../payments/verify -d '{"razorpay_order_id":"order_doesnotexist",...}'
{"error":"Payment attempt not found"}   STATUS:404
```
(Pre-migration this was a `500` with a `PGRST205` table-not-found error server-side - now a clean `404`, proving the table exists and the lookup query runs correctly.) Creating more than one real attempt for the same payment needs a real Razorpay order per attempt - **BLOCKED** on credentials (§17 #2).

---

## 9. Webhooks

`POST /api/public/payments/webhook/razorpay` (no customer/admin auth - the HMAC signature over the **raw** request body is the authentication). `server/src/index.js`'s `express.json()` now captures `req.rawBody` via its `verify` callback (the signature must be computed over the exact bytes Razorpay sent, not a re-serialized parsed object).

**VERIFIED live:**
```
POST .../webhook/razorpay (no signature header)       -> 400 {"error":"Missing signature or body"}
POST .../webhook/razorpay (fabricated signature)       -> 400 (never a silent 2xx for unverifiable auth)
```
Tries both `test` and `production` webhook secrets (Razorpay delivers both modes' events to the same URL) before concluding a signature is invalid.

**Idempotency - VERIFIED LIVE, post-migration.** Sent the exact same webhook payload (same fabricated `event_id`) twice in a row:
```
$ curl -X POST .../webhook/razorpay -H "X-Razorpay-Signature: deadbeef..." -d '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_test_migration_check","order_id":"order_test_migration_check","status":"captured"}}}}'
{"received":true,"duplicate":false,"processed":false,"reason":"invalid_signature"}   STATUS:400   (first delivery - recorded)

$ <identical request, same event id, sent again>
{"received":true,"duplicate":true}   STATUS:400   (second delivery - caught as a duplicate, not reprocessed)
```
This is exactly the Phase 2 §5/§9 requirement working end-to-end: the second call's insert into `webhook_events` hit the `unique(gateway, event_id)` constraint (Postgres `23505`), `processWebhookEvent` correctly treated that as "already recorded, no-op" rather than processing it again. No fabricated/invented state was needed to prove this - the signature was deliberately invalid (no real Razorpay webhook secret is configured yet), so this also doubles as proof that an unverifiable signature is consistently rejected on retry, not just the first time.

### 9.1 Focused compliance audit (requested separately, before Dashboard webhook configuration)

A dedicated audit was performed against 5 specific event types, in response to a direct question about whether business-state handling (not just the signature/idempotency layer) was actually complete. **It was not assumed complete - it was traced through the code line-by-line and then live-tested.**

**Findings (`server/src/services/paymentService.js`, function `processWebhookEvent`, pre-fix):**

| Event | Explicitly handled? | Real gap found |
|---|---|---|
| `payment.captured` | Yes | No |
| `payment.failed` | Implicitly - fell through a `success = eventType==="payment.captured" \|\| entity.status==="captured"` check to `false`, which *did* correctly mark the attempt FAILED, but by inferring failure from "not success" rather than an explicit signal | **Yes (fragility)** - any other non-captured `payment.*` event (e.g. `payment.authorized`) would have been wrongly classified as a failure by the same fallback |
| `refund.created` | **No** - the code only ever read `payload.payment.entity`, never `payload.refund.entity` | **Yes** |
| `refund.processed` | **No** | **Yes** |
| `refund.failed` | **No** | **Yes** |

The refund gap was real and significant: a refund issued directly via the Razorpay Dashboard (not through this app's own `POST /api/admin/payments/:id/refund`) was silently absorbed as a harmless no-op (`markAttemptOutcome`'s terminal-state guard caught it) but **left no trace anywhere in the local database** - `refunds` table untouched, `payments.refunded_amount`/`status` never updated, `orders.payment_status` never updated. This directly undermined the Phase 2 payment-audit-trail and reconciliation requirements for any refund not initiated through the admin panel.

**Fix implemented** (`paymentService.js`):
- Payment event classification is now explicit: `PAYMENT_SUCCESS_EVENT_TYPES = {"payment.captured"}`, `PAYMENT_FAILURE_EVENT_TYPES = {"payment.failed"}`. An event that matches neither (and whose entity status is neither `captured` nor `failed`) is now recorded and marked `IGNORED` rather than guessed at as a failure - closes the fragility above.
- New `processRefundWebhookEvent()` handles `refund.created`/`refund.processed`/`refund.failed`, keyed off `payload.refund.entity.payment_id` directly (not dependent on an accompanying payment entity). Idempotent **per `gateway_refund_id`**, not merely per webhook `event_id`: a `refund.created` followed later by `refund.processed` for the *same* refund applies the amount to `payments.refunded_amount` exactly once (on first transition into `PROCESSED`), and a refund already recorded by this app's own admin-initiated `createRefund()` is updated in place rather than duplicated when its confirming webhook later arrives.
- None of this touches the signature-verification gate, the `webhook_events` unique-constraint dedup, or the raw-body HMAC capture - all three run identically, before any of the above, exactly as before.

**Live verification - `_tmp_webhook_audit.mjs`, a one-off diagnostic run directly against `processWebhookEvent()` (not committed; deleted immediately after use).** This calls the real exported service function with real, temporary, self-cleaning database fixtures (a throwaway order/payment/attempt created and deleted per case) - it does **not** call the HTTP route with a bypassed signature; it supplies `signatureValid` exactly as the real route does *after* a genuine HMAC check passes, which is the correct way to test business logic in isolation without weakening or bypassing the actual security boundary. **20/20 assertions passed:**
```
PASS  payment.captured -> attempt SUCCESS / payment SUCCESS / order payment_status paid
PASS  payment.failed -> attempt FAILED, failure_reason recorded, payment NOT marked success
PASS  payment.authorized (unhandled type) -> attempt left INITIATED, not wrongly FAILED   <- the fixed fragility
PASS  refund.created -> refunds row inserted (INITIATED), refunded_amount NOT yet applied
PASS  refund.processed -> refunded_amount applied (₹40), payment PARTIALLY_REFUNDED, order payment_status partially_refunded
PASS  refund.processed (re-delivered under a NEW event_id, same gateway_refund_id) -> amount NOT double-applied
PASS  refund.failed -> refunds row recorded as FAILED, refunded_amount unchanged
PASS  duplicate delivery (same event_id) -> first processed, second is a no-op (duplicate:true)
PASS  invalid signature -> reported invalid_signature, not processed, attempt state unchanged

Cleaned up: 6 orders, 6 payments, 6 attempts, 2 refunds
```
Post-run, a direct query confirmed zero leftover `AV-WHAUDIT-*` rows in the live database.

**Additionally re-confirmed against the real HTTP endpoint** (not just the internal function) after the fix, live:
```
POST .../webhook/razorpay (invalid signature)             -> 400 {"duplicate":false,"processed":false,"reason":"invalid_signature"}
POST .../webhook/razorpay (same event again)               -> 400 {"duplicate":true}
POST .../webhook/razorpay (refund.processed, no signature)  -> 400 {"error":"Missing signature or body"}
```
Full QA suite and DEV healthcheck re-run clean after the fix: **85 passed, 0 skipped, 0 failed**; **20/20** DEV healthcheck - no regression.

**Conclusion:** duplicate delivery is safely idempotent and an invalid signature can never change business state, for all 5 audited events, both before and after this fix (those two properties were already correct). What the fix adds is *correct, complete, and audit-traceable* business-state handling for `payment.failed` (now explicit rather than inferred) and for all three refund events (previously entirely unhandled).

---

## 10. Refunds

`paymentService.createRefund`: validates `amount <= payment.amount - payment.refunded_amount` **before** calling Razorpay (never exceeds the refundable balance); finds the payment's successful attempt; calls Razorpay; records the `refunds` row and updates `payments.status`/`refunded_amount` and `orders.payment_status` (`REFUNDED` if fully refunded, `PARTIALLY_REFUNDED` otherwise) only after Razorpay's call succeeds. A failed Razorpay call is recorded as a `FAILED` refund row rather than silently dropped. This is the **admin-initiated** path (`POST /api/admin/payments/:id/refund`).

As of the §9.1 webhook audit, refunds initiated **outside** the admin panel (directly via the Razorpay Dashboard) are now also captured: `processRefundWebhookEvent` records/updates the same `refunds` row and applies `payments.refunded_amount`/`orders.payment_status` from the `refund.created`/`refund.processed`/`refund.failed` webhooks, idempotently per `gateway_refund_id` so the two paths (admin-initiated + webhook-confirmed) never double-count. **VERIFIED live** via the §9.1 direct-function audit (partial refund correctly applied once, a re-delivered confirmation correctly not double-applied).

**IMPLEMENTED, schema and webhook-driven recording both live-verified (§4, §9.1); BLOCKED for an actual admin-initiated refund via Razorpay's live API** - needs real Razorpay credentials (§17 #2).

---

## 11. Admin Payments

`server/src/routes/paymentsAdmin.js` (`/api/admin/payments`) + three new admin pages (`payments-list.html`, `payment-detail.html`) + `order-detail.html` extended to surface payment/attempt/refund info inline.

**VERIFIED (auth gating, live):**
```
GET  /api/admin/payments                  (no token) -> 401
GET  /api/admin/payments/failed-attempts  (no token) -> 401
POST /api/admin/payments/:id/refund       (no token) -> 401
POST /api/admin/payments/:id/reconcile    (no token) -> 401
```
RBAC via the new `managePayments` permission (`server/src/config.js` - SuperAdmin/Admin only, same pattern as every other admin permission). **BLOCKED** for an authenticated functional walkthrough - logging in with the project's admin credentials was not attempted in this session (the sandbox's own permission policy blocks credential-based login attempts, consistent with Phase 0's prior finding); this is a tooling/environment restriction, not a code limitation.

---

## 12. Reconciliation

`paymentService.reconcilePayment`: fetches the local payment's latest attempt, calls `razorpayProvider.fetchPayment` for the real Razorpay record, compares status and amount, and returns a structured mismatch report. **Read-only by design** (Phase 2 §8's explicit requirement) - never writes a "fix" on its own; the reconciliation **run itself** is still audit-logged (`activity_log`, `entity_type: "payment", action: "reconcile_run"`) so there's a record of who checked what and when, even though checking changes nothing.

**BLOCKED** for a live run (needs a real Razorpay payment to compare against - unaffected by the migration being applied).

---

## 13. Security

| Control | Status |
|---|---|
| No payment secrets in source/Git/logs/error messages | **VERIFIED** - `key_secret`/`webhook_secret` only ever exist encrypted (AES-256-GCM) in `integration_configs`; API responses only ever return a masked preview (`toSafeView` in `integrationService.js`); a QA regression test confirms a probed secret value never appears in any response, even a 401 |
| Card/CVV/UPI PIN never stored | **VERIFIED by design** - this app never touches card/UPI details at all; Razorpay Checkout.js collects them directly within its own hosted UI/iframe, this app never receives them |
| Frontend payment claim never trusted alone | **VERIFIED** - both paths to SUCCESS require a passing HMAC-SHA256 check (§7) |
| Webhook signature verification | **VERIFIED** (§9) |
| Idempotent webhook processing | **VERIFIED LIVE** - a duplicate webhook delivery returned `duplicate:true`, not reprocessed (§9) |
| No price/quantity tampering | **VERIFIED** - unchanged Phase 0/1 server-side re-pricing (§5) |
| No unauthorized payment/order access | **VERIFIED** - `verifyCheckoutPayment`/retry check `customer_id` or `guest_phone` ownership before touching any attempt |
| Admin endpoints require auth | **VERIFIED** (§11) |
| Safe error handling | **VERIFIED** - every new route uses `AppError`/the existing `errorHandler.js` convention; live-confirmed a missing-table error (`PGRST205`) was not leaked to the client, only `{"error":"Internal server error"}` |
| No new secret committed to Git | **VERIFIED** - `git status`/`git diff` reviewed before every commit in both repos; `server/.env` never staged |

**Pre-existing, unrelated finding (not introduced by Phase 2, documented per the brief's instruction not to expand scope to fix unrelated debt):** `npm audit` flagged 8 vulnerabilities (5 moderate, 3 high) after installing `razorpay` - all in `geoip-lite`'s (`ip-address`), `sharp`'s (libvips/libheif), and `express`'s (`qs`/`body-parser`) own transitive dependency trees, none related to the `razorpay` package itself. Fixing them (`npm audit fix --force`) would bump `sharp`/`express` to breaking-change major versions - out of scope here; **RECOMMENDATION** for a dedicated dependency-upgrade pass in a future phase.

---

## 14. Android Readiness

Every new endpoint (`/api/public/payments/verify`, `/retry`, `/webhook/razorpay`, `/api/admin/payments/*`, `/api/admin/integrations/*`) is plain JSON over HTTP, stateless bearer-token (admin) or optional-customer-token (public) auth - identical contract for a web or Android client. `startPaymentAttempt`'s response shape (`{ razorpay: { orderId, keyId, amount, currency } }`) is exactly what Razorpay's **Android SDK** needs to open its native payment UI, the same way Checkout.js uses it in the browser - an Android client would call the same `/checkout` and `/payments/verify` endpoints unchanged, substituting Razorpay's Android SDK for Checkout.js as the one browser-specific piece. No payment/order business logic lives in `public-site/cart.html`'s JavaScript beyond relaying Razorpay's own response to the verify endpoint - the actual trust decision is entirely server-side (§7, §13).

---

## 15. DEV/QA

**DEV Harness** (`server/dev-harness/healthcheck.js`): extended with 5 Phase 2 checks (admin payments/integrations auth gating, verify/retry/webhook input validation) - all DB-independent. **VERIFIED: 20/20 passed** (live run, Appendix).

**QA Harness** (`ayurvedicstore-qa`, separate repo, no application source duplicated): added `tests/api/payments.spec.js`, `tests/regression/payments-regression.spec.js`, `tests/e2e/checkout.e2e.spec.js`. Extended the existing unauthenticated-access sweep (`utils/testData.js`) to cover the new admin paths.

---

## 16. Test Coverage / Test Results

**VERIFIED - full combined run (smoke + api + security + regression + e2e), live against the running DEV server, post-migration:**
```
85 passed, 0 skipped, 0 failed
```
This is the first fully clean run: `payments.spec.js`'s "verify with a nonexistent order id returns 404" (previously skipped pre-migration, since the schema didn't exist yet) now passes for real. DEV healthcheck: **20/20 passed**.

Phase 1's existing suite (60+ tests covering the SSR fix, catalog API, existing security/regression coverage) was **re-run in the same pass and remains green** - no Phase 2 change regressed it. **Re-run again after the §9.1 webhook business-logic fix, still 85 passed, 0 skipped, 0 failed, 20/20 DEV healthcheck** - no regression from that fix either.

**Additionally, §9.1's dedicated webhook business-logic audit** (a direct-function-call diagnostic against `processWebhookEvent`, using real temporary self-cleaning fixtures, not an HTTP-level test) covered 5 event types plus duplicate-delivery and invalid-signature cases: **20/20 assertions passed**. This is the layer the QA HTTP-level suite structurally cannot reach without real Razorpay credentials (any HTTP webhook test here is signature-invalid by necessity, so it never reaches business-state logic) - see §9.1 for the full breakdown and why this method doesn't weaken or bypass the real endpoint's security.

Taxonomy used (per the locked list): `@smoke`, `@functional`, `@regression`, `@business-critical`, `@negative`, `@boundary`, `@security` tags; `@api`/`@e2e` implied by directory - identical convention to Phase 1, extended rather than replaced.

---

## 17. Known Issues

1. ~~Phase 2 database migration not yet applied~~ — **RESOLVED.** The user applied `supabase/migrations/0002_phase2_payments_and_integrations.sql` via the Supabase SQL Editor; all 5 new tables confirmed live and reachable (§4), including a live proof of webhook idempotency (§9). Full QA re-run: 85 passed, 0 skipped, 0 failed.
2. **BLOCKED - no real Razorpay Test/Sandbox credentials available this session** (user's explicit, recorded choice). Order creation, refunds, and reconciliation against Razorpay's actual API remain unverified beyond code review + the synthetic signature-verification proof - unaffected by the migration being applied, since this is a separate external dependency (Razorpay's own servers, not the database).
3. **Recurring, external, pre-existing:** the same intermittent Supabase DNS/network outage documented since Phase 1 recurred multiple times this session (confirmed independent of any app code each time via a direct `fetch()` to Supabase). Not caused by Phase 2. Connectivity was stable through the final post-migration verification pass.
4. **Pre-existing, unrelated:** `npm audit` findings in transitive dependencies of `geoip-lite`/`sharp`/`express` (§13) - not introduced by this phase.
5. ~~`payment.failed` handling was fragile (inferred, not explicit) and `refund.created`/`refund.processed`/`refund.failed` webhooks were entirely unhandled~~ — **RESOLVED**, found and fixed by a dedicated audit before Razorpay Dashboard webhook configuration. See §9.1 for the full finding, fix, and 20/20 live-verification results.

---

## 18. Deferred Items

- **Authenticated admin-panel functional walkthrough** (actually logging in and clicking through Payments/Integrations/refund flows) - deferred; the sandbox's permission policy blocks attempting admin login with real credentials in this session (consistent with Phase 0). The schema is now live, so this is purely a login-tooling restriction, not a data-readiness one. **RECOMMENDATION:** do this manually - log in, add Razorpay test credentials on the new Integrations page, and click through Payments.
- **Full add-to-cart → Razorpay popup → real payment E2E browser test** - needs a real published product (catalog currently has 2, per Phase 1's post-restore check, but both lack variants/pricing - see Phase 1 report) AND real Razorpay credentials. Structural E2E coverage (Checkout.js loads, UI elements present, empty-cart path) was added instead (§16).
- **Dependency vulnerability remediation** (`npm audit`) - pre-existing, unrelated to Phase 2, would require breaking-change upgrades to `sharp`/`express`; deferred to a dedicated pass.
- **CI provider wiring** - still none configured anywhere in the project (unchanged from Phase 1); the QA/DEV harness commands remain CI-ready but nothing invokes them automatically.

---

## 19. Files Changed

**DEV repo**, 6 Phase 2 commits on top of the Phase 1 baseline (plus 2 docs-only commits, §20):
- `fa55c2b`: `supabase/migrations/0002_phase2_payments_and_integrations.sql`, `server/src/integrations/{crypto,integrationService}.js`, `server/src/integrations/razorpay/provider.js`, `server/src/routes/integrationsAdmin.js`, `server/src/config.js`, `server/package.json`/`package-lock.json`.
- `614a370`: `server/src/services/paymentService.js`, `server/src/routes/{paymentsPublic,paymentsAdmin}.js`, `server/src/routes/public.js`, `server/src/routes/orders.js`, `server/src/index.js`.
- `29263ac`: `admin/{payments-list,payment-detail,integrations}.html` (new), 12 existing admin pages' nav, `admin/order-detail.html`, `admin/settings.html`.
- `587be40`: `public-site/cart.html`.
- `a13aca2`: `server/dev-harness/healthcheck.js`.
- `aa59cd5`: `server/src/services/paymentService.js` (§9.1 webhook audit fix - `payment.failed` explicit classification, `refund.created`/`refund.processed`/`refund.failed` handling).

**QA repo**, 3 Phase 2 commits:
- `52fdacc`: `tests/api/payments.spec.js`, `tests/regression/payments-regression.spec.js`, `utils/testData.js`.
- `b6139d9`: `tests/e2e/checkout.e2e.spec.js`.

---

## 20. Git Commits

```
DEV:  fa55c2b  feat: Phase 2 database migration + generic integration management foundation
      614a370  feat: complete Razorpay payment flow - checkout, verify, webhook, retry, refunds, reconciliation
      29263ac  feat: admin Payments + Integrations UI, order-detail payment surfacing, nav updates
      587be40  feat: wire Razorpay Checkout.js into the customer cart/checkout page
      a13aca2  chore: extend DEV harness with Phase 2 payment/integration checks
      b4a92e0  docs: Phase 2 implementation report
      34e07c4  docs: post-migration live verification update to Phase 2 report
      aa59cd5  fix: complete webhook business-state handling for payment.failed and refund.* events

QA:   52fdacc  feat: add Phase 2 payment API and regression test coverage
      b6139d9  test: add E2E checks for the cart/checkout Razorpay wiring
```
Both working trees clean at time of writing. No force-push, no history rewrite, no squashed/amended prior commits, no secrets committed (verified before every commit). The `aa59cd5` fix is isolated to a single file (`server/src/services/paymentService.js`) - no unrelated changes.

---

## 21. Acceptance Criteria

| Area | Status |
|---|---|
| Cart / server-authoritative pricing+stock | **PASS** |
| Checkout / order creation/integrity | **PASS** - schema-verified end-to-end; a real multi-attempt lifecycle still needs Razorpay credentials |
| Payment entity / attempts / history | **PASS** - tables live-verified reachable and correctly queryable (§4, §8) |
| Razorpay integration | **PASS up to the external-API boundary** - **BLOCKED** for live Razorpay API calls (credentials, §17 #2) |
| Backend payment verification | **PASS** (signature logic unit-verified) |
| Webhooks + signature verification | **PASS**, including **live-verified idempotency** (§9) and a **dedicated business-state audit covering all 5 requested event types, 20/20 live-verified** (§9.1) - found and fixed 2 genuine gaps (`payment.failed` fragility, all 3 `refund.*` events unhandled) before Dashboard webhook configuration |
| Retry | **PASS** - schema-verified reachable (404 ORDER_NOT_FOUND, not 500); a real retry needs Razorpay credentials |
| Refunds / partial refunds | **PASS** validation logic + schema; **BLOCKED** for an actual refund (credentials) |
| Payment audit trail | **PASS** - `webhook_events`/`activity_log` confirmed live |
| Reconciliation | **PASS**, read-only by design - **BLOCKED** for a live run (credentials) |
| Admin Payments/Attempts/Failed/Refunds/Reconciliation UI | **PASS** (built, auth-gated correctly; authenticated walkthrough **DEFERRED**, see §18) |
| RBAC | **PASS** |
| No secret exposure | **PASS** |
| No client-trusted payment state | **PASS** |
| No price tampering | **PASS** |
| No unauthorized payment/order access | **PASS** |
| Webhook security | **PASS** |
| Safe error handling | **PASS** |
| Android-reusable APIs | **PASS** |
| Backend-controlled business logic | **PASS** |
| Phase 1 regression suite stays green | **PASS** (85/85, 0 skipped) |
| Phase 2 automated coverage added | **PASS** |
| Git: clean commits, no secrets, no force-push/rewrite | **PASS** |

---

## 22. Final Verdict

**PASS.** The database migration is applied and fully live-verified (all 5 new tables reachable, webhook idempotency proven end-to-end with a real duplicate-delivery test). A dedicated, explicitly-requested compliance audit of webhook business-state handling across `payment.captured`/`payment.failed`/`refund.created`/`refund.processed`/`refund.failed` found and fixed two genuine gaps (§9.1) before any Razorpay Dashboard webhook configuration was touched - the audit was not skipped or assumed satisfied just because signature verification and idempotency were already known-good. The full QA suite runs completely clean, before and after that fix: 85 passed, 0 skipped, 0 failed. One external dependency remains BLOCKED and is explicitly anticipated by the brief's Step 13: real Razorpay Test/Sandbox credentials, the user's own recorded choice not to provide this session - nothing was worked around, invented, or faked to route around it, and the Razorpay Dashboard/webhook configuration itself was explicitly not touched this session per instruction. Add credentials via the new Integrations admin page, configure the Dashboard webhook once ready, and re-run the QA suite to convert that item to VERIFIED as well.

---

## Appendix: Live Verification Log (this session)

```
POST /api/public/checkout (prepaid, no Razorpay configured)    -> 503 "Online payment is not available right now..."
GET  /api/admin/payments (no token)                              -> 401
GET  /api/admin/integrations (no token)                          -> 401
POST /api/public/payments/verify {}                               -> 400 "razorpay_order_id... are required"
POST /api/public/payments/retry {}                                -> 400 "order_number is required"
POST /api/public/payments/webhook/razorpay (no signature)          -> 400 "Missing signature or body"
POST /api/public/payments/webhook/razorpay (fabricated signature)   -> 400 (never a silent 2xx)
POST /api/admin/payments/:id/refund (no token)                       -> 401
POST /api/admin/integrations/razorpay/test (no token, secret probe)   -> 401, probe value absent from response
node: verifyPaymentSignature/verifyWebhookSignature synthetic tests     -> 7/7 PASS
npm run dev:healthcheck (pre-migration)                                  -> 20/20 PASS
npx playwright test (QA repo, full suite, pre-migration)                  -> 84 passed, 1 skipped, 0 failed
Supabase direct fetch() (independent of app)                               -> reachable (401 from REST API, as expected without a key)
POST /api/public/payments/verify (pre-migration check)                      -> 500, server log: PGRST205 "payment_attempts" not found - migration not yet applied

--- post-migration (user applied 0002_phase2_payments_and_integrations.sql) ---
POST /api/public/payments/verify (nonexistent order)                    -> 404 "Payment attempt not found"  (was 500 pre-migration)
POST /api/public/payments/retry (nonexistent order)                     -> 404 "Order not found"             (was 500 pre-migration)
POST /api/public/checkout (prepaid, integration_configs now queryable)   -> 503 "Online payment is not available..." (not 500 - table reachable, correctly empty)
POST /api/public/payments/webhook/razorpay (event A, 1st delivery)       -> 400 {"duplicate":false,"processed":false,"reason":"invalid_signature"}
POST /api/public/payments/webhook/razorpay (event A, 2nd identical)      -> 400 {"duplicate":true}   <- idempotency proven live
npm run dev:healthcheck (post-migration)                                  -> 20/20 PASS
npx playwright test (QA repo, full suite, post-migration)                  -> 85 passed, 0 skipped, 0 failed

--- §9.1 webhook business-state audit (direct-function diagnostic, real self-cleaning fixtures) ---
payment.captured    -> attempt SUCCESS, payment SUCCESS, order payment_status paid
payment.failed      -> attempt FAILED, failure_reason recorded, payment NOT marked success
payment.authorized  -> attempt left INITIATED (not wrongly marked FAILED - the fixed fragility)
refund.created      -> refunds row inserted (INITIATED), refunded_amount NOT yet applied
refund.processed    -> refunded_amount applied (+Rs.40), payment PARTIALLY_REFUNDED, order payment_status partially_refunded
refund.processed (re-delivered, new event_id, same gateway_refund_id) -> amount NOT double-applied
refund.failed       -> refunds row recorded FAILED, refunded_amount unchanged
duplicate delivery (same event_id) -> first processed, second is a no-op (duplicate:true)
invalid signature   -> reported invalid_signature, not processed, attempt state unchanged
== 20/20 PASS; cleanup confirmed: 0 leftover fixture rows ==

--- post-fix regression check (real HTTP endpoint, not just the direct-function audit) ---
POST /api/public/payments/webhook/razorpay (invalid signature)             -> 400 {"duplicate":false,"processed":false,"reason":"invalid_signature"}
POST /api/public/payments/webhook/razorpay (same event again)               -> 400 {"duplicate":true}
POST /api/public/payments/webhook/razorpay (refund.processed, no signature)  -> 400 {"error":"Missing signature or body"}
npm run dev:healthcheck (post-fix)                                            -> 20/20 PASS
npx playwright test (QA repo, full suite, post-fix)                            -> 85 passed, 0 skipped, 0 failed
```

---

## 23. Phase 2 Final Razorpay Verification & Closure (this session)

Real Razorpay Test/Sandbox credentials (§17 #2's previously-recorded BLOCKED item) were provided and enabled by the user since the last update. This session's objective was narrow: use them to complete the remaining live E2E verification and close Phase 2 - not to rework any already-working functionality.

**Order creation against Razorpay's real Test API - VERIFIED LIVE.** `POST /api/public/checkout` (prepaid) with a real, temporarily-published DEV-harness fixture product (`server/dev-harness/seed-test-data.js`, reverted to `draft` immediately after) produced a genuine Razorpay order; Checkout.js opened showing the correct real amount (₹61, matching the server-computed total) fetched live from `api.razorpay.com`, with the "Test Mode" banner Razorpay renders for sandbox keys. This is the one real-API-boundary item §17 #2 flagged as unverifiable without credentials - now VERIFIED.

**Full browser-driven payment completion - BLOCKED (external, not a code defect).** Razorpay's hosted Test Mode Checkout UI runs active bot-detection (`client.px-cloud.net`, a third-party anti-automation script Razorpay embeds) that reliably breaks Playwright-driven interaction with their contact-details step, reproduced identically across multiple attempts in both headless and headed Chromium, using Razorpay's own documented Test Mode values (success card `4100 2800 0000 1007`, failure cards, OTP conventions). Per this task's own instruction not to fabricate a PASS and to mark provider limitations BLOCKED with evidence, further attempts to defeat Razorpay's own anti-automation protection were deliberately not pursued - that would cross from testing into evasion. Consequently, everything downstream of an actual completed payment is also BLOCKED for a *live* run this session, though each is otherwise fully implemented and was already schema/logic-verified in §4-§10 and §9.1:
- Failed-payment scenario (real card decline -> `payments.status = FAILED`)
- Full and partial refund against a real captured payment
- Reconciliation (`fetchPayment`) against a real payment

None of these are new gaps - they are the same "real Razorpay API call" boundary §17 #2 already named, just now blocked by the gateway's own bot defenses rather than by missing credentials.

**Webhook delivery from Razorpay's real servers - BLOCKED (environment).** No public tunnel (zrok/ngrok) is running or configured in this session, so Razorpay's Dashboard has nowhere reachable to deliver a real webhook to `localhost:5100`. The webhook *business logic itself* (signature verification, idempotency, all 5 event types including both refund gaps found and fixed in §9.1) remains VERIFIED via the direct-function diagnostic (20/20) and HTTP-level dedup proof recorded earlier in this report - unaffected by this.

**One genuine defect found and fixed.** A live checkout attempt logged a real CSP violation: Checkout.js injects a fraud/risk-detection script from `cdn.razorpay.com` at runtime, which `script-src` didn't allow (only `checkout.razorpay.com`, added when Checkout.js was first wired up, was). This doesn't stop checkout from opening, but silently starves Razorpay's own risk scoring of signal on every real payment - a payment-security-relevant gap squarely in this task's scope. Fixed with a one-line addition to `server/src/index.js`'s existing CSP config; verified live with a Playwright console listener (1 CSP violation before the fix, 0 after, on an identical checkout attempt); a focused DB-independent regression test was added (QA repo, `tests/regression/payments-regression.spec.js`) asserting the header. DEV healthcheck 21/21 and the full QA suite (86/86 before this session's new test, 87/87 after adding it) both stay green.

**Test-data hygiene.** Diagnostic checkout attempts against the temporarily-published fixture product created 11 real `unpaid` orders (no stock impact - prepaid stock is only decremented on a verified `SUCCESS`, confirmed unchanged at 10 throughout). All 11 were set to `cancelled` via the existing admin order-status endpoint before closing this session, and the fixture product was returned to `draft` (never customer-visible).

### Revised Acceptance Gate (supersedes §21 for the items below only)

| Area | Status |
|---|---|
| Successful payment (order creation, real Test API) | **PASS** - live-verified against Razorpay's real Test servers |
| Successful payment (full browser completion + verify) | **BLOCKED** - Razorpay Test Mode Checkout's own bot-detection blocks automated browser completion in this environment (evidence above); code path itself unchanged and previously reviewed correct |
| Payment verification (signature logic) | **PASS** (§7, unit-verified; the HMAC comparison itself was never in question) |
| Webhook / idempotency | **PASS** - business logic + dedup live-verified (§9, §9.1); real-provider delivery **BLOCKED** (no public tunnel this session) |
| Failed payment | **BLOCKED** - downstream of the browser-completion blocker above |
| Refund | **BLOCKED** - downstream (needs a real captured payment to refund) |
| Partial refund | **BLOCKED** - downstream, same reason |
| Reconciliation | **BLOCKED** - downstream (needs a real payment ID to fetch) |
| Security / RBAC | **PASS** - re-verified, no regression |
| Automated regression | **PASS** - DEV 21/21, QA 87/87 |

### PHASE 2 - Verdict

Not a clean **PHASE 2 - PASS**: three items (failed payment, refund/partial refund, reconciliation) remain genuinely unverified against Razorpay's live servers, and real webhook delivery remains unverified end-to-end from Razorpay's side - both for reasons external to this codebase (the gateway's own anti-automation defenses, and the lack of a public tunnel in this environment), not defects in the implementation, which was independently verified correct via schema-level and direct-function testing in §4-§10 and §9.1. Order creation against the real Test API, previously the single named BLOCKED item, is now VERIFIED. One genuine, unrelated defect (the CSP gap above) was found and fixed with a regression test added.

**PHASE 2 - BLOCKED (partial PASS): all implemented functionality is verified correct at every layer this environment allows; full end-to-end confirmation against Razorpay's live payment/webhook infrastructure requires either a non-automated (manual, human-driven) browser session to get past Razorpay's bot detection, or a public tunnel + Dashboard webhook configuration - both outside what this session's tooling can do without crossing into anti-bot evasion or requiring the user's own Razorpay Dashboard access.**

**Recommendation:** to close the remaining three BLOCKED items, either (a) have a human manually complete one Test Mode checkout in a real browser (not automated) using the documented test cards above, or (b) start a tunnel (zrok/ngrok) and add its URL to the Razorpay Dashboard's Test Mode webhook config, then re-run this same verification. Neither requires further code changes.
