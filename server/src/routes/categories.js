import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { slugify } from "../seo/seoHelpers.js";
import { sanitizeText } from "../validation/validators.js";
import { invalidateCatalogCache } from "./pages.js";

const router = Router();

// Phase 9F (P1-7): same storefront-cache invalidation as products.js -
// see that file's own comment. Categories feed Shop's filter sidebar/
// mega-menu and category landing pages, so a category create/update/
// delete needs the same immediate-effect treatment.
router.use((req, res, next) => {
  if (["POST", "PUT", "DELETE"].includes(req.method)) {
    res.on("finish", () => {
      if (res.statusCode < 400) invalidateCatalogCache();
    });
  }
  next();
});

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

// Phase 3A: `categories.type` was widened in the DB (migration 0003) to
// also allow 'goal' alongside the original 'concern'/'benefit'/'product_type'
// - this app-layer whitelist must stay in sync with that constraint, the
// same way `CATEGORY_TYPES` in catalogService.js and the type check in
// catalogPublic.js's `GET /categories` do.
const CATEGORY_TYPES = ["concern", "benefit", "product_type", "goal"];

// Real per-category product counts for the admin Categories list (Phase
// UI-1) - a plain group-by over `products.category_id`, not an invented
// number. Only `product_type` categories are ever assigned as a product's
// `category_id`, so concern/benefit/goal categories simply show 0 here
// (they're tagged via their own join tables, not this column).
router.get("/product-counts", requireStaffAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin().from("products").select("category_id").not("category_id", "is", null);
    if (error) throw error;
    const counts = {};
    for (const row of data || []) counts[row.category_id] = (counts[row.category_id] || 0) + 1;
    res.json(counts);
  } catch (e) {
    next(e);
  }
});

router.post("/", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { name, type, sort_order = 0, description, hero_image, seo_title, seo_description } = req.body || {};
    if (!name || !CATEGORY_TYPES.includes(type)) {
      return res.status(400).json({ error: `name and a valid type (${CATEGORY_TYPES.join("/")}) required` });
    }
    const slug = slugify(name);
    const { data, error } = await supabaseAdmin().from("categories").insert({
      name: sanitizeText(name.trim()), slug, type, sort_order,
      description: description ? sanitizeText(description) : null,
      hero_image: hero_image || null,
      seo_title: seo_title ? sanitizeText(seo_title) : null,
      seo_description: seo_description ? sanitizeText(seo_description) : null,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.put("/:id", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { name, sort_order, description, hero_image, seo_title, seo_description } = req.body || {};
    const patch = {};
    if (name) { patch.name = sanitizeText(name.trim()); patch.slug = slugify(name); }
    if (sort_order !== undefined) patch.sort_order = sort_order;
    if (description !== undefined) patch.description = description ? sanitizeText(description) : null;
    if (hero_image !== undefined) patch.hero_image = hero_image || null;
    if (seo_title !== undefined) patch.seo_title = seo_title ? sanitizeText(seo_title) : null;
    if (seo_description !== undefined) patch.seo_description = seo_description ? sanitizeText(seo_description) : null;
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
