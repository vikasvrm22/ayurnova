/**
 * Phase 8C - customer wishlist. Same shape as server/src/routes/
 * addressesPublic.js (Phase 6A): `requireCustomer`, every query filtered
 * by `.eq("customer_id", req.customer.id)` (never fetch-then-compare, so
 * a non-owned row 404s identically to a nonexistent one), {success,data}
 * envelope via sendOk/AppError/asyncRoute/catalogErrorHandler.
 *
 * Keyed by product_id (locked decision) - which pack size to buy is a
 * checkout-time choice, not something saved. `wishlist_items.product_id`
 * is `on delete cascade` (migration 0012), so a hard product delete can
 * never leave an orphaned row; a product that's merely unpublished still
 * has its row, but getProductsByIds() (catalogService.js) silently omits
 * it from hydration - toWishlistItem() below reports that as
 * `available: false` rather than erroring or hiding the row, so a
 * customer can still see (and remove) a saved item that's gone stale.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireCustomer } from "../auth/customerAuth.js";
import { AppError, sendOk, asyncRoute, catalogErrorHandler } from "../utils/apiResponse.js";
import { isValidUUID, parsePagination } from "../validation/validators.js";
import { getProductsByIds } from "../services/catalogService.js";

const router = Router();
router.use(requireCustomer);

/** Customer-safe product card shape - same fields catalogPublic.js's own
 * toCard() exposes (id/title/slug/brand/image/rating/price/mrp/inStock),
 * plus the first variant's id so the account page can offer a one-click
 * "Add to Cart" without making the customer pick a pack size again. */
function toWishlistCard(row) {
  const variant = row.product_variants?.[0];
  const image = row.product_images?.[0]?.url || null;
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    brand: row.brand || null,
    image,
    avgRating: row.avg_rating,
    reviewCount: row.review_count,
    defaultVariantId: variant ? variant.id : null,
    price: variant ? Number(variant.price) : null,
    mrp: variant && variant.mrp ? Number(variant.mrp) : null,
    inStock: (row.product_variants || []).some((v) => v.stock > 0),
  };
}

// ---- GET /api/public/wishlist ----
router.get(
  "/",
  asyncRoute(async (req, res) => {
    const { page, pageSize } = parsePagination(req.query, { defaultPageSize: 20, maxPageSize: 100 });

    const { data: rows, error, count } = await supabaseAdmin()
      .from("wishlist_items")
      .select("id, product_id, created_at", { count: "exact" })
      .eq("customer_id", req.customer.id)
      .order("created_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);
    if (error) throw error;

    const productIds = (rows || []).map((r) => r.product_id);
    const products = productIds.length ? await getProductsByIds(productIds) : [];
    const productById = Object.fromEntries(products.map((p) => [p.id, p]));

    const items = (rows || []).map((r) => {
      const product = productById[r.product_id];
      return {
        wishlistItemId: r.id,
        productId: r.product_id,
        addedAt: r.created_at,
        available: !!product,
        product: product ? toWishlistCard(product) : null,
      };
    });

    sendOk(res, { items }, { page, pageSize, total: count || 0, totalPages: Math.max(1, Math.ceil((count || 0) / pageSize)) });
  })
);

// ---- POST /api/public/wishlist  { product_id } ----
router.post(
  "/",
  asyncRoute(async (req, res) => {
    const { product_id } = req.body || {};
    if (!product_id || !isValidUUID(product_id)) throw new AppError("A valid product_id is required", 400, "INVALID_PRODUCT_ID");

    // Never trust the client's claim that a product id is real/public -
    // only a currently published product can be added.
    const { data: product } = await supabaseAdmin().from("products").select("id").eq("id", product_id).eq("status", "published").maybeSingle();
    if (!product) throw new AppError("Product not found", 404, "PRODUCT_NOT_FOUND");

    const { data, error } = await supabaseAdmin()
      .from("wishlist_items")
      .insert({ customer_id: req.customer.id, product_id })
      .select()
      .maybeSingle();
    if (error) {
      // unique(customer_id, product_id) - duplicate-safe add: already
      // wishlisted is a no-op success, not an error.
      if (error.code === "23505") {
        const { data: existing, error: existingError } = await supabaseAdmin()
          .from("wishlist_items").select("*").eq("customer_id", req.customer.id).eq("product_id", product_id).single();
        if (existingError) throw existingError;
        return sendOk(res, { item: existing, alreadyExists: true });
      }
      throw error;
    }
    sendOk(res, { item: data }, undefined, 201);
  })
);

// ---- DELETE /api/public/wishlist/:productId ----
router.delete(
  "/:productId",
  asyncRoute(async (req, res) => {
    if (!isValidUUID(req.params.productId)) throw new AppError("Invalid product id", 400, "INVALID_PRODUCT_ID");
    const { data, error } = await supabaseAdmin()
      .from("wishlist_items")
      .delete()
      .eq("customer_id", req.customer.id)
      .eq("product_id", req.params.productId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new AppError("Wishlist item not found", 404, "WISHLIST_ITEM_NOT_FOUND");
    sendOk(res, { success: true });
  })
);

router.use(catalogErrorHandler);

export default router;
