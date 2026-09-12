import { Router } from "express";
import multer from "multer";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { validateProductPayload, validateVariant, sanitizeText, parsePagination, sanitizeSearchTerm, isValidUUID } from "../validation/validators.js";
import { slugify } from "../seo/seoHelpers.js";
import { uploadProductImage } from "../storage/imageUpload.js";

// Phase 3A discovery relationships: one join table per dimension, all
// shaped identically (product_id, <dimension>_id) - see
// supabase/migrations/0003_phase3a_discovery_foundation.sql. Centralised
// here so GET/PUT stay in sync with exactly one list of dimensions.
const RELATIONSHIP_DIMENSIONS = [
  { key: "ingredient_ids", table: "product_ingredients", column: "ingredient_id" },
  { key: "concern_ids", table: "product_concerns", column: "concern_id" },
  { key: "benefit_ids", table: "product_benefits", column: "benefit_id" },
  { key: "goal_ids", table: "product_goals", column: "goal_id" },
];

const router = Router();
const PRODUCT_STATUSES = ["draft", "published", "archived"];
// Admin product list sort - whitelisted columns only. `sort` used to be
// taken straight from the query string and passed to `.order()` unvalidated
// (Phase 0 §13: same unsafe-filter-input pattern as the orders.js `.or()`
// bug, just on the sort column instead of a filter value) - a client could
// pass any string as a column name. Only keys below can ever reach the DB.
const ADMIN_PRODUCT_SORT_COLUMNS = new Set(["created_at", "updated_at", "title", "status", "avg_rating", "review_count"]);
// Multer's limit is a hard ceiling only (prevents genuinely huge uploads
// from ever reaching memory) - the real, admin-configurable size limit is
// enforced inside uploadProductImage() so the error message is useful.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function logActivity(entityId, action, actor, note = "") {
  await supabaseAdmin().from("activity_log").insert({ entity_type: "product", entity_id: entityId, action, actor, note });
}

// Phase 3 audit fix: `products.category_id` is meant to be the product's
// single Product Type (Tablet/Oil/Churna/Syrup - see
// docs/AYURVEDICSTORE-PHASE-3-DECISIONS.md decision #1); Concern/Benefit/
// Goal are multi-valued and live in the separate product_concerns/benefits/
// goals join tables instead. Nothing previously stopped a category_id of
// any type being assigned here - this closes that gap server-side (the
// admin form's category dropdown is also now filtered to product_type
// categories, but that's a UI nicety, not the actual guarantee).
async function isProductTypeCategory(categoryId) {
  const { data } = await supabaseAdmin().from("categories").select("type").eq("id", categoryId).maybeSingle();
  return data?.type === "product_type";
}

async function uniqueSlug(title, excludeId) {
  const base = slugify(title);
  let candidate = base;
  let n = 1;
  for (;;) {
    let query = supabaseAdmin().from("products").select("id").eq("slug", candidate);
    if (excludeId) query = query.neq("id", excludeId);
    const { data } = await query.maybeSingle();
    if (!data) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
}

// ---- ADMIN: LIST (search/filter/sort/pagination) ----
router.get("/", requireStaffAuth, async (req, res, next) => {
  try {
    const { q, status, category_id, sort = "-created_at" } = req.query;
    let query = supabaseAdmin().from("products").select("*, product_variants(*), product_images(*)", { count: "exact" });

    if (q) query = query.ilike("title", `%${sanitizeSearchTerm(q)}%`);
    if (status && PRODUCT_STATUSES.includes(status)) query = query.eq("status", status);
    if (category_id) query = query.eq("category_id", category_id);

    const sortField = sort.replace(/^-/, "");
    const safeSortField = ADMIN_PRODUCT_SORT_COLUMNS.has(sortField) ? sortField : "created_at";
    query = query.order(safeSortField, { ascending: !sort.startsWith("-") });

    const { page: p, pageSize: ps } = parsePagination(req.query);
    query = query.range((p - 1) * ps, p * ps - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ items: data, total: count, page: p, pageSize: ps });
  } catch (e) {
    next(e);
  }
});

// ---- ADMIN: GET ONE ----
router.get("/:id", requireStaffAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("products").select("*, product_variants(*), product_images(*)").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Not found" });
    const { data: activity } = await supabaseAdmin()
      .from("activity_log").select("*").eq("entity_type", "product").eq("entity_id", req.params.id).order("at", { ascending: false });

    // Phase 3A: current discovery-tag selections, so the admin product form
    // can pre-check the right Ingredient/Concern/Benefit/Goal chips.
    const relationships = {};
    for (const dim of RELATIONSHIP_DIMENSIONS) {
      const { data: rows } = await supabaseAdmin().from(dim.table).select(dim.column).eq("product_id", req.params.id);
      relationships[dim.key] = (rows || []).map((r) => r[dim.column]);
    }

    res.json({ item: data, activity: activity || [], relationships });
  } catch (e) {
    next(e);
  }
});

