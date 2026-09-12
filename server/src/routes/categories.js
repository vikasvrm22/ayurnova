import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { slugify } from "../seo/seoHelpers.js";
import { sanitizeText } from "../validation/validators.js";

const router = Router();

router.get("/", requireStaffAuth, async (req, res, next) => {
  try {
    const { type } = req.query;
    let query = supabaseAdmin().from("categories").select("*").order("sort_order");
    if (type) query = query.eq("type", type);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    next(e);
  }
});

router.post("/", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { name, type, sort_order = 0 } = req.body || {};
    if (!name || !["concern", "benefit", "product_type"].includes(type)) {
      return res.status(400).json({ error: "name and a valid type (concern/benefit/product_type) required" });
    }
    const slug = slugify(name);
    const { data, error } = await supabaseAdmin().from("categories").insert({
      name: sanitizeText(name.trim()), slug, type, sort_order,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.put("/:id", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { name, sort_order } = req.body || {};
    const patch = {};
    if (name) { patch.name = sanitizeText(name.trim()); patch.slug = slugify(name); }
    if (sort_order !== undefined) patch.sort_order = sort_order;
    const { data, error } = await supabaseAdmin().from("categories").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin().from("categories").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

export default router;
