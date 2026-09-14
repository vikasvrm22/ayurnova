/**
 * Curated requirement registry. Every record's `requirement` text and
 * `sourceReference` are traced to an actual file/line in this repository -
 * either its approved documentation (docs/, docs/product-strategy/) or the
 * application's own code/schema where the code itself states an explicit
 * invariant (e.g. notificationService.js's own docstring, paymentService.js's
 * own retry-cap comment). Nothing here is invented: this file is the
 * authoritative seed the rest of the Guardian audits against, and every
 * addition to it must carry a real citation - see docs/REQUIREMENTS-GUARDIAN.md
 * "Growing the registry".
 *
 * `checkerId` (when present) names a function exported from
 * ../compliance/checkers/index.js that performs an automated, evidence-based
 * compliance check against the CURRENT repository. Requirements without a
 * checkerId are not mechanically verifiable by static analysis (business
 * content authorship, live database state, cross-agent scope) and are
 * reported NEEDS_REVIEW/NOT_APPLICABLE with an explicit reason rather than a
 * fabricated PASS - see spec section "no fake coverage".
 */

export const REQUIREMENTS = [
  // ---------------------------------------------------------------- COD --
  {
    id: "REQ-COD-001",
    title: "COD availability must be enforced server-side, not just hidden in the UI",
    category: "BUSINESS_RULE",
    lifecycle: "ACTIVE",
    priority: "P0",
    scope: ["checkout", "payments", "cod"],
    requirement:
      "The Admin-controlled \"COD Available\" toggle (settings.trust_badges.cod) must gate COD order creation on the server, not merely hide the storefront trust badge - a direct API call must not be able to bypass an admin's decision to disable COD.",
    sourceReference: {
      file: "docs/product-strategy/AYURNOVA-PHASE-9-PRODUCTION-READINESS-AUDIT.md",
      line: 33,
      note: "P1-3, originally a gap; fixed per docs/product-strategy/AYURNOVA-PHASE-9-FINAL-GO-LIVE-AUDIT.md and server/src/routes/public.js:78-86.",
    },
    checkerId: "codFeatureFlagServerEnforced",
  },
  {
    id: "REQ-COD-002",
    title: "COD refunds are gated by a settings feature flag, default OFF",
    category: "FEATURE_FLAG_RULE",
    lifecycle: "ACTIVE",
    priority: "P1",
    scope: ["returns", "refunds", "cod"],
    requirement:
      "COD order refunds are manual/offline-tracking only (no payment gateway transaction exists for a COD order) and must be gated server-side by settings.returns.cod_refund_enabled, seeded default false.",
    sourceReference: { file: "supabase/migrations/0008_phase6b_returns.sql", line: 107 },
    checkerId: "codRefundFlagServerEnforced",
  },

  // ------------------------------------------------------------ Secrets --
  {
    id: "REQ-SECRETS-001",
    title: "JWT_SECRET / INTEGRATION_ENCRYPTION_KEY must never fall back to a hardcoded value",
    category: "SECURITY_REQUIREMENT",
    lifecycle: "ACTIVE",
    priority: "P0",
    scope: ["security", "auth", "config"],
    requirement:
      "server/src/config.js must not silently fall back to a hardcoded default for JWT_SECRET or INTEGRATION_ENCRYPTION_KEY; it must fail fast at boot (every environment) when either is missing, too short (<32 chars), or a known placeholder value, and must never echo the rejected value.",
    sourceReference: {
      file: "docs/product-strategy/AYURNOVA-PHASE-9A-P0-CLOSURE.md",
      line: 71,
      note: "P0-3 closure report; fix in server/src/config.js.",
    },
    checkerId: "secretsFailFast",
  },
  {
    id: "REQ-SECRETS-002",
    title: "SEED_SUPERADMIN_PASSWORD must never use a weak default and must never be echoed",
    category: "SECURITY_REQUIREMENT",
    lifecycle: "ACTIVE",
    priority: "P0",
    scope: ["security", "auth", "admin"],
    requirement:
      "server/src/scripts/seedAdmin.js must refuse to seed a Super Admin when SEED_SUPERADMIN_PASSWORD is missing, too short, or a known weak/placeholder value, and must never print the real password to stdout.",
    sourceReference: {
      file: "server/src/scripts/seedAdmin.js",
      line: 7,
      note: "Phase 9G self-documented fix; own docstring states the prior insecure behavior and the fix.",
    },
    checkerId: "seedAdminPasswordSafety",
  },

  // -------------------------------------------------------------- Legal --
  {
    id: "REQ-LEGAL-001",
    title: "Only published legal pages may ever be served publicly",
    category: "SECURITY_REQUIREMENT",
    lifecycle: "ACTIVE",
    priority: "P0",
    scope: ["legal", "cms"],
    requirement:
      "Public legal-page routes must only ever render a legal_pages row whose status is 'published'; a draft row must 404, regardless of its content.",
    sourceReference: { file: "docs/product-strategy/AYURNOVA-PHASE-9A-P0-CLOSURE.md", line: 49 },
    checkerId: "legalPublishGate",
  },
  {
    id: "REQ-LEGAL-002",
    title: "legal_pages.slug is a fixed, closed set of four pages",
    category: "DATA_CONTRACT",
    lifecycle: "ACTIVE",
    priority: "P2",
    scope: ["legal", "cms"],
    requirement:
      "legal_pages.slug must be constrained to exactly: terms-and-conditions, privacy-policy, return-refund-policy, shipping-policy.",
    sourceReference: { file: "supabase/migrations/0009_phase7_notifications_and_legal_cms.sql", line: 74 },
    checkerId: "legalSlugEnum",
  },
  {
    id: "REQ-LEGAL-CONTENT-001",
    title: "Real, business-approved legal copy must be authored and published before launch",
    category: "FUTURE_FEATURE",
    lifecycle: "FUTURE",
    priority: "P0",
    scope: ["legal", "cms", "launch-readiness"],
    requirement:
      "Before customer checkout is opened to real customers, the business must author and publish real Terms & Conditions, Privacy Policy, Return & Refund Policy, and Shipping Policy content through Admin -> Legal Pages. This is a business-content action, not an engineering task - no code change can satisfy it, and no legal copy may be fabricated by the Guardian or by engineering.",
    sourceReference: {
      file: "docs/product-strategy/AYURNOVA-PHASE-9A-P0-CLOSURE.md",
      line: 65,
      note: "Still BLOCKED per docs/product-strategy/AYURNOVA-PHASE-9-FINAL-GO-LIVE-AUDIT.md as of that audit's writing.",
    },
    checkerId: "legalContentAuthored",
  },
  {
    id: "REQ-WELLNESS-CONTENT-001",
    title: "Wellness Assessment needs published questions before it is a real feature",
    category: "FUTURE_FEATURE",
    lifecycle: "FUTURE",
    priority: "P1",
    scope: ["wellness", "launch-readiness"],
    requirement:
      "The Wellness Assessment (dosha test) is linked from navigation but has zero published questions; this is an honest empty state (not a crash) and is explicitly business-content-blocked, not an engineering defect. It must not be reported as a missing/broken feature by static analysis of code alone.",
    sourceReference: { file: "docs/product-strategy/AYURNOVA-PHASE-9-PRODUCTION-READINESS-AUDIT.md", line: 31 },
    checkerId: null,
  },

  // ---------------------------------------------------------- Shipping --
  {
    id: "REQ-SHIPPING-001",
    title: "Real courier-provider integration is deferred by business decision, not a defect",
    category: "FUTURE_FEATURE",
    lifecycle: "FUTURE",
    priority: "P2",
    scope: ["shipping", "logistics"],
    requirement:
      "Only a \"manual\" shipping provider (staff-typed AWB/tracking, no live courier API) is registered in server/src/integrations/shipping/registry.js. Live courier integration (Shiprocket, Delhivery, etc.) is an explicit, deferred business decision - architecture (SHIPPING_PROVIDERS registry) is ready for it, but its absence must not be reported as a missing requirement.",
    sourceReference: { file: "docs/product-strategy/AYURNOVA-PHASE-9-PRODUCTION-READINESS-AUDIT.md", line: 32 },
    checkerId: "shippingManualOnlyExpected",
  },
  {
    id: "REQ-SHIPMENT-STATE-001",
    title: "Shipment status lifecycle is a fixed, closed enum",
    category: "STATE_RULE",
    lifecycle: "ACTIVE",
    priority: "P1",
    scope: ["shipping", "state"],
    requirement:
      "shipments.status must be constrained to exactly: pending, label_generated, pickup_scheduled, picked_up, in_transit, out_for_delivery, delivered, failed_delivery, rto_initiated, rto_in_transit, rto_delivered, cancelled.",
    sourceReference: { file: "supabase/migrations/0011_phase8b_shipping_logistics.sql", line: 45 },
    checkerId: "shipmentStatusEnum",
  },

  // ------------------------------------------------------------ Orders --
  {
    id: "REQ-ORDERS-STATE-001",
    title: "Order status lifecycle is a fixed, closed enum (post-Phase-8B)",
    category: "STATE_RULE",
    lifecycle: "ACTIVE",
    priority: "P1",
    scope: ["orders", "state"],
    requirement:
      "orders.status must be constrained to exactly: pending, processing, shipped, delivered, cancelled, rto (widened from the original schema's five-value set by Phase 8B to add rto).",
    sourceReference: { file: "supabase/migrations/0011_phase8b_shipping_logistics.sql", line: 141 },
    checkerId: "ordersStatusEnum",
  },

  // ---------------------------------------------------------- Payments --
  {
    id: "REQ-PAYMENT-RETRY-001",
    title: "Payment retry attempts must be capped per order",
    category: "BUSINESS_RULE",
    lifecycle: "ACTIVE",
    priority: "P1",
    scope: ["payments", "security"],
    requirement:
      "A single order must not be able to generate unbounded Razorpay order-creation attempts via retry; attempts must be capped (10 per order) to prevent gateway-spam abuse.",
    sourceReference: { file: "server/src/services/paymentService.js", line: 30 },
    checkerId: "paymentRetryCap",
  },
  {
    id: "REQ-PAYMENT-WEBHOOK-001",
    title: "Webhook events must pass HMAC signature verification before any business-state write",
    category: "SECURITY_REQUIREMENT",
    lifecycle: "ACTIVE",
    priority: "P0",
    scope: ["payments", "security", "webhooks"],
    requirement:
      "The Razorpay webhook route must verify the request's HMAC signature over the raw body before any payment/order state is written, and must reject (4xx) rather than silently accept (2xx) an invalid or missing signature.",
    sourceReference: { file: "docs/AYURVEDICSTORE-PHASE-2-IMPLEMENTATION-REPORT.md", line: 127 },
    checkerId: "webhookSignatureVerification",
  },
  {
    id: "REQ-PAYMENT-STATE-001",
    title: "Payment status lifecycle is a fixed, closed enum",
    category: "STATE_RULE",
    lifecycle: "ACTIVE",
    priority: "P1",
    scope: ["payments", "state"],
    requirement:
      "payments.status must be constrained to exactly: INITIATED, PENDING, SUCCESS, FAILED, CANCELLED, REFUNDED, PARTIALLY_REFUNDED.",
    sourceReference: { file: "supabase/migrations/0002_phase2_payments_and_integrations.sql", line: 47 },
    checkerId: "paymentStatusEnum",
  },
  {
    id: "REQ-REFUND-STATE-001",
    title: "Refund status lifecycle is a fixed, closed enum",
    category: "STATE_RULE",
    lifecycle: "ACTIVE",
    priority: "P1",
    scope: ["payments", "refunds", "state"],
    requirement: "refunds.status must be constrained to exactly: INITIATED, PROCESSED, FAILED.",
    sourceReference: { file: "supabase/migrations/0002_phase2_payments_and_integrations.sql", line: 91 },
    checkerId: "refundStatusEnum",
  },
  {
    id: "REQ-RETURNS-STATE-001",
    title: "Return request status lifecycle is a fixed, closed enum",
    category: "STATE_RULE",
    lifecycle: "ACTIVE",
    priority: "P1",
    scope: ["returns", "state"],
    requirement: "return_requests.status must be constrained to exactly: requested, approved, rejected, refunded.",
    sourceReference: { file: "supabase/migrations/0008_phase6b_returns.sql", line: 41 },
    checkerId: "returnRequestStatusEnum",
  },

  // ------------------------------------------------------------- Notify --
  {
    id: "REQ-NOTIFY-001",
    title: "Notification dispatch must never block or roll back the transaction that triggered it",
    category: "BUSINESS_RULE",
    lifecycle: "ACTIVE",
    priority: "P1",
    scope: ["notifications", "orders", "returns", "refunds"],
    requirement:
      "notify() (server/src/notify/notificationService.js) must never throw. A provider outage, missing table, or malformed context must never roll back or block the real order/return/refund action that triggered the notification - every failure path must end in a caught, logged error, never an exception that propagates to the caller.",
    sourceReference: { file: "server/src/notify/notificationService.js", line: 10 },
    checkerId: "notifyNeverThrows",
  },
  {
    id: "REQ-NOTIFY-002",
    title: "Notification retriggering the same business event must be a safe no-op",
    category: "DATA_CONTRACT",
    lifecycle: "ACTIVE",
    priority: "P2",
    scope: ["notifications"],
    requirement:
      "notification_log must enforce unique(event, channel, dedupe_key) so that retriggering the same business event fails fast (before any external send is attempted) rather than sending a duplicate notification.",
    sourceReference: { file: "server/src/notify/notificationService.js", line: 19 },
    checkerId: "notificationDedupConstraint",
  },
  {
    id: "REQ-NOTIFY-RETRY-001",
    title: "Notification retry/resend tooling is deferred, not a launch blocker",
    category: "FUTURE_FEATURE",
    lifecycle: "FUTURE",
    priority: "P3",
    scope: ["notifications"],
    requirement:
      "notify() makes a single send attempt per channel with no automatic retry loop; this is an explicitly accepted, deferred gap (failures remain visible via notification_log, so it is non-blocking), not a defect to report as missing.",
    sourceReference: { file: "docs/product-strategy/AYURNOVA-PHASE-9-PRODUCTION-READINESS-AUDIT.md", line: 36 },
    checkerId: null,
  },

  // ---------------------------------------------------------------- Tax --
  {
    id: "REQ-TAX-001",
    title: "Tax figures must be snapshotted at checkout, immune to later config changes",
    category: "DATA_CONTRACT",
    lifecycle: "ACTIVE",
    priority: "P1",
    scope: ["tax", "orders", "invoices"],
    requirement:
      "Order/order-item rows must snapshot hsn_code, tax_rate, and cgst/sgst/igst amounts at the moment of checkout, so a later change to tax settings never silently recomputes or alters an existing order's historical tax figures.",
    sourceReference: { file: "server/src/routes/public.js", line: 194 },
    checkerId: "taxSnapshotColumns",
  },
  {
    id: "REQ-TAX-GST-001",
    title: "Enabling GST-exclusive mode / credit notes requires GST-advisor sign-off first",
    category: "FUTURE_FEATURE",
    lifecycle: "FUTURE",
    priority: "P1",
    scope: ["tax", "launch-readiness"],
    requirement:
      "The GST-exclusive-mode refund-cap gap and the absence of a credit-note mechanism are dormant while settings.tax_profile.gst_registered is false. Enabling gst_registered=true or exclusive pricing mode requires explicit GST-advisor sign-off before it is safe to flip - this is a pending business decision, not an engineering defect to fix unilaterally.",
    sourceReference: { file: "docs/product-strategy/AYURNOVA-PHASE-9-PRODUCTION-READINESS-AUDIT.md", line: 34 },
    checkerId: "taxProfileGstRegisteredDormant",
  },

  // ----------------------------------------------------------- Discovery --
  {
    id: "REQ-DETERMINISTIC-001",
    title: "Dosha/search/recommendation logic must remain deterministic - no AI/ML/LLM",
    category: "DOMAIN_RULE",
    lifecycle: "ACTIVE",
    priority: "P1",
    scope: ["wellness", "search", "recommendations", "discovery"],
    requirement:
      "Dosha scoring, catalog search, and product recommendations must remain plain deterministic logic (vote-counting, SQL ILIKE, explicit conditionals) - no AI/ML/LLM ranking model or dependency may be introduced into this code path.",
    sourceReference: { file: "server/src/services/wellnessService.js", line: 3 },
    checkerId: "deterministicNoAiDependency",
  },
  {
    id: "REQ-MARKETPLACE-001",
    title: "The product has no marketplace/seller/vendor concept",
    category: "APPROVED_DECISION",
    lifecycle: "ACTIVE",
    priority: "P2",
    scope: ["architecture", "catalog"],
    requirement:
      "AyurNova is architecturally a single-brand store, not a marketplace - there is no seller/vendor table or seller-scoped data anywhere in the schema, and none should be introduced without a new, explicit product decision.",
    sourceReference: { file: "docs/AYURVEDICSTORE-PHASE-0-AUDIT.md", line: 11 },
    checkerId: "noMarketplaceSellerTables",
  },

  // ------------------------------------------------------------- RBAC --
  {
    id: "REQ-RBAC-001",
    title: "Every mutating admin route requires staff auth + an explicit permission",
    category: "SECURITY_REQUIREMENT",
    lifecycle: "ACTIVE",
    priority: "P0",
    scope: ["security", "rbac", "admin"],
    requirement:
      "Every *Admin.js route file must apply requireStaffAuth on every route and requirePermission(...) on every mutating route - RBAC enforcement must be server-side and authoritative, never inferred from what the admin frontend hides.",
    sourceReference: { file: "docs/product-strategy/AYURNOVA-PHASE-9-FINAL-GO-LIVE-AUDIT.md", line: 1 },
    // Intentionally no independent RBAC sweep: quality-agents/wiring-guardian
    // already owns a full RBAC engine (its own security-engine, section 2 of
    // this Guardian's spec forbids duplicating another agent's full
    // responsibility). This requirement is tracked here for registry
    // completeness and traceability, and its verification defers to Wiring
    // Guardian's own evidence when available - see checkers/rbacDeferred.js.
    checkerId: "rbacDeferredToWiringGuardian",
  },

  // ------------------------------------------------------- Out of scope --
  {
    id: "REQ-SETTLEMENTS-001",
    title: "Razorpay Settlements reconciliation is out of scope",
    category: "FUTURE_FEATURE",
    lifecycle: "FUTURE",
    priority: "P3",
    scope: ["payments", "reconciliation"],
    requirement:
      "Reconciliation compares local status against Razorpay's Payments API only; it does not reach Settlements/bank-transfer records. This is an acknowledged, self-disclosed scope boundary, not a defect - closing it requires commissioning a new Razorpay Settlements integration.",
    sourceReference: { file: "docs/product-strategy/AYURNOVA-PHASE-9-PRODUCTION-READINESS-AUDIT.md", line: 38 },
    checkerId: null,
  },
  {
    id: "REQ-ENV-SEPARATION-001",
    title: "Production vs. dev Supabase project identity must be confirmed before go-live",
    category: "APPROVED_DECISION",
    lifecycle: "NEEDS_REVIEW",
    priority: "P1",
    scope: ["launch-readiness", "infrastructure"],
    requirement:
      "Only one Supabase project is configured anywhere in this repository/environment; whether it is the real production project or a throwaway dev project has never been explicitly confirmed by the business. This must be confirmed before go-live - it cannot be resolved by static code analysis.",
    sourceReference: { file: "docs/product-strategy/AYURNOVA-PHASE-9-FINAL-GO-LIVE-AUDIT.md", line: 1, note: "section W.7" },
    checkerId: null,
  },
  {
    id: "REQ-CORS-001",
    title: "CORS_ORIGIN must not default to a wildcard in production",
    category: "SECURITY_REQUIREMENT",
    lifecycle: "NEEDS_REVIEW",
    priority: "P2",
    scope: ["security", "config", "launch-readiness"],
    requirement:
      "corsOrigin must not be left at its wildcard (*) default in a production deployment; CORS_ORIGIN must be explicitly set to the real production domain before launch. This is an operational/deployment configuration action, not a code defect this repository can fix on its own.",
    sourceReference: { file: "docs/product-strategy/AYURNOVA-PHASE-9-PRODUCTION-READINESS-AUDIT.md", line: 13 },
    checkerId: null,
  },

  // ------------------------------------------------------- Deprecated --
  {
    id: "REQ-SETTINGS-UI-001",
    title: "Settings UI must not advertise the old, superseded Razorpay-config-via-.env text",
    category: "DEPRECATED_REQUIREMENT",
    lifecycle: "DEPRECATED",
    priority: "P3",
    scope: ["admin", "settings", "integrations"],
    requirement:
      "The pre-Phase-2 Admin Settings copy claiming \"Razorpay / PayU keys configured via server .env - not editable here for security\" was superseded once the real, encrypted, per-provider Integrations admin panel (integration_configs table, Phase 2) was built. That stale text must not reappear in the admin settings UI.",
    sourceReference: { file: "docs/AYURVEDICSTORE-PHASE-0-AUDIT.md", line: 217 },
    checkerId: "staleSettingsUiTextAbsent",
  },
];
