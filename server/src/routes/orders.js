import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";

const router = Router();

router.get("/", requireStaffAuth, async (req, res, next) => {
  try {
    const { q, status, page = 1, pageSize = 20 } = req.query;
    let query = supabaseAdmin().from("orders").select("*", { count: "exact" }).order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    if (q) query = query.or(`order_number.ilike.%${q}%,guest_email.ilike.%${q}%,guest_phone.ilike.%${q}%`);

    const p = Math.max(1, Number(page));
    const ps = Math.max(1, Number(pageSize));
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
    const allowed = ["pending", "processing", "shipped", "delivered", "cancelled"];
    if (!allowed.includes(status)) return res.status(400).json({ error: `Status must be one of: ${allowed.join(", ")}` });

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
