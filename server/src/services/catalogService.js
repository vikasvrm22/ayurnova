/**
 * Single source of truth for "what can a shopper browse" queries -
 * published products, their variants/images, and categories.
 *
 * Phase 0 (§6, Android Readiness) found this logic duplicated only inside
 * server/src/routes/pages.js's SSR rendering, with no JSON API a non-browser
 * client could call. Phase 1 moves the actual queries here so that:
 *   - server/src/routes/catalogPublic.js (new public JSON API) and
 *   - server/src/routes/pages.js (existing SSR homepage/shop/product pages)
 * both call the exact same functions and therefore can never disagree on
 * what "published", "in stock", "sorted by X" etc. mean. A future Android
 * client consumes catalogPublic.js's routes, which call the same code the
 * website already relies on - no parallel business logic to keep in sync.
 *
 * Raw Supabase rows (with nested `product_variants`/`product_images`
 * arrays) are returned as-is from the list/detail functions below, because
 * server/src/routes/pages.js's existing HTML-rendering helpers
 * (`productCardHtml`, etc.) already expect exactly that shape. JSON-shaping
 * for the public API lives in catalogPublic.js, not here - this module only
 * answers "what matches the query", not "how should it be formatted".
 */
import { supabaseAdmin } from "../db/supabaseClient.js";
import { sanitizeSearchTerm } from "../validation/validators.js";

// Public sort keys -> DB column + direction. This is the ONLY set of sort
// values that can ever reach `.order()` - see Phase 0 §13 (unvalidated sort
// field passed straight to the DB) for why a whitelist, not a passthrough.
// Sorting by price is intentionally NOT offered yet: price lives on
// `product_variants` (one-to-many per product), and PostgREST cannot order
// a parent row by a child table's column without a dedicated view/RPC -
// adding one is unjustified schema work for Phase 1 (documented as a
// deferred item in the Phase 1 report rather than implemented here).
export const PRODUCT_SORT_MAP = {
  newest: { field: "created_at", ascending: false },
  oldest: { field: "created_at", ascending: true },
  rating: { field: "avg_rating", ascending: false },
  bestselling: { field: "review_count", ascending: false },
};
export const DEFAULT_PRODUCT_SORT = "newest";

const LIST_COLUMNS =
  "id, title, slug, brand, short_description, avg_rating, review_count, created_at, " +
  "product_variants(id, label, sku, price, mrp, stock, sort_order), " +
  "product_images(url, sort_order)";

const DETAIL_COLUMNS =
  "id, title, slug, brand, category_id, short_description, description, ingredients, how_to_use, " +
  "seo_title, seo_description, avg_rating, review_count, created_at, updated_at, " +
  "product_variants(id, label, sku, price, mrp, stock, weight_grams, sort_order), " +
  "product_images(id, url, sort_order)";

/** Resolves a category slug to its id. `type` (if given) constrains the
 * lookup so `?concern=` can never accidentally match a `benefit` row with
 * the same slug, etc. Returns `undefined` (not an error) for an unknown
 * slug - callers treat that as "filter matches nothing" rather than 404,
 * matching the existing SSR shop page's behaviour. */
async function resolveCategoryId(slug, type) {
  if (!slug) return undefined;
  let query = supabaseAdmin().from("categories").select("id").eq("slug", slug);
  if (type) query = query.eq("type", type);
  const { data } = await query.maybeSingle();
  return data?.id ?? null; // null (not undefined) = "no such category" -> caller short-circuits to empty results
}

/**
 * Lists published products for the storefront/public API.
 *
 * @param {object} opts
 * @param {number} [opts.page=1]
 * @param {number} [opts.pageSize=12]
 * @param {string} [opts.categorySlug] - any category, regardless of type
 * @param {string} [opts.concern] - category slug, constrained to type='concern'
 * @param {string} [opts.benefit] - category slug, constrained to type='benefit'
 * @param {string} [opts.sort='newest'] - one of PRODUCT_SORT_MAP's keys
 * @param {string} [opts.q] - search term, matched against title
 * @param {boolean} [opts.inStock] - when true, only products with at least
 *   one in-stock variant. Implemented via a PostgREST inner-join filter
 *   (`product_variants!inner`), which as a side effect means the returned
 *   `product_variants` array for a matching product only includes its
 *   IN-STOCK variants, not every variant it has. That's fine for the public
 *   "does this show an Add to Cart button" use case this serves today; a
 *   page that also needs the full variant list (in/out of stock) alongside
 *   an availability filter would need a dedicated view - noted as a
 *   deferred item rather than built now.
 */
export async function listPublishedProducts({
  page = 1,
  pageSize = 12,
  categorySlug,
  concern,
  benefit,
  sort = DEFAULT_PRODUCT_SORT,
  q,
  inStock,
} = {}) {
  let categoryId;
  if (categorySlug) categoryId = await resolveCategoryId(categorySlug);
  else if (concern) categoryId = await resolveCategoryId(concern, "concern");
  else if (benefit) categoryId = await resolveCategoryId(benefit, "benefit");

  if (categoryId === null) return { items: [], total: 0 }; // filter named a category that doesn't exist

  const columns = inStock
    ? LIST_COLUMNS.replace("product_variants(", "product_variants!inner(")
    : LIST_COLUMNS;

  let query = supabaseAdmin().from("products").select(columns, { count: "exact" }).eq("status", "published");
  if (categoryId) query = query.eq("category_id", categoryId);
  if (q) query = query.ilike("title", `%${sanitizeSearchTerm(q)}%`);
  if (inStock) query = query.gt("product_variants.stock", 0);

  const { field, ascending } = PRODUCT_SORT_MAP[sort] || PRODUCT_SORT_MAP[DEFAULT_PRODUCT_SORT];
  query = query.order(field, { ascending }).range((page - 1) * pageSize, page * pageSize - 1);

  const { data, error, count } = await query;
  if (error) throw error;
  return { items: data || [], total: count || 0 };
}

/** Fetches one published product by slug, with its variants/images and its
 * 10 most recent approved reviews. Returns `null` if no published product
 * has that slug (caller decides how to respond - 404 page for SSR, 404 JSON
 * for the API). */
export async function getPublishedProductBySlug(slug) {
  const { data: product } = await supabaseAdmin()
    .from("products")
    .select(DETAIL_COLUMNS)
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle();
  if (!product) return null;

  let category = null;
  if (product.category_id) {
    const { data } = await supabaseAdmin().from("categories").select("id, name, slug, type").eq("id", product.category_id).maybeSingle();
    category = data || null;
  }

  const { data: reviews } = await supabaseAdmin()
    .from("reviews")
    .select("id, customer_name, rating, title, body, created_at")
    .eq("product_id", product.id)
    .eq("status", "approved")
    .order("created_at", { ascending: false })
    .limit(10);

  const images = [...(product.product_images || [])].sort((a, b) => a.sort_order - b.sort_order);
  const variants = [...(product.product_variants || [])].sort((a, b) => a.sort_order - b.sort_order);

  return { ...product, product_images: images, product_variants: variants, category, reviews: reviews || [] };
}

const CATEGORY_TYPES = ["concern", "benefit", "product_type"];

/** Lists categories for public consumption (nav menus, shop filters). */
export async function listCategories({ type } = {}) {
  let query = supabaseAdmin().from("categories").select("id, name, slug, type, sort_order").order("sort_order", { ascending: true });
  if (type && CATEGORY_TYPES.includes(type)) query = query.eq("type", type);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}
