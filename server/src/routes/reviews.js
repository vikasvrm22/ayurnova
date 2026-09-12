import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";

const router = Router();

/** Recomputes a product's avg_rating/review_count from its APPROVED reviews.
 * Called whenever a review's status changes. Exported so public.js can
 * reuse it if a review is ever auto-approved. */
export async function recomputeProductRating(productId) {
  const { data: approved } = await supabaseAdmin().from("reviews").select("rating").eq("product_id", productId).eq("status", "approved");
  const count = (approved || []).length;
  const avg = count ? approved.reduce((sum, r) => sum + r.rating, 0) / count : 0;
  await supabaseAdmin().from("products").update({
    avg_rating: Math.round(avg * 10) / 10, review_count: count,
  }).eq("id", productId);
}

router.get("/", requireStaffAuth, requirePermission("moderateReviews"), async (req, res, next) => {
  try {
    const { status, page = 1, pageSize = 20 } = req.query;
    let query = supabaseAdmin().from("reviews").select("*, products(title)", { count: "exact" }).order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    const p = Math.max(1, Number(page)), ps = Math.max(1, Number(pageSize));
    query = query.range((p - 1) * ps, p * ps - 1);
    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ items: data, total: count });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/approve", requireStaffAuth, requirePermission("moderateReviews"), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin().from("reviews").update({ status: "approved" }).eq("id", req.params.id).select().single();
    if (error) throw error;
    await recomputeProductRating(data.product_id);
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/reject", requireStaffAuth, requirePermission("moderateReviews"), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin().from("reviews").update({ status: "rejected" }).eq("id", req.params.id).select().single();
    if (error) throw error;
    await recomputeProductRating(data.product_id);
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

export default router;
