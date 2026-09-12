import { Router } from "express";
import multer from "multer";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { validateProductPayload, validateVariant, sanitizeText } from "../validation/validators.js";
import { slugify } from "../seo/seoHelpers.js";
import { uploadProductImage } from "../storage/imageUpload.js";

const router = Router();
// Multer's limit is a hard ceiling only (prevents genuinely huge uploads
// from ever reaching memory) - the real, admin-configurable size limit is
// enforced inside uploadProductImage() so the error message is useful.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function logActivity(entityId, action, actor, note = "") {
  await supabaseAdmin().from("activity_log").insert({ entity_type: "product", entity_id: entityId, action, actor, note });
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
    const { q, status, category_id, page = 1, pageSize = 20, sort = "-created_at" } = req.query;
    let query = supabaseAdmin().from("products").select("*, product_variants(*), product_images(*)", { count: "exact" });

    if (q) query = query.ilike("title", `%${q}%`);
    if (status) query = query.eq("status", status);
    if (category_id) query = query.eq("category_id", category_id);

    const sortField = sort.replace(/^-/, "");
    query = query.order(sortField, { ascending: !sort.startsWith("-") });

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

// ---- ADMIN: GET ONE ----
router.get("/:id", requireStaffAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("products").select("*, product_variants(*), product_images(*)").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Not found" });
    const { data: activity } = await supabaseAdmin()
      .from("activity_log").select("*").eq("entity_type", "product").eq("entity_id", req.params.id).order("at", { ascending: false });
    res.json({ item: data, activity: activity || [] });
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
