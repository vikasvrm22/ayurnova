import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";

const router = Router();

router.get("/", requireStaffAuth, async (req, res, next) => {
  try {
    const { status } = req.query;
    let query = supabaseAdmin().from("vaidya_bookings").select("*").order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    next(e);
  }
});

router.put("/:id/status", requireStaffAuth, requirePermission("manageOrders"), async (req, res, next) => {
  try {
    const { status } = req.body || {};
    const allowed = ["pending", "confirmed", "completed", "cancelled"];
    if (!allowed.includes(status)) return res.status(400).json({ error: `Status must be one of: ${allowed.join(", ")}` });
    const { data, error } = await supabaseAdmin().from("vaidya_bookings").update({ status }).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

export default router;
