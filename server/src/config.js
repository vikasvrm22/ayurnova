import "dotenv/config.js";

export const config = {
  // Default local port changed from 4000 to 5100 (local-dev config task) to
  // stay clear of other unrelated local projects that may already occupy
  // lower ports (e.g. 3000) on a shared dev machine - still overridable via
  // server/.env's PORT, as before.
  port: process.env.PORT || 5100,
  jwtSecret: process.env.JWT_SECRET || "dev-secret-change-me",
  // Accepts a single origin ("*" or one URL) or a comma-separated list -
  // this app is a single server serving the API, the SSR public site, and
  // the static admin panel together, so normal same-origin browser usage
  // never actually triggers a CORS check; the list form exists only for
  // the edge case of previewing admin/public-site HTML via a separate
  // static file server (e.g. a "Live Server"-style tool) on another port.
  corsOrigin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean) : "*",

  site: {
    baseUrl: process.env.SITE_BASE_URL || "http://localhost:5100",
    name: "AyurVeda Store",
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

  seed: {
    superAdminEmail: process.env.SEED_SUPERADMIN_EMAIL || "admin@ayurvedastore.example",
    superAdminPassword: process.env.SEED_SUPERADMIN_PASSWORD || "ChangeMe123!",
  },

  shipping: {
    freeShippingThreshold: Number(process.env.FREE_SHIPPING_THRESHOLD || 599),
    prepaidDiscountPercent: Number(process.env.PREPAID_DISCOUNT_PERCENT || 2),
  },

  // Phase 2: encrypts Razorpay (and any future provider's) credentials at
  // rest in integration_configs - see server/src/integrations/crypto.js.
  // The fallback is a clearly-labelled dev-only value, same pattern as
  // jwtSecret above - set a real INTEGRATION_ENCRYPTION_KEY in production.
  integrationEncryptionKey: process.env.INTEGRATION_ENCRYPTION_KEY || "dev-insecure-integration-key-change-me",
};

export const ROLES = ["SuperAdmin", "Admin", "Editor", "Viewer"];

export const ROLE_PERMISSIONS = {
  SuperAdmin: { manageProducts: true, manageOrders: true, manageUsers: true, manageSettings: true, viewCustomers: true, manageCoupons: true, moderateReviews: true, manageIntegrations: true, managePayments: true, manageWellness: true },
  Admin:      { manageProducts: true, manageOrders: true, manageUsers: false, manageSettings: true, viewCustomers: true, manageCoupons: true, moderateReviews: true, manageIntegrations: true, managePayments: true, manageWellness: true },
  Editor:     { manageProducts: true, manageOrders: false, manageUsers: false, manageSettings: false, viewCustomers: false, manageCoupons: false, moderateReviews: true, manageIntegrations: false, managePayments: false, manageWellness: true },
  Viewer:     { manageProducts: false, manageOrders: false, manageUsers: false, manageSettings: false, viewCustomers: true, manageCoupons: false, moderateReviews: false, manageIntegrations: false, managePayments: false, manageWellness: false },
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
