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

/** Same contract as resolveCategoryId, for the separate `ingredients` table
 * (Phase 3A - not a `categories` row, since ingredients aren't a taxonomy
 * "type", they're their own structured entity). */
async function resolveIngredientId(slug) {
  if (!slug) return undefined;
  const { data } = await supabaseAdmin().from("ingredients").select("id").eq("slug", slug).maybeSingle();
  return data?.id ?? null;
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
// Phase 3A: one join table per discovery dimension (product_type stays the
// single `products.category_id` FK - see the Phase 3 decisions doc, decision
// #1 - concern/benefit/goal/ingredient are genuinely multi-valued so they
// live in their own many-to-many tables instead). Unlike the old
// `categorySlug`/`concern`/`benefit` exclusive if/else, these four can now
// all be supplied at once and are AND-combined (a product must match every
// filter given, not any) - each becomes one `!inner` embedded-table filter,
// same PostgREST idiom already used for the existing `inStock` filter below.
const RELATION_FILTERS = [
  { param: "concern", table: "product_concerns", column: "concern_id", categoryType: "concern" },
  { param: "benefit", table: "product_benefits", column: "benefit_id", categoryType: "benefit" },
  { param: "goal", table: "product_goals", column: "goal_id", categoryType: "goal" },
  { param: "ingredient", table: "product_ingredients", column: "ingredient_id", resolver: resolveIngredientId },
];

export async function listPublishedProducts({
  page = 1,
  pageSize = 12,
  categorySlug,
  concern,
  benefit,
  goal,
  ingredient,
  sort = DEFAULT_PRODUCT_SORT,
  q,
  inStock,
} = {}) {
  const categoryId = categorySlug ? await resolveCategoryId(categorySlug) : undefined;
  if (categoryId === null) return { items: [], total: 0 }; // filter named a category that doesn't exist

  const inputs = { concern, benefit, goal, ingredient };
  const activeFilters = [];
  for (const filter of RELATION_FILTERS) {
    const slug = inputs[filter.param];
    if (!slug) continue;
    const id = filter.resolver ? await filter.resolver(slug) : await resolveCategoryId(slug, filter.categoryType);
    if (id === null) return { items: [], total: 0 }; // filter named a concern/benefit/goal/ingredient that doesn't exist
    activeFilters.push({ ...filter, id });
  }

  let columns = LIST_COLUMNS;
  if (inStock) columns = columns.replace("product_variants(", "product_variants!inner(");
  for (const f of activeFilters) columns += `, ${f.table}!inner(${f.column})`;

  let query = supabaseAdmin().from("products").select(columns, { count: "exact" }).eq("status", "published");
  if (categoryId) query = query.eq("category_id", categoryId);
  if (q) query = query.ilike("title", `%${sanitizeSearchTerm(q)}%`);
  if (inStock) query = query.gt("product_variants.stock", 0);
  for (const f of activeFilters) query = query.eq(`${f.table}.${f.column}`, f.id);

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

  // Phase 3A: this product's discovery tags + its own FAQs, for the public
  // detail response (catalogPublic.js's toDetail()) and the product page.
  const relatedIngredients = await listRelatedEntities("product_ingredients", "ingredient_id", "ingredients", product.id);
  const concerns = await listRelatedEntities("product_concerns", "concern_id", "categories", product.id);
  const benefits = await listRelatedEntities("product_benefits", "benefit_id", "categories", product.id);
  const goals = await listRelatedEntities("product_goals", "goal_id", "categories", product.id);
  const { data: faqs } = await supabaseAdmin()
    .from("faqs").select("id, question, answer, sort_order").eq("product_id", product.id).order("sort_order");

  return {
    ...product, product_images: images, product_variants: variants, category, reviews: reviews || [],
    relatedIngredients, concerns, benefits, goals, faqs: faqs || [],
  };
}

/** Fetches the "other side" of a product's many-to-many join table as full
 * rows (not just ids) - e.g. `listRelatedEntities("product_concerns",
 * "concern_id", "categories", productId)` returns the actual concern
 * category rows a product is tagged with. Two queries (join table, then the
 * related table) rather than a PostgREST embed, since the join tables here
 * have no FK PostgREST can auto-detect a reverse embed shorthand for beyond
 * what's already used in listPublishedProducts' forward `!inner` filters. */
export async function listRelatedEntities(joinTable, joinColumn, entityTable, productId) {
  const { data: links } = await supabaseAdmin().from(joinTable).select(joinColumn).eq("product_id", productId);
  const ids = (links || []).map((l) => l[joinColumn]);
  if (!ids.length) return [];
  const { data } = await supabaseAdmin().from(entityTable).select("id, name, slug").in("id", ids);
  return data || [];
}

const CATEGORY_TYPES = ["concern", "benefit", "product_type", "goal"];
const CATEGORY_PUBLIC_COLUMNS = "id, name, slug, type, sort_order, description, hero_image, seo_title, seo_description";

/** Lists categories for public consumption (nav menus, shop filters,
 * mega-menu). */
export async function listCategories({ type } = {}) {
  let query = supabaseAdmin().from("categories").select(CATEGORY_PUBLIC_COLUMNS).order("sort_order", { ascending: true });
  if (type && CATEGORY_TYPES.includes(type)) query = query.eq("type", type);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/** One category by slug, for a concern/benefit/goal landing page - content
 * fields included (Phase 3A) so the page can show more than just a filtered
 * grid. Returns null for an unknown slug (caller sends 404), matching
 * getPublishedProductBySlug's convention. */
export async function getCategoryBySlug(slug) {
  const { data } = await supabaseAdmin().from("categories").select(CATEGORY_PUBLIC_COLUMNS).eq("slug", slug).maybeSingle();
  return data || null;
}

/** One ingredient by slug, for an ingredient landing page. */
export async function getIngredientBySlug(slug) {
  const { data } = await supabaseAdmin().from("ingredients").select("id, name, slug, description").eq("slug", slug).maybeSingle();
  return data || null;
}

/**
 * Deterministic, ILIKE-only search across products PLUS the structured
 * discovery entities (Ingredients/Concerns/Benefits/Goals) - the "products,
 * concerns, ingredients..." the storefront's search box has always
 * (previously falsely) promised. No ranking model, no AI - a product
 * matches if its own title matches, OR it's tagged with an
 * ingredient/concern/benefit/goal whose name matches. The two match sources
 * are combined into one id set before a single paginated fetch, so a
 * product that matches on both a title word and a tag is never duplicated.
 */
export async function searchCatalog({ q, page = 1, pageSize = 12, sort = DEFAULT_PRODUCT_SORT }) {
  const term = sanitizeSearchTerm(q);
  if (!term) return { items: [], total: 0 };

  const { data: titleMatches } = await supabaseAdmin()
    .from("products").select("id").eq("status", "published").ilike("title", `%${term}%`);
  const idSet = new Set((titleMatches || []).map((p) => p.id));

  const { data: matchedIngredients } = await supabaseAdmin().from("ingredients").select("id").ilike("name", `%${term}%`);
  const { data: matchedCategories } = await supabaseAdmin()
    .from("categories").select("id").in("type", ["concern", "benefit", "goal"]).ilike("name", `%${term}%`);

  const tagLookups = [
    { table: "product_ingredients", column: "ingredient_id", ids: (matchedIngredients || []).map((r) => r.id) },
    { table: "product_concerns", column: "concern_id", ids: (matchedCategories || []).map((r) => r.id) },
    { table: "product_benefits", column: "benefit_id", ids: (matchedCategories || []).map((r) => r.id) },
    { table: "product_goals", column: "goal_id", ids: (matchedCategories || []).map((r) => r.id) },
  ];
  for (const lookup of tagLookups) {
    if (!lookup.ids.length) continue;
    const { data: rows } = await supabaseAdmin().from(lookup.table).select("product_id").in(lookup.column, lookup.ids);
    for (const r of rows || []) idSet.add(r.product_id);
  }

  if (!idSet.size) return { items: [], total: 0 };

  const { field, ascending } = PRODUCT_SORT_MAP[sort] || PRODUCT_SORT_MAP[DEFAULT_PRODUCT_SORT];
  const { data, error, count } = await supabaseAdmin()
    .from("products")
    .select(LIST_COLUMNS, { count: "exact" })
    .eq("status", "published")
    .in("id", [...idSet])
    .order(field, { ascending })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw error;
  return { items: data || [], total: count || 0 };
}

// Cross-product comparison is bounded to a small, fixed count - a
// comparison table wider than this stops being useful to a shopper and
// starts being an unbounded-response-size vector, same reasoning as the
// public list endpoints' MAX_PAGE_SIZE (catalogPublic.js).
export const MAX_COMPARE_PRODUCTS = 4;

/**
 * Fetches the comparable-attribute set for a fixed list of published
 * product ids (Phase 3 decision #4: price/MRP/pack size/stock/rating/
 * review count, plus structured ingredients/concerns/benefits/goals once
 * Phase 3A's tables have data). Single-brand only by construction - there
 * is no seller/vendor field anywhere in this schema to compare across, so
 * "cross-product" here always means within this store's own catalog.
 * Silently drops any id that doesn't resolve to a published product rather
 * than erroring, so a stale/typo'd id in a shared comparison link degrades
 * gracefully instead of failing the whole comparison.
 */
export async function compareProducts(ids) {
  const uniqueIds = [...new Set(ids)].slice(0, MAX_COMPARE_PRODUCTS);
  if (!uniqueIds.length) return [];

  const { data: products } = await supabaseAdmin()
    .from("products")
    .select(DETAIL_COLUMNS)
    .in("id", uniqueIds)
    .eq("status", "published");

  const results = [];
  for (const product of products || []) {
    const relatedIngredients = await listRelatedEntities("product_ingredients", "ingredient_id", "ingredients", product.id);
    const concerns = await listRelatedEntities("product_concerns", "concern_id", "categories", product.id);
    const benefits = await listRelatedEntities("product_benefits", "benefit_id", "categories", product.id);
    const variants = [...(product.product_variants || [])].sort((a, b) => a.sort_order - b.sort_order);
    results.push({ ...product, product_variants: variants, relatedIngredients, concerns, benefits });
  }
  // Preserve the order the caller asked for (e.g. `?ids=b,a` -> b before a),
  // not whatever order the DB happened to return them in.
  return uniqueIds.map((id) => results.find((p) => p.id === id)).filter(Boolean);
}
