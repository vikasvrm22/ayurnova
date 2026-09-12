/**
 * Admin CRUD for the structured `ingredients` table (Phase 3A migration,
 * 0003_phase3a_discovery_foundation.sql). Mirrors categories.js's shape -
 * same auth/RBAC (`manageProducts`, the same permission categories.js and
 * blog.js already use for catalog-adjacent content), same slugify/sanitize
 * conventions. Not to be confused with `products.ingredients`, the existing
 * free-text "full ingredient list" column on a product - that is untouched;
 * this is the separate, structured entity a product can be tagged with via
 * `product_ingredients`.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { slugify } from "../seo/seoHelpers.js";
import { sanitizeText } from "../validation/validators.js";

const router = Router();

router.get("/", requireStaffAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin().from("ingredients").select("*").order("name");
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    next(e);
  }
});

router.post("/", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { name, description } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
    const slug = slugify(name);
    const { data, error } = await supabaseAdmin().from("ingredients").insert({
      name: sanitizeText(name.trim()), slug, description: description ? sanitizeText(description) : null,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.put("/:id", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { name, description } = req.body || {};
    const patch = {};
    if (name) { patch.name = sanitizeText(name.trim()); patch.slug = slugify(name); }
    if (description !== undefined) patch.description = description ? sanitizeText(description) : null;
    const { data, error } = await supabaseAdmin().from("ingredients").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin().from("ingredients").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

export default router;
