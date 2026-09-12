import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { parsePagination, sanitizeOrFilterValue } from "../validation/validators.js";

const router = Router();

const ORDER_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled"];

router.get("/", requireStaffAuth, async (req, res, next) => {
  try {
    const { q, status } = req.query;
    let query = supabaseAdmin().from("orders").select("*", { count: "exact" }).order("created_at", { ascending: false });
    if (status && ORDER_STATUSES.includes(status)) query = query.eq("status", status);

    // Phase 0 §7.3: `q` used to be interpolated directly into this PostgREST
    // `.or()` filter-expression string - a crafted value containing `,`/`.`/
    // `()` could alter which columns/conditions get evaluated. Fixed by
    // allowlisting `q` down to only the characters a real order number,
    // email, or phone number can contain before it ever reaches `.or()`.
    const safeQ = sanitizeOrFilterValue(q);
    if (safeQ) query = query.or(`order_number.ilike.%${safeQ}%,guest_email.ilike.%${safeQ}%,guest_phone.ilike.%${safeQ}%`);

    const { page: p, pageSize: ps } = parsePagination(req.query);
    query = query.range((p - 1) * ps, p * ps - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ items: data, total: count, page: p, pageSize: ps });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireStaffAuth, async (req, res, next) => {
  try {
    const { data: order, error } = await supabaseAdmin().from("orders").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Not found" });
    const { data: items } = await supabaseAdmin().from("order_items").select("*").eq("order_id", req.params.id);
    res.json({ order, items: items || [] });
  } catch (e) {
    next(e);
  }
});

router.put("/:id/status", requireStaffAuth, requirePermission("manageOrders"), async (req, res, next) => {
  try {
    const { status, tracking_number } = req.body || {};
    if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${ORDER_STATUSES.join(", ")}` });

    const patch = { status, updated_at: new Date().toISOString() };
    if (tracking_number !== undefined) patch.tracking_number = tracking_number;

    const { data, error } = await supabaseAdmin().from("orders").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;

    await supabaseAdmin().from("activity_log").insert({
      entity_type: "order", entity_id: req.params.id, action: `status -> ${status}`, actor: req.staff.email,
    });
    res.json({ order: data });
  } catch (e) {
    next(e);
  }
});

export default router;
