import "dotenv/config.js";

// -----------------------------------------------------------------------
// Phase 9A (P0-3): JWT_SECRET and INTEGRATION_ENCRYPTION_KEY used to fall
// back to a hardcoded, source-committed default ("dev-secret-change-me" /
// "dev-insecure-integration-key-change-me") whenever the env var was
// unset, with no startup check. If either var were ever missing in
// production, admin JWTs become forgeable and/or integration credentials
// (Razorpay etc.) are encrypted with a key visible in the public source
// tree - as bad as plaintext. Fixed by removing both fallbacks entirely
// and failing fast (before the server ever binds a port) whenever either
// var is missing or is an obviously weak/placeholder value, in every
// environment - not just production - so a misconfigured local/CI/test
// run can never mask what would be a critical failure in production. The
// error messages below name only the variable, never a secret value.
// -----------------------------------------------------------------------
const KNOWN_WEAK_SECRETS = new Set([
  "dev-secret-change-me",
  "dev-insecure-integration-key-change-me",
  "change-this-to-a-long-random-string",
  "changeme", "change-me", "secret", "password", "12345678", "",
]);

function requireSecret(envVar, { minLength = 32 } = {}) {
  const raw = process.env[envVar];
  const value = raw ? raw.trim() : "";
  if (!value) {
    throw new Error(
      `FATAL: ${envVar} is not set. Refusing to start without it. Set a real random value in server/.env ` +
      `(see server/.env.example) - generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
    );
  }
  if (value.length < minLength || KNOWN_WEAK_SECRETS.has(value.toLowerCase())) {
    throw new Error(
      `FATAL: ${envVar} is set but too weak (must be a real random secret of at least ${minLength} characters, ` +
      `not a placeholder/example value). Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
    );
  }
  return value;
}

export const config = {
  // Default local port changed from 4000 to 5100 (local-dev config task) to
  // stay clear of other unrelated local projects that may already occupy
  // lower ports (e.g. 3000) on a shared dev machine - still overridable via
  // server/.env's PORT, as before.
  port: process.env.PORT || 5100,
  jwtSecret: requireSecret("JWT_SECRET"),
  // Accepts a single origin ("*" or one URL) or a comma-separated list -
  // this app is a single server serving the API, the SSR public site, and
  // the static admin panel together, so normal same-origin browser usage
  // never actually triggers a CORS check; the list form exists only for
  // the edge case of previewing admin/public-site HTML via a separate
  // static file server (e.g. a "Live Server"-style tool) on another port.
  corsOrigin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean) : "*",

  site: {
    baseUrl: process.env.SITE_BASE_URL || "http://localhost:5100",
    name: "AyurNova",
  },

  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    storageBucket: process.env.SUPABASE_STORAGE_BUCKET || "product-images",
  },

  analytics: {
    flushIntervalMs: Number(process.env.ANALYTICS_FLUSH_INTERVAL_MS || 30000),
    maxBufferSize: Number(process.env.ANALYTICS_MAX_BUFFER || 500),
  },

  ssrCacheTtlMs: Number(process.env.SSR_CACHE_TTL_MS || 300000),

  // Phase 9G: SEED_SUPERADMIN_PASSWORD used to silently fall back to the
  // hardcoded, source-committed "ChangeMe123!" if unset - unlike
  // JWT_SECRET/INTEGRATION_ENCRYPTION_KEY above, this one seeds a REAL,
  // persistent admin login into the database, so a forgotten env var in
  // production would create a SuperAdmin with a publicly-known password.
  // Deliberately NOT validated with requireSecret() here (that would make
  // the whole server refuse to boot over a var only the one-off
  // `npm run seed-admin` script ever reads) - the check lives in that
  // script instead, see seedAdmin.js.
  seed: {
    superAdminEmail: process.env.SEED_SUPERADMIN_EMAIL || "admin@ayurvedastore.example",
    superAdminPassword: process.env.SEED_SUPERADMIN_PASSWORD || null,
  },

  shipping: {
    freeShippingThreshold: Number(process.env.FREE_SHIPPING_THRESHOLD || 599),
    prepaidDiscountPercent: Number(process.env.PREPAID_DISCOUNT_PERCENT || 2),
  },

  // Phase 2: encrypts Razorpay (and any future provider's) credentials at
  // rest in integration_configs - see server/src/integrations/crypto.js.
  // No insecure fallback (Phase 9A P0-3, see requireSecret above) - must
  // be set in every environment, including local dev.
  integrationEncryptionKey: requireSecret("INTEGRATION_ENCRYPTION_KEY"),
};

