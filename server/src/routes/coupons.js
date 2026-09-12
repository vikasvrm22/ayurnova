import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { validateCouponCode } from "../validation/validators.js";

const router = Router();

router.get("/", requireStaffAuth, requirePermission("manageCoupons"), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin().from("coupons").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    next(e);
  }
});

router.post("/", requireStaffAuth, requirePermission("manageCoupons"), async (req, res, next) => {
  try {
    const { code, discount_type, discount_value, min_order_value, valid_from, valid_until, usage_limit } = req.body || {};
    if (!validateCouponCode(code) || !["percent", "flat"].includes(discount_type) || !discount_value) {
      return res.status(400).json({ error: "Valid code, discount_type (percent/flat) and discount_value required" });
    }
    const { data, error } = await supabaseAdmin().from("coupons").insert({
      code: code.toUpperCase().trim(), discount_type, discount_value, min_order_value: min_order_value || 0,
      valid_from: valid_from || null, valid_until: valid_until || null, usage_limit: usage_limit || null,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.put("/:id", requireStaffAuth, requirePermission("manageCoupons"), async (req, res, next) => {
  try {
    const { active, discount_value, min_order_value, valid_until, usage_limit } = req.body || {};
    const patch = {};
    if (active !== undefined) patch.active = active;
    if (discount_value !== undefined) patch.discount_value = discount_value;
    if (min_order_value !== undefined) patch.min_order_value = min_order_value;
    if (valid_until !== undefined) patch.valid_until = valid_until;
    if (usage_limit !== undefined) patch.usage_limit = usage_limit;
    const { data, error } = await supabaseAdmin().from("coupons").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireStaffAuth, requirePermission("manageCoupons"), async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin().from("coupons").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

/** Shared by the public checkout route - validates a coupon against an
 * order subtotal and returns the discount amount, or an error message. */
export async function computeCouponDiscount(code, subtotal) {
  if (!code) return { discount: 0 };
  const { data: coupon } = await supabaseAdmin().from("coupons").select("*").eq("code", code.toUpperCase().trim()).maybeSingle();
  if (!coupon || !coupon.active) return { error: "Invalid or inactive coupon code" };
  const now = new Date();
  if (coupon.valid_from && new Date(coupon.valid_from) > now) return { error: "This coupon is not active yet" };
  if (coupon.valid_until && new Date(coupon.valid_until) < now) return { error: "This coupon has expired" };
  if (coupon.usage_limit && coupon.used_count >= coupon.usage_limit) return { error: "This coupon has reached its usage limit" };
  if (subtotal < Number(coupon.min_order_value || 0)) {
    return { error: `Minimum order value for this coupon is ₹${coupon.min_order_value}` };
  }
  const discount = coupon.discount_type === "percent"
    ? Math.round((subtotal * Number(coupon.discount_value)) / 100)
    : Number(coupon.discount_value);
  return { discount: Math.min(discount, subtotal), coupon };
}

export default router;
