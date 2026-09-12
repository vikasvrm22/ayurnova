/**
 * Public, platform-neutral JSON catalog API - Phase 1 (Phase 0 §6: the
 * single biggest Android-readiness gap was that no such API existed at
 * all; the catalog was only reachable as server-rendered HTML). This is
 * mounted at /api/public alongside the existing server/src/routes/public.js
 * (checkout, reviews, bookings, etc.), which is left untouched.
 *
 * Every response uses the same envelope:
 *   success -> { success: true, data: {...}, meta?: {...} }
 *   failure -> { success: false, error: { code, message } }
 * via server/src/utils/apiResponse.js. This is a deliberately NEW,
 * different shape from the rest of the app's `{item}`/`{items,total}`/
 * `{error}` responses - those stay as-is (existing admin/public-site pages
 * already depend on that exact shape; changing it would be a breaking,
 * unjustified rewrite). New clients (a future Android app, this API's own
 * test suite) only ever need to know this one contract.
 */
import { Router } from "express";
import {
  listPublishedProducts,
  getPublishedProductBySlug,
  listCategories,
  PRODUCT_SORT_MAP,
} from "../services/catalogService.js";
import { parsePagination, isValidSlug } from "../validation/validators.js";
import { AppError, sendOk, asyncRoute, catalogErrorHandler } from "../utils/apiResponse.js";

const router = Router();

const MAX_PAGE_SIZE = 50; // a mobile client on a normal connection should never need more per request

function toCard(row) {
  const variant = row.product_variants?.[0];
  const image = row.product_images?.[0]?.url || null;
  const bullets = (row.short_description || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    brand: row.brand || null,
    image,
    shortDescriptionBullets: bullets,
    avgRating: row.avg_rating,
    reviewCount: row.review_count,
    price: variant ? Number(variant.price) : null,
    mrp: variant && variant.mrp ? Number(variant.mrp) : null,
    inStock: (row.product_variants || []).some((v) => v.stock > 0),
  };
}

function toDetail(row) {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    brand: row.brand || null,
    category: row.category ? { id: row.category.id, name: row.category.name, slug: row.category.slug, type: row.category.type } : null,
    shortDescriptionBullets: (row.short_description || "").split("\n").map((l) => l.trim()).filter(Boolean),
    description: row.description || "",
    ingredients: row.ingredients || "",
    howToUse: row.how_to_use || "",
    seoTitle: row.seo_title || null,
    seoDescription: row.seo_description || null,
    avgRating: row.avg_rating,
    reviewCount: row.review_count,
    images: (row.product_images || []).map((i) => ({ url: i.url, sortOrder: i.sort_order })),
    variants: (row.product_variants || []).map((v) => ({
      id: v.id,
      label: v.label,
      sku: v.sku || null,
      price: Number(v.price),
      mrp: v.mrp ? Number(v.mrp) : null,
      stock: v.stock,
      weightGrams: v.weight_grams || null,
    })),
    reviews: (row.reviews || []).map((r) => ({
      id: r.id,
      customerName: r.customer_name,
      rating: r.rating,
      title: r.title || null,
      body: r.body || null,
      createdAt: r.created_at,
    })),
  };
}

const DEFAULT_SORT = "newest";

function parseListQuery(query) {
  const { page, pageSize } = parsePagination(query, { defaultPageSize: 12, maxPageSize: MAX_PAGE_SIZE });

  let sort = DEFAULT_SORT;
  if (query.sort !== undefined) {
    if (typeof query.sort !== "string" || !Object.prototype.hasOwnProperty.call(PRODUCT_SORT_MAP, query.sort)) {
      throw new AppError(`Invalid sort value. Must be one of: ${Object.keys(PRODUCT_SORT_MAP).join(", ")}`, 400, "INVALID_SORT");
    }
    sort = query.sort;
  }

  for (const key of ["category", "concern", "benefit"]) {
    if (query[key] !== undefined && !isValidSlug(query[key])) {
      throw new AppError(`Invalid ${key}: must be a valid slug`, 400, "INVALID_SLUG");
    }
  }

  let inStock;
  if (query.in_stock !== undefined) {
    if (query.in_stock !== "true" && query.in_stock !== "false") {
      throw new AppError("Invalid in_stock: must be 'true' or 'false'", 400, "INVALID_PARAM");
    }
    inStock = query.in_stock === "true";
  }

  return {
    page,
    pageSize,
    sort,
    categorySlug: query.category,
    concern: query.concern,
    benefit: query.benefit,
    q: typeof query.q === "string" ? query.q.slice(0, 100) : undefined,
    inStock,
  };
}

function buildMeta(page, pageSize, total) {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

// ---- GET /api/public/products ----
router.get(
  "/products",
  asyncRoute(async (req, res) => {
    const opts = parseListQuery(req.query);
    const { items, total } = await listPublishedProducts(opts);
    sendOk(res, { items: items.map(toCard) }, buildMeta(opts.page, opts.pageSize, total));
  })
);

// ---- GET /api/public/search (same contract as /products, `q` required) ----
router.get(
  "/search",
  asyncRoute(async (req, res) => {
    if (!req.query.q || !String(req.query.q).trim()) {
      throw new AppError("Query parameter 'q' is required", 400, "MISSING_QUERY");
    }
    const opts = parseListQuery(req.query);
    const { items, total } = await listPublishedProducts(opts);
    sendOk(res, { items: items.map(toCard), query: opts.q }, buildMeta(opts.page, opts.pageSize, total));
  })
);

// ---- GET /api/public/products/:slug ----
router.get(
  "/products/:slug",
  asyncRoute(async (req, res) => {
    if (!isValidSlug(req.params.slug)) {
      throw new AppError("Product not found", 404, "PRODUCT_NOT_FOUND");
    }
    const product = await getPublishedProductBySlug(req.params.slug);
    if (!product) throw new AppError("Product not found", 404, "PRODUCT_NOT_FOUND");
    sendOk(res, toDetail(product));
  })
);

// ---- GET /api/public/categories ----
router.get(
  "/categories",
  asyncRoute(async (req, res) => {
    const { type } = req.query;
    if (type !== undefined && !["concern", "benefit", "product_type"].includes(type)) {
      throw new AppError("Invalid type: must be concern, benefit, or product_type", 400, "INVALID_PARAM");
    }
    const items = await listCategories({ type });
    sendOk(res, { items: items.map((c) => ({ id: c.id, name: c.name, slug: c.slug, type: c.type })) });
  })
);

router.use(catalogErrorHandler);

export default router;
