/**
 * Admin CRUD for the Wellness Assessment's questions/options (Phase 4
 * migration 0005). A question contributes to exactly one dimension -
 * dosha, goal, or concern - and its options each vote for one value of
 * that dimension (goal/concern options reference real Phase 3 `categories`
 * rows, never a duplicated taxonomy). Same auth/RBAC/sanitize conventions
 * as categories.js/ingredients.js/faqs.js, gated on the dedicated
 * `manageWellness` permission (server/src/config.js) rather than
 * `manageProducts`, since wellness content is its own concern.
 *
 * Publish workflow mirrors blog.js/faqs.js exactly: a new question always
 * starts 'draft'; only a published question (and only its options) are
 * ever served to /api/public/wellness/assessment.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { sanitizeText, isValidUUID } from "../validation/validators.js";

const router = Router();
const DOSHAS = ["vata", "pitta", "kapha"];

function validateOptionTarget(body) {
  const targets = [body.dosha, body.goal_id, body.concern_id].filter((v) => v !== undefined && v !== null && v !== "");
  if (targets.length !== 1) return "Exactly one of dosha/goal_id/concern_id is required";
  if (body.dosha !== undefined && body.dosha !== null && body.dosha !== "" && !DOSHAS.includes(body.dosha)) return "Invalid dosha";
  if (body.goal_id && !isValidUUID(body.goal_id)) return "Invalid goal_id";
  if (body.concern_id && !isValidUUID(body.concern_id)) return "Invalid concern_id";
  return null;
}

// ---- QUESTIONS ----
router.get("/", requireStaffAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("wellness_questions")
      .select("*, wellness_question_options(*, goal:categories!goal_id(name,slug), concern:categories!concern_id(name,slug))")
      .order("sort_order");
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    next(e);
  }
});

router.post("/", requireStaffAuth, requirePermission("manageWellness"), async (req, res, next) => {
  try {
    const { question, dimension, sort_order = 0 } = req.body || {};
    if (!question || !question.trim()) return res.status(400).json({ error: "question is required" });
    if (!["dosha", "goal", "concern"].includes(dimension)) return res.status(400).json({ error: "dimension must be dosha, goal, or concern" });
    const { data, error } = await supabaseAdmin().from("wellness_questions").insert({
      question: sanitizeText(question.trim()), dimension, sort_order, status: "draft",
    }).select().single();
    if (error) throw error;
    res.status(201).json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.put("/:id", requireStaffAuth, requirePermission("manageWellness"), async (req, res, next) => {
  try {
    const { question, sort_order } = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (question !== undefined) {
      if (!question.trim()) return res.status(400).json({ error: "question cannot be empty" });
      patch.question = sanitizeText(question.trim());
    }
    if (sort_order !== undefined) patch.sort_order = sort_order;
    // dimension is intentionally not editable after creation - changing it
    // would orphan any existing options that voted for the old dimension.
    // Delete the question and create a new one instead.
    const { data, error } = await supabaseAdmin().from("wellness_questions").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/publish", requireStaffAuth, requirePermission("manageWellness"), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("wellness_questions").update({ status: "published", updated_at: new Date().toISOString() })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireStaffAuth, requirePermission("manageWellness"), async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin().from("wellness_questions").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

// ---- OPTIONS (sub-resource, same shape as products.js's variants) ----
router.post("/:id/options", requireStaffAuth, requirePermission("manageWellness"), async (req, res, next) => {
  try {
    const { label, sort_order = 0 } = req.body || {};
    if (!label || !label.trim()) return res.status(400).json({ error: "label is required" });
    const targetError = validateOptionTarget(req.body || {});
    if (targetError) return res.status(400).json({ error: targetError });
    const { data, error } = await supabaseAdmin().from("wellness_question_options").insert({
      question_id: req.params.id, label: sanitizeText(label.trim()), sort_order,
      dosha: req.body.dosha || null, goal_id: req.body.goal_id || null, concern_id: req.body.concern_id || null,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.put("/:id/options/:optionId", requireStaffAuth, requirePermission("manageWellness"), async (req, res, next) => {
  try {
    const { label, sort_order } = req.body || {};
    const patch = {};
    if (label !== undefined) {
      if (!label.trim()) return res.status(400).json({ error: "label cannot be empty" });
      patch.label = sanitizeText(label.trim());
    }
    if (sort_order !== undefined) patch.sort_order = sort_order;
    if (req.body && (req.body.dosha !== undefined || req.body.goal_id !== undefined || req.body.concern_id !== undefined)) {
      const targetError = validateOptionTarget(req.body);
      if (targetError) return res.status(400).json({ error: targetError });
      patch.dosha = req.body.dosha || null;
      patch.goal_id = req.body.goal_id || null;
      patch.concern_id = req.body.concern_id || null;
    }
    const { data, error } = await supabaseAdmin()
      .from("wellness_question_options").update(patch).eq("id", req.params.optionId).eq("question_id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id/options/:optionId", requireStaffAuth, requirePermission("manageWellness"), async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin().from("wellness_question_options").delete().eq("id", req.params.optionId).eq("question_id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

export default router;
