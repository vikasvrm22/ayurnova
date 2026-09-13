import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import { config, ROLES, ROLE_PERMISSIONS, PRODUCT_FIELDS } from "./config.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { startAnalyticsFlusher } from "./analytics/tracker.js";
import pagesRouter, { render404Page } from "./routes/pages.js";

import adminAuthRoutes from "./routes/adminAuthRoutes.js";
import productsRoutes from "./routes/products.js";
import categoriesRoutes from "./routes/categories.js";
import ordersRoutes from "./routes/orders.js";
import customersRoutes from "./routes/customers.js";
import couponsRoutes from "./routes/coupons.js";
import reviewsRoutes from "./routes/reviews.js";
import vaidyaBookingsRoutes from "./routes/vaidyaBookings.js";
import blogRoutes from "./routes/blog.js";
import settingsRoutes from "./routes/settings.js";
import dashboardRoutes from "./routes/dashboard.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import publicRoutes from "./routes/public.js";
import catalogPublicRoutes from "./routes/catalogPublic.js";
import paymentsPublicRoutes from "./routes/paymentsPublic.js";
import paymentsAdminRoutes from "./routes/paymentsAdmin.js";
import integrationsAdminRoutes from "./routes/integrationsAdmin.js";
// ---- Phase 3: Ayurveda Discovery & Knowledge ----
import ingredientsRoutes from "./routes/ingredients.js";
import faqsRoutes from "./routes/faqs.js";
import blogPublicRoutes from "./routes/blogPublic.js";
// ---- Phase 4: Personalization ----
import wellnessAdminRoutes from "./routes/wellnessAdmin.js";
import routinesAdminRoutes from "./routes/routinesAdmin.js";
import wellnessPublicRoutes from "./routes/wellnessPublic.js";
import routinesPublicRoutes from "./routes/routinesPublic.js";
// ---- Phase 5A: Inventory foundation ----
import inventoryAdminRoutes from "./routes/inventoryAdmin.js";
// ---- Phase 6A: Customer Orders & Address Management ----
import orderDetailPublicRoutes from "./routes/orderDetailPublic.js";
import addressesPublicRoutes from "./routes/addressesPublic.js";
// ---- Phase 6B: Returns & Refund Experience ----
import returnsPublicRoutes from "./routes/returnsPublic.js";
import returnsAdminRoutes from "./routes/returnsAdmin.js";
// ---- Phase 7: Customer Communications & Legal Readiness ----
import notificationsAdminRoutes from "./routes/notificationsAdmin.js";
import legalAdminRoutes from "./routes/legalAdmin.js";
// ---- Phase 8A: Tax & Invoicing ----
import invoicesAdminRoutes from "./routes/invoicesAdmin.js";
// ---- Phase 8B: Shipping & Logistics ----
import shipmentsAdminRoutes from "./routes/shipmentsAdmin.js";
import shipmentWebhooksPublicRoutes from "./routes/shipmentWebhooksPublic.js";
// ---- Phase 8C: Customer Wishlist ----
import wishlistPublicRoutes from "./routes/wishlistPublic.js";
// ---- Phase 8D: Buy Again ----
import buyAgainPublicRoutes from "./routes/buyAgainPublic.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ---------------------------------------------------------------------------
// Security & performance (same approach as the Jobs11 build)
// ---------------------------------------------------------------------------
app.set("trust proxy", 1); // needed for correct client IP behind a reverse proxy/CDN

