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
import { supabaseAdmin } from "../db/supabaseClient.js";
import {
  listPublishedProducts,
  getPublishedProductBySlug,
  listCategories,
  getCategoryBySlug,
  getIngredientBySlug,
  searchCatalog,
  compareProducts,
  MAX_COMPARE_PRODUCTS,
  PRODUCT_SORT_MAP,
} from "../services/catalogService.js";
import { parsePagination, isValidSlug, isValidUUID } from "../validation/validators.js";
import { AppError, sendOk, asyncRoute, catalogErrorHandler } from "../utils/apiResponse.js";

const router = Router();

const MAX_PAGE_SIZE = 50; // a mobile client on a normal connection should never need more per request

/** Maps a structured-entity row (ingredient or concern/benefit/goal
 * category) to its public card shape - just enough to link to its landing
 * page (`/ingredient/:slug`, `/concern/:slug`, etc.) from a product's
 * detail response or a listing. */
function toTagCard(row) {
  return { id: row.id, name: row.name, slug: row.slug };
}

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
    // Phase 3A: structured discovery tags (distinct from the free-text
    // `ingredients` field above, which is left exactly as it was) and this
    // product's own FAQs. `relatedIngredients` is named to avoid any
    // ambiguity with the pre-existing `ingredients` string field.
    relatedIngredients: (row.relatedIngredients || []).map(toTagCard),
    concerns: (row.concerns || []).map(toTagCard),
    benefits: (row.benefits || []).map(toTagCard),
    goals: (row.goals || []).map(toTagCard),
    faqs: (row.faqs || []).map((f) => ({ id: f.id, question: f.question, answer: f.answer })),
  };
}