// ---- DISCOVERY RELATIONSHIPS (Phase 3A) ----
// Replaces the FULL set for whichever dimension(s) are present in the body -
// a dimension omitted from the body is left untouched, so the admin form can
// save one chip group at a time or all four together. Each dimension's
// existing rows for this product are deleted then the new set inserted -
// the same "replace the whole set" shape the admin UI's multi-select chips
// naturally produce, and the join tables' own `unique(product_id, X_id)`
// constraint (migration 0003) guards against any accidental duplicate even
// if the same id were sent twice in one request.
router.put("/:id/relationships", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const productId = req.params.id;
    const { data: product } = await supabaseAdmin().from("products").select("id").eq("id", productId).maybeSingle();
    if (!product) return res.status(404).json({ error: "Product not found" });

    const result = {};
    for (const dim of RELATIONSHIP_DIMENSIONS) {
      if (!Object.prototype.hasOwnProperty.call(req.body || {}, dim.key)) continue;
      const ids = Array.isArray(req.body[dim.key]) ? req.body[dim.key] : [];
      const cleanIds = [...new Set(ids.filter((id) => isValidUUID(id)))];

      const { error: delError } = await supabaseAdmin().from(dim.table).delete().eq("product_id", productId);
      if (delError) throw delError;

      if (cleanIds.length) {
        const { error: insError } = await supabaseAdmin()
          .from(dim.table).insert(cleanIds.map((id) => ({ product_id: productId, [dim.column]: id })));
        if (insError) throw insError;
      }
      result[dim.key] = cleanIds;
    }

    await logActivity(productId, "discovery tags updated", req.staff.email);
    res.json({ relationships: result });
  } catch (e) {
    next(e);
  }
});

// ---- ADMIN: CREATE ----
router.post("/", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { valid, errors } = validateProductPayload(req.body);
    if (!valid) return res.status(400).json({ error: "Validation failed", fields: errors });

    const clean = {};
    for (const [k, v] of Object.entries(req.body)) {
      clean[k] = typeof v === "string" ? sanitizeText(v.trim()) : v;
    }

    if (clean.category_id && !(await isProductTypeCategory(clean.category_id))) {
      return res.status(400).json({ error: "Validation failed", fields: { category_id: "Category must be a Product Type category" } });
    }

    const slug = await uniqueSlug(clean.title);
    const now = new Date().toISOString();

    const { data, error } = await supabaseAdmin().from("products").insert({
      ...clean, slug, status: "draft", created_by: req.staff.email, updated_by: req.staff.email,
      created_at: now, updated_at: now,
    }).select().single();
    if (error) throw error;

    await logActivity(data.id, "created", req.staff.email);
    res.status(201).json({ item: data });
  } catch (e) {
    next(e);
  }
});

// ---- ADMIN: UPDATE ----
router.put("/:id", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { valid, errors } = validateProductPayload(req.body);
    if (!valid) return res.status(400).json({ error: "Validation failed", fields: errors });

    const clean = {};
    for (const [k, v] of Object.entries(req.body)) {
      if (k === "expected_updated_at") continue;
      clean[k] = typeof v === "string" ? sanitizeText(v.trim()) : v;
    }

    if (clean.category_id && !(await isProductTypeCategory(clean.category_id))) {
      return res.status(400).json({ error: "Validation failed", fields: { category_id: "Category must be a Product Type category" } });
    }

    if (req.body.expected_updated_at) {
      const { data: existing } = await supabaseAdmin().from("products").select("updated_at").eq("id", req.params.id).single();
      if (existing && existing.updated_at !== req.body.expected_updated_at) {
        return res.status(409).json({ error: "This item changed since you loaded it. Reload and retry." });
      }
    }

    if (clean.title) clean.slug = await uniqueSlug(clean.title, req.params.id);
    clean.updated_by = req.staff.email;
    clean.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin().from("products").update(clean).eq("id", req.params.id).select().single();
    if (error) throw error;

    await logActivity(req.params.id, "edited", req.staff.email);
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/publish", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("products").update({ status: "published", updated_by: req.staff.email, updated_at: new Date().toISOString() })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    await logActivity(req.params.id, "published", req.staff.email);
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/archive", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("products").update({ status: "archived", updated_by: req.staff.email, updated_at: new Date().toISOString() })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    await logActivity(req.params.id, "archived", req.staff.email);
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin().from("products").delete().eq("id", req.params.id);
    if (error) throw error;
    await logActivity(req.params.id, "deleted", req.staff.email);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

// ---- VARIANTS ----
router.post("/:id/variants", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { valid, errors } = validateVariant(req.body);
    if (!valid) return res.status(400).json({ error: "Validation failed", fields: errors });
    const { data, error } = await supabaseAdmin().from("product_variants").insert({
      product_id: req.params.id, label: req.body.label, sku: req.body.sku || null,
      price: req.body.price, mrp: req.body.mrp || null, stock: req.body.stock, weight_grams: req.body.weight_grams || null,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.put("/:id/variants/:variantId", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { valid, errors } = validateVariant(req.body);
    if (!valid) return res.status(400).json({ error: "Validation failed", fields: errors });
    const { data, error } = await supabaseAdmin().from("product_variants").update({
      label: req.body.label, sku: req.body.sku || null, price: req.body.price,
      mrp: req.body.mrp || null, stock: req.body.stock, weight_grams: req.body.weight_grams || null,
    }).eq("id", req.params.variantId).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id/variants/:variantId", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin().from("product_variants").delete().eq("id", req.params.variantId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

// ---- IMAGES ----
router.post("/:id/images", requireStaffAuth, requirePermission("manageProducts"), upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image file uploaded" });
    const { url } = await uploadProductImage(req.file, req.params.id);

    const { data: existing } = await supabaseAdmin().from("product_images").select("sort_order").eq("product_id", req.params.id).order("sort_order", { ascending: false }).limit(1);
    const nextOrder = (existing?.[0]?.sort_order ?? -1) + 1;

    const { data, error } = await supabaseAdmin().from("product_images").insert({
      product_id: req.params.id, url, sort_order: nextOrder,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id/images/:imageId", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin().from("product_images").delete().eq("id", req.params.imageId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

export default router;
