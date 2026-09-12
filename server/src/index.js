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
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", config.supabase.url || "https://*.supabase.co"].filter(Boolean),
      },
    },
  })
);

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: "2mb" }));

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

// ---- Public API (storefront AJAX: checkout, reviews, bookings, coupons) ----
app.use("/api/public", publicRoutes);

app.get("/api/meta/schema", (req, res) => {
  res.json({ roles: ROLES, rolePermissions: ROLE_PERMISSIONS, productFields: PRODUCT_FIELDS });
});
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---- Admin panel (static SPA) ----
app.use("/admin", express.static(path.join(__dirname, "../../admin"), { maxAge: "1h" }));

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
  console.log(`AyurVeda Store running on ${config.site.baseUrl}`);
  console.log(`Admin panel:  ${config.site.baseUrl}/admin`);
  console.log(`Public site:  ${config.site.baseUrl}/`);
});