function toCompareCard(row) {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    image: row.product_images?.[0]?.url || null,
    avgRating: row.avg_rating,
    reviewCount: row.review_count,
    variants: (row.product_variants || []).map((v) => ({
      id: v.id, label: v.label, price: Number(v.price), mrp: v.mrp ? Number(v.mrp) : null,
      stock: v.stock, weightGrams: v.weight_grams || null,
    })),
    relatedIngredients: (row.relatedIngredients || []).map(toTagCard),
    concerns: (row.concerns || []).map(toTagCard),
    benefits: (row.benefits || []).map(toTagCard),
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

  for (const key of ["category", "concern", "benefit", "goal", "ingredient"]) {
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
    // Phase 3A: all four can be combined (AND) in one request - see
    // catalogService.js's RELATION_FILTERS / listPublishedProducts.
    concern: query.concern,
    benefit: query.benefit,
    goal: query.goal,
    ingredient: query.ingredient,
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

// ---- GET /api/public/search (`q` required) ----
// Unlike /products?q= (title only, unchanged - see catalogService.js's
// listPublishedProducts), this also matches structured Ingredients/
// Concerns/Benefits/Goals by name and returns the products tagged with
// whichever ones matched (searchCatalog) - the search box's placeholder
// text ("Search products, concerns, ingredients...") is now actually true.
router.get(
  "/search",
  asyncRoute(async (req, res) => {
    if (!req.query.q || !String(req.query.q).trim()) {
      throw new AppError("Query parameter 'q' is required", 400, "MISSING_QUERY");
    }
    const opts = parseListQuery(req.query);
    const { items, total } = await searchCatalog(opts);
    sendOk(res, { items: items.map(toCard), query: opts.q }, buildMeta(opts.page, opts.pageSize, total));
  })
);

// ---- GET /api/public/products/compare?ids=a,b,c ----
// Registered BEFORE /products/:slug so "compare" is never matched as a slug.
router.get(
  "/products/compare",
  asyncRoute(async (req, res) => {
    const raw = typeof req.query.ids === "string" ? req.query.ids.split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (!raw.length) throw new AppError("Query parameter 'ids' is required (comma-separated product ids)", 400, "MISSING_IDS");
    const invalid = raw.filter((id) => !isValidUUID(id));
    if (invalid.length) throw new AppError("Invalid product id in 'ids'", 400, "INVALID_ID");
    if (raw.length > MAX_COMPARE_PRODUCTS) {
      throw new AppError(`At most ${MAX_COMPARE_PRODUCTS} products can be compared at once`, 400, "TOO_MANY_IDS");
    }
    const items = await compareProducts(raw);
    sendOk(res, { items: items.map(toCompareCard) });
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

const CATEGORY_TYPES = ["concern", "benefit", "product_type", "goal"];

function toCategoryCard(c) {
  return {
    id: c.id, name: c.name, slug: c.slug, type: c.type,
    description: c.description || null, heroImage: c.hero_image || null,
  };
}

// ---- GET /api/public/categories ----
router.get(
  "/categories",
  asyncRoute(async (req, res) => {
    const { type } = req.query;
    if (type !== undefined && !CATEGORY_TYPES.includes(type)) {
      throw new AppError(`Invalid type: must be one of ${CATEGORY_TYPES.join(", ")}`, 400, "INVALID_PARAM");
    }
    const items = await listCategories({ type });
    sendOk(res, { items: items.map(toCategoryCard) });
  })
);

// ---- GET /api/public/categories/:slug ----
// A concern/benefit/goal/product_type landing page: the category's own
// content fields (Phase 3A) plus the published products tagged with it -
// fixes the Phase 0 §10/§13 "mega-menu links all dead-end to /shop with no
// distinct landing page" gap for real, now that categories carry content.
router.get(
  "/categories/:slug",
  asyncRoute(async (req, res) => {
    if (!isValidSlug(req.params.slug)) throw new AppError("Category not found", 404, "CATEGORY_NOT_FOUND");
    const category = await getCategoryBySlug(req.params.slug);
    if (!category) throw new AppError("Category not found", 404, "CATEGORY_NOT_FOUND");

    const opts = parseListQuery(req.query);
    const filterKey = category.type === "product_type" ? "categorySlug" : category.type;
    const { items, total } = await listPublishedProducts({ ...opts, [filterKey]: category.slug });

    sendOk(res, { category: toCategoryCard(category), products: items.map(toCard) }, buildMeta(opts.page, opts.pageSize, total));
  })
);

// ---- GET /api/public/ingredients ----
router.get(
  "/ingredients",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabaseAdmin().from("ingredients").select("id, name, slug, description").order("name");
    if (error) throw error;
    sendOk(res, { items: (data || []).map((i) => ({ id: i.id, name: i.name, slug: i.slug, description: i.description || null })) });
  })
);

// ---- GET /api/public/ingredients/:slug ----
router.get(
  "/ingredients/:slug",
  asyncRoute(async (req, res) => {
    if (!isValidSlug(req.params.slug)) throw new AppError("Ingredient not found", 404, "INGREDIENT_NOT_FOUND");
    const ingredient = await getIngredientBySlug(req.params.slug);
    if (!ingredient) throw new AppError("Ingredient not found", 404, "INGREDIENT_NOT_FOUND");

    const opts = parseListQuery(req.query);
    const { items, total } = await listPublishedProducts({ ...opts, ingredient: ingredient.slug });
    sendOk(
      res,
      { ingredient: { id: ingredient.id, name: ingredient.name, slug: ingredient.slug, description: ingredient.description || null }, products: items.map(toCard) },
      buildMeta(opts.page, opts.pageSize, total)
    );
  })
);

// ---- GET /api/public/faqs (global site FAQs - product_id is null) ----
router.get(
  "/faqs",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabaseAdmin()
      .from("faqs").select("id, question, answer, sort_order").is("product_id", null).order("sort_order");
    if (error) throw error;
    sendOk(res, { items: (data || []).map((f) => ({ id: f.id, question: f.question, answer: f.answer })) });
  })
);

router.use(catalogErrorHandler);

export default router;