app.use(compression());

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Phase 2 final-verification finding: Checkout.js itself injects a
        // risk-detection/fraud-prevention script from cdn.razorpay.com at
        // runtime (confirmed live - a real checkout attempt logged
        // "Loading the script 'https://cdn.razorpay.com/static/cx/
        // razorpay-risk-detection/bundle.js' violates ... script-src").
        // checkout.razorpay.com alone (added in Phase 2) covers the main
        // Checkout.js bundle but not this second-party script it loads for
        // itself - without it, Razorpay's own fraud signal for this session
        // never reaches them, degrading their side of transaction risk
        // scoring on every real payment attempt.
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://checkout.razorpay.com", "https://cdn.razorpay.com"],
        // Phase 1 finding (discovered via real-browser E2E testing, not
        // present in Phase 0's curl-only audit): helmet's secure-by-default
        // CSP directives include `script-src-attr 'none'` unless overridden,
        // which is a SEPARATE directive from `script-src` under CSP Level 3
        // - `scriptSrc`'s 'unsafe-inline' above only covers inline <script>
        // elements, not inline `onclick="..."` HTML attributes. Every page
        // in this app (storefront and admin) relies extensively on inline
        // onclick/onchange handlers - without this, product cards, Add to
        // Cart, cart quantity controls, and most admin action buttons are
        // silently non-functional in every real browser (confirmed by
        // reproducing against a live Chromium instance - the dosha quiz's
        // "Next" button stayed permanently disabled because its option
        // `onclick="selectOption(...)"` handlers were blocked). This
        // restores the behaviour the rest of the config already intends.
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", config.supabase.url || "https://*.supabase.co", "https://api.razorpay.com", "https://checkout.razorpay.com", "https://lumberjack.razorpay.com"].filter(Boolean),
        // Razorpay Checkout opens its payment UI inside an iframe it injects.
        frameSrc: ["'self'", "https://api.razorpay.com", "https://checkout.razorpay.com"],
      },
    },
  })
);