export const ROLES = ["SuperAdmin", "Admin", "Editor", "Viewer"];

// manageInventory (Phase 5A) follows manageOrders' sensitivity tier, not
// manageProducts'/manageWellness' - batch quantity/status changes move real
// sellable stock and feed an audit ledger, the same operational weight as
// order management, so Editor is false here (same as manageOrders) even
// though Editor already has manageProducts/manageWellness.
// manageReturns (Phase 6B) follows the same tier again - reviewing a
// return decides real refund money and triggers real inventory intake, so
// Editor/Viewer are both false, same as manageOrders/managePayments/
// manageInventory (task explicitly requires Viewer cannot manage returns).
export const ROLE_PERMISSIONS = {
  SuperAdmin: { manageProducts: true, manageOrders: true, manageUsers: true, manageSettings: true, viewCustomers: true, manageCoupons: true, moderateReviews: true, manageIntegrations: true, managePayments: true, manageWellness: true, manageInventory: true, manageReturns: true },
  Admin:      { manageProducts: true, manageOrders: true, manageUsers: false, manageSettings: true, viewCustomers: true, manageCoupons: true, moderateReviews: true, manageIntegrations: true, managePayments: true, manageWellness: true, manageInventory: true, manageReturns: true },
  Editor:     { manageProducts: true, manageOrders: false, manageUsers: false, manageSettings: false, viewCustomers: false, manageCoupons: false, moderateReviews: true, manageIntegrations: false, managePayments: false, manageWellness: true, manageInventory: false, manageReturns: false },
  Viewer:     { manageProducts: false, manageOrders: false, manageUsers: false, manageSettings: false, viewCustomers: true, manageCoupons: false, moderateReviews: false, manageIntegrations: false, managePayments: false, manageWellness: false, manageInventory: false, manageReturns: false },
};

// Payment statuses - Phase 2. `payments.status`/`payment_attempts.status`
// use the upper-case set (matches Razorpay's own vocabulary); the
// pre-existing `orders.payment_status` keeps its lower-case values for
// backward compatibility with existing admin/public-site code that already
// checks for the literal strings "paid"/"unpaid"/"refunded" - see
// supabase/migrations/0002_phase2_payments_and_integrations.sql.
export const PAYMENT_STATUSES = ["INITIATED", "PENDING", "SUCCESS", "FAILED", "CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED"];
export const PAYMENT_ATTEMPT_STATUSES = ["INITIATED", "PENDING", "SUCCESS", "FAILED", "CANCELLED"];
export const ORDER_PAYMENT_STATUSES = ["unpaid", "paid", "refunded", "partially_refunded", "failed"];

// Product field schema - shared source of truth for admin form rendering
// and server-side validation (mirrors the pattern used in the Jobs11 build).
export const PRODUCT_FIELDS = [
  { key: "title", label: "Product Title", type: "text", required: true, maxLength: 200 },
  { key: "brand", label: "Brand", type: "text", required: false, maxLength: 100 },
  { key: "category_id", label: "Category", type: "category-select", required: false },
  { key: "short_description", label: "Short Description (bullets, one per line)", type: "textarea", required: false, maxLength: 800 },
  { key: "description", label: "Full Description", type: "textarea", required: false, maxLength: 5000 },
  { key: "ingredients", label: "Ingredients", type: "textarea", required: false, maxLength: 2000 },
  { key: "how_to_use", label: "How to Use", type: "textarea", required: false, maxLength: 1000 },
  { key: "seo_title", label: "SEO Title", type: "text", required: false, maxLength: 160 },
  { key: "seo_description", label: "SEO Meta Description", type: "textarea", required: false, maxLength: 300 },
  { key: "status", label: "Status", type: "enum", values: ["draft", "published", "archived"], system: true },
];
