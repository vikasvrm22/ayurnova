import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";

const router = Router();

router.get("/", requireStaffAuth, requirePermission("manageSettings"), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin().from("settings").select("*");
    if (error) throw error;
    const map = Object.fromEntries(data.map((r) => [r.key, r.value]));
    res.json({ settings: map });
  } catch (e) {
    next(e);
  }
});

router.put("/:key", requireStaffAuth, requirePermission("manageSettings"), async (req, res, next) => {
  try {
    const { value } = req.body || {};
    const { error } = await supabaseAdmin().from("settings").upsert({
      key: req.params.key, value, updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

export default router;