app.use(cors({ origin: config.corsOrigin }));
// Phase 2: Razorpay webhook signature verification needs the EXACT raw
// request body bytes (the HMAC is computed over them), which are gone
// once express.json() parses them into an object. `verify` runs before
// parsing and lets us stash the raw buffer on the request without
// changing how every other route uses the normal parsed req.body.
app.use(express.json({ limit: "2mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 400, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const checkoutLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

app.use("/api/admin/auth/login", authLimiter);
app.use("/api/public/checkout", checkoutLimiter);
app.use("/api", apiLimiter);

// ---- Admin API ----
app.use("/api/admin/auth", adminAuthRoutes);
app.use("/api/admin/products", productsRoutes);
app.use("/api/admin/categories", categoriesRoutes);
app.use("/api/admin/orders", ordersRoutes);
app.use("/api/admin/customers", customersRoutes);
app.use("/api/admin/coupons", couponsRoutes);
app.use("/api/admin/reviews", reviewsRoutes);
app.use("/api/admin/vaidya-bookings", vaidyaBookingsRoutes);
app.use("/api/admin/blog", blogRoutes);
app.use("/api/admin/settings", settingsRoutes);
app.use("/api/admin/dashboard", dashboardRoutes);
app.use("/api/admin/analytics", analyticsRoutes);
// ---- Admin Payments + Integration Management (Phase 2) ----
app.use("/api/admin/payments", paymentsAdminRoutes);
app.use("/api/admin/integrations", integrationsAdminRoutes);
// ---- Admin Discovery & Knowledge content (Phase 3) ----
app.use("/api/admin/ingredients", ingredientsRoutes);
app.use("/api/admin/faqs", faqsRoutes);
// ---- Admin Personalization content (Phase 4) ----
app.use("/api/admin/wellness/questions", wellnessAdminRoutes);
app.use("/api/admin/routines", routinesAdminRoutes);
app.use("/api/admin/inventory", inventoryAdminRoutes);

// ---- Public API (storefront AJAX: checkout, reviews, bookings, coupons) ----
app.use("/api/public", publicRoutes);

// ---- Public catalog API (Phase 1: products/categories/search JSON - the
// Android-readiness gap identified in Phase 0 §6; extended in Phase 3 with
// ingredients/richer categories/multi-value filtering/compare; extended in
// Phase 4 with a `dosha` filter dimension) ----
app.use("/api/public", catalogPublicRoutes);

// ---- Public payment API (Phase 2: verify/retry/webhook) ----
app.use("/api/public/payments", paymentsPublicRoutes);

// ---- Public Knowledge Hub API (Phase 3) ----
app.use("/api/public/blog", blogPublicRoutes);

// ---- Public Personalization API (Phase 4: assessment/profile/
// recommendations + general routine browsing) ----
app.use("/api/public/wellness", wellnessPublicRoutes);
app.use("/api/public/routines", routinesPublicRoutes);

// ---- Public Customer Orders & Address Management API (Phase 6A). Mounted
// AFTER publicRoutes (line 137) above, which already owns the exact
// GET /api/public/my-orders (list) path - this router only adds /:id and
// /:id/cancel, sub-paths publicRoutes never defined, so there is no
// overlap in practice. ----
app.use("/api/public/my-orders", orderDetailPublicRoutes);
app.use("/api/public/addresses", addressesPublicRoutes);

// ---- Public/Admin Returns & Refund Experience (Phase 6B) ----
app.use("/api/public/returns", returnsPublicRoutes);
app.use("/api/admin/returns", returnsAdminRoutes);

// ---- Admin Customer Communications & Legal CMS (Phase 7). No new public
// API: legal pages are served as SSR routes by pagesRouter below (they're
// content pages, not client-fetched JSON, same as /faq/blog/about), and
// there is no customer-facing notification API at all. ----
app.use("/api/admin/notifications", notificationsAdminRoutes);
app.use("/api/admin/legal-pages", legalAdminRoutes);

// ---- Admin Tax & Invoicing (Phase 8A). No new public API for tax
// config itself - the customer-facing pieces (GSTIN/billing address at
// checkout, own-invoice view/download) live on the existing checkout
// route and orderDetailPublic.js's /:id/invoice sub-routes. ----
app.use("/api/admin/invoices", invoicesAdminRoutes);

// ---- Admin + public Shipping & Logistics (Phase 8B). The webhook route
// is public/unauthenticated by design (a courier's own signature is the
// auth, same trust model as paymentsPublicRoutes' Razorpay webhook above) -
// it still passes through the generic apiLimiter applied earlier
// (app.use("/api", apiLimiter)), same as every other /api/public route. ----
app.use("/api/admin/shipments", shipmentsAdminRoutes);
app.use("/api/public/shipping-webhooks", shipmentWebhooksPublicRoutes);

// ---- Public Customer Wishlist (Phase 8C). No admin API - wishlist is
// customer-owned personal data, same as addresses/wellness profile,
// neither of which has an admin view either. ----
app.use("/api/public/wishlist", wishlistPublicRoutes);

// ---- Public Customer Buy Again (Phase 8D). No admin API and no new
// commerce write path - reads existing order history, reuses the
// existing cart/checkout flow for the actual reorder. ----
app.use("/api/public/buy-again", buyAgainPublicRoutes);

app.get("/api/meta/schema", (req, res) => {
  res.json({ roles: ROLES, rolePermissions: ROLE_PERMISSIONS, productFields: PRODUCT_FIELDS });
});
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---- Admin panel (static SPA) ----
// `index: "dashboard.html"` makes /admin/ (and bare /admin) resolve to the
// existing dashboard page instead of 404ing - express.static's default
// directory-index file is "index.html", which this admin/ directory has
// never had (every page is separately named: login.html, dashboard.html,
// etc.). dashboard.html already self-guards via requireAdminAuth() in its
// own inline <script>, redirecting to login.html when unauthenticated -
// that behaviour is unchanged, just now also reachable at the bare /admin/
// entry path rather than only at the exact /admin/dashboard.html URL.
app.use("/admin", express.static(path.join(__dirname, "../../admin"), { maxAge: "1h", index: "dashboard.html" }));

// ---- Public site: assets served explicitly first (never caught by the
// SSR page router's routes), then SSR pages, then a catch-all static
// mount for anything else (og image, favicon, etc.) ----
app.use("/css", express.static(path.join(__dirname, "../../public-site/css"), { maxAge: "1d" }));
app.use("/js", express.static(path.join(__dirname, "../../public-site/js"), { maxAge: "1d" }));

app.use("/", pagesRouter);
app.use(
  "/",
  express.static(path.join(__dirname, "../../public-site"), { maxAge: "1d", index: false })
);

app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.status(404).send(render404Page());
});

app.use(errorHandler);

startAnalyticsFlusher();

app.listen(config.port, () => {
  console.log(`AyurNova running on ${config.site.baseUrl}`);
  console.log(`Admin panel:  ${config.site.baseUrl}/admin`);
  console.log(`Public site:  ${config.site.baseUrl}/`);
});
