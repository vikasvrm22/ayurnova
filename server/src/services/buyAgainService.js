/**
 * Phase 8D - "Buy Again": which products has this customer genuinely
 * received before, deduplicated to one entry per product, hydrated with
 * CURRENT (never historical) price/MRP/stock/availability. No parallel
 * commerce architecture - reuses catalogService.getProductsByIds() (the
 * same bulk-hydration function Phase 8C's wishlist already uses) and the
 * client-side cart (js/site.js's addToCart()) for the actual reorder
 * action; this module only answers "what can this customer buy again".
 *
 * Eligibility: an order counts as a genuine past purchase only once it has
 * actually shipped - `pending`/`processing` haven't happened yet, and
 * `cancelled`/`rto` are explicitly NOT a completed purchase (locked scope:
 * "Prevent cancelled/invalid orders from being treated as successful
 * purchases"). Both `shipped` and `delivered` count, so a Buy Again
 * suggestion doesn't disappear the moment an order is marked shipped and
 * only reappear once delivered.
 */
import { supabaseAdmin } from "../db/supabaseClient.js";
import { getProductsByIds } from "./catalogService.js";

export const ELIGIBLE_ORDER_STATUSES = ["shipped", "delivered"];

/** Customer-safe product card shape - same fields Phase 8C's wishlist
 * exposes (id/title/slug/image/rating/price/mrp/inStock/defaultVariantId),
 * so both features can share one card renderer client-side if desired. */
function toBuyAgainCard(row) {
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

/**
 * Returns { items, total } for one page of this customer's distinct
 * previously-purchased products, most-recently-purchased first. Never
 * throws for "no purchases yet" - that's just an empty page, not an error.
 */
export async function getBuyAgainItems({ customerId, page, pageSize }) {
  const { data: eligibleOrders, error: ordersError } = await supabaseAdmin()
    .from("orders")
    .select("id, created_at")
    .eq("customer_id", customerId)
    .in("status", ELIGIBLE_ORDER_STATUSES)
    .order("created_at", { ascending: false });
  if (ordersError) throw ordersError;
  if (!eligibleOrders?.length) return { items: [], total: 0 };

  const orderIds = eligibleOrders.map((o) => o.id);
  const orderCreatedAt = Object.fromEntries(eligibleOrders.map((o) => [o.id, o.created_at]));

  const { data: orderItems, error: itemsError } = await supabaseAdmin()
    .from("order_items")
    .select("product_id, title_snapshot, order_id")
    .in("order_id", orderIds);
  if (itemsError) throw itemsError;

  // Dedupe to one entry per product, keeping the most recent purchase.
  // `orderCreatedAt` is already only populated for eligible orders (never
  // pending/processing/cancelled/rto), so this loop can never let an
  // ineligible order's item through. A hard-deleted product's order_items
  // row has product_id = null (on delete set null) - those are deduped by
  // their frozen title_snapshot instead, since there's no product id left
  // to key on, but they still deserve to appear (as permanently
  // unavailable) rather than silently vanish from the customer's history.
  const byKey = new Map();
  for (const item of orderItems || []) {
    const purchasedAt = orderCreatedAt[item.order_id];
    if (!purchasedAt) continue;
    const key = item.product_id || `deleted:${item.title_snapshot}`;
    const existing = byKey.get(key);
    if (!existing || purchasedAt > existing.purchasedAt) {
      byKey.set(key, { productId: item.product_id, titleSnapshot: item.title_snapshot, purchasedAt });
    }
  }

  const deduped = [...byKey.values()].sort((a, b) => (a.purchasedAt < b.purchasedAt ? 1 : -1));
  const total = deduped.length;
  const pageSlice = deduped.slice((page - 1) * pageSize, page * pageSize);

  const productIds = pageSlice.map((i) => i.productId).filter(Boolean);
  const products = productIds.length ? await getProductsByIds(productIds) : [];
  const productById = Object.fromEntries(products.map((p) => [p.id, p]));

  const items = pageSlice.map((i) => {
    const product = i.productId ? productById[i.productId] : null;
    return {
      productId: i.productId || null,
      title: product ? product.title : i.titleSnapshot,
      lastPurchasedAt: i.purchasedAt,
      available: !!product,
      product: product ? toBuyAgainCard(product) : null,
    };
  });

  return { items, total };
}
