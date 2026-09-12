/**
 * Admin CRUD for Personalized Routines (Phase 4 migration 0005) -
 * predefined, admin-authored templates only (never dynamically generated,
 * per the locked Phase 4 scope). Same conventions as wellnessAdmin.js:
 * `manageWellness` RBAC, draft/published workflow mirroring blog.js/
 * faqs.js exactly, sub-resource CRUD for steps mirroring products.js's
 * variants, and a "replace the full set" relationships endpoint for
 * routine_goals mirroring products.js's PUT /:id/relationships.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { sanitizeText, isValidUUID } from "../validation/validators.js";
import { slugify } from "../seo/seoHelpers.js";

const router = Router();
const DOSHAS = ["vata", "pitta", "kapha"];
const TIMES_OF_DAY = ["morning", "afternoon", "evening", "anytime"];

async function uniqueSlug(name, excludeId) {
  const base = slugify(name);
  let candidate = base;
  let n = 1;
  for (;;) {
    let query = supabaseAdmin().from("routine_templates").select("id").eq("slug", candidate);
    if (excludeId) query = query.neq("id", excludeId);
    const { data } = await query.maybeSingle();
    if (!data) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
}

// ---- ROUTINE TEMPLATES ----
router.get("/", requireStaffAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("routine_templates")
      .select("*, routine_steps(*), routine_goals(goal_id, categories(name, slug))")
      .order("sort_order");
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireStaffAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("routine_templates")
      .select("*, routine_steps(*), routine_goals(goal_id)")
      .eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Not found" });
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.post("/", requireStaffAuth, requirePermission("manageWellness"), async (req, res, next) => {
  try {
    const { name, description, dosha, sort_order = 0 } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
    if (dosha && !DOSHAS.includes(dosha)) return res.status(400).json({ error: "Invalid dosha" });
    const slug = await uniqueSlug(name);
    const { data, error } = await supabaseAdmin().from("routine_templates").insert({
      name: sanitizeText(name.trim()), slug, description: description ? sanitizeText(description) : null,
      dosha: dosha || null, sort_order, status: "draft",
    }).select().single();
    if (error) throw error;
    res.status(201).json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.put("/:id", requireStaffAuth, requirePermission("manageWellness"), async (req, res, next) => {
  try {
    const { name, description, dosha, sort_order } = req.body || {};
    if (dosha !== undefined && dosha !== null && dosha !== "" && !DOSHAS.includes(dosha)) return res.status(400).json({ error: "Invalid dosha" });
    const patch = { updated_at: new Date().toISOString() };
    if (name) { patch.name = sanitizeText(name.trim()); patch.slug = await uniqueSlug(name, req.params.id); }
    if (description !== undefined) patch.description = description ? sanitizeText(description) : null;
    if (dosha !== undefined) patch.dosha = dosha || null;
    if (sort_order !== undefined) patch.sort_order = sort_order;
    const { data, error } = await supabaseAdmin().from("routine_templates").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/publish", requireStaffAuth, requirePermission("manageWellness"), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("routine_templates").update({ status: "published", updated_at: new Date().toISOString() })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireStaffAuth, requirePermission("manageWellness"), async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin().from("routine_templates").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

// ---- STEPS (sub-resource, same shape as products.js's variants) ----
router.post("/:id/steps", requireStaffAuth, requirePermission("manageWellness"), async (req, res, next) => {
  try {
    const { title, instructions, step_order = 0, time_of_day, product_id } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: "title is required" });
    if (time_of_day && !TIMES_OF_DAY.includes(time_of_day)) return res.status(400).json({ error: "Invalid time_of_day" });
    if (product_id && !isValidUUID(product_id)) return res.status(400).json({ error: "Invalid product_id" });
    const { data, error } = await supabaseAdmin().from("routine_steps").insert({
      routine_id: req.params.id, title: sanitizeText(title.trim()),
      instructions: instructions ? sanitizeText(instructions) : null,
      step_order, time_of_day: time_of_day || null, product_id: product_id || null,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.put("/:id/steps/:stepId", requireStaffAuth, requirePermission("manageWellness"), async (req, res, next) => {
  try {
    const { title, instructions, step_order, time_of_day, product_id } = req.body || {};
    if (time_of_day !== undefined && time_of_day !== null && time_of_day !== "" && !TIMES_OF_DAY.includes(time_of_day)) {
      return res.status(400).json({ error: "Invalid time_of_day" });
    }
    if (product_id && !isValidUUID(product_id)) return res.status(400).json({ error: "Invalid product_id" });
    const patch = {};
    if (title !== undefined) {
      if (!title.trim()) return res.status(400).json({ error: "title cannot be empty" });
      patch.title = sanitizeText(title.trim());
    }
    if (instructions !== undefined) patch.instructions = instructions ? sanitizeText(instructions) : null;
    if (step_order !== undefined) patch.step_order = step_order;
    if (time_of_day !== undefined) patch.time_of_day = time_of_day || null;
    if (product_id !== undefined) patch.product_id = product_id || null;
    const { data, error } = await supabaseAdmin()
      .from("routine_steps").update(patch).eq("id", req.params.stepId).eq("routine_id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id/steps/:stepId", requireStaffAuth, requirePermission("manageWellness"), async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin().from("routine_steps").delete().eq("id", req.params.stepId).eq("routine_id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

// ---- GOALS (replace-the-full-set, same shape as products.js's relationships) ----
router.put("/:id/goals", requireStaffAuth, requirePermission("manageWellness"), async (req, res, next) => {
  try {
    const routineId = req.params.id;
    const { data: routine } = await supabaseAdmin().from("routine_templates").select("id").eq("id", routineId).maybeSingle();
    if (!routine) return res.status(404).json({ error: "Routine not found" });

    const ids = Array.isArray(req.body?.goal_ids) ? req.body.goal_ids : [];
    const cleanIds = [...new Set(ids.filter((id) => isValidUUID(id)))];

    const { error: delError } = await supabaseAdmin().from("routine_goals").delete().eq("routine_id", routineId);
    if (delError) throw delError;
    if (cleanIds.length) {
      const { error: insError } = await supabaseAdmin()
        .from("routine_goals").insert(cleanIds.map((goal_id) => ({ routine_id: routineId, goal_id })));
      if (insError) throw insError;
    }
    res.json({ goal_ids: cleanIds });
  } catch (e) {
    next(e);
  }
});

export default router;
