/**
 * Admin CRUD for `faqs` (Phase 3A migration, status added in
 * 0004_phase3_faq_status.sql). Nullable `product_id`: NULL = global/site
 * FAQ, set = that product's own FAQ - one table, both scopes, per
 * docs/AYURVEDICSTORE-PHASE-3-DECISIONS.md decision #3. Same auth/RBAC/
 * sanitize conventions as categories.js/ingredients.js. Status workflow
 * (draft -> published, via POST /:id/publish) mirrors blog.js's - a new
 * FAQ always starts 'draft'; only a published one is ever public.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { sanitizeText, isValidUUID } from "../validation/validators.js";
import { invalidateCatalogCache } from "./pages.js";

const router = Router();

// Wiring Guardian WG-0036: the public /faq page is cached under a static
// "faq" key (pages.js) that nothing cleared, so an admin create/update/
// publish/delete here could leave the public page stale for up to the
// cache TTL. Same invalidation-on-write pattern as categories.js/products.js.
router.use((req, res, next) => {
  if (["POST", "PUT", "DELETE"].includes(req.method)) {
    res.on("finish", () => {
      if (res.statusCode < 400) invalidateCatalogCache();
    });
  }
  next();
});

// ?product_id=<uuid> -> that product's FAQs only. ?scope=global -> only the
// site-wide FAQs (product_id is null). Neither given -> everything, most
// useful for a single admin FAQ management screen.
router.get("/", requireStaffAuth, async (req, res, next) => {
  try {
    let query = supabaseAdmin().from("faqs").select("*, products(title)").order("sort_order");
    if (req.query.product_id) {
      if (!isValidUUID(req.query.product_id)) return res.status(400).json({ error: "Invalid product_id" });
      query = query.eq("product_id", req.query.product_id);
    } else if (req.query.scope === "global") {
      query = query.is("product_id", null);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    next(e);
  }
});

// New FAQs always start 'draft', same convention as blog_posts (blog.js's
// own POST ignores any client-sent status the same way) - publishing is a
// separate, explicit action below.
router.post("/", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { question, answer, product_id, sort_order = 0 } = req.body || {};
    if (!question || !question.trim()) return res.status(400).json({ error: "question is required" });
    if (!answer || !answer.trim()) return res.status(400).json({ error: "answer is required" });
    if (product_id && !isValidUUID(product_id)) return res.status(400).json({ error: "Invalid product_id" });
    const { data, error } = await supabaseAdmin().from("faqs").insert({
      question: sanitizeText(question.trim()), answer: sanitizeText(answer.trim()),
      product_id: product_id || null, sort_order, status: "draft",
    }).select().single();
    if (error) throw error;
    res.status(201).json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.put("/:id", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { question, answer, product_id, sort_order } = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if (question !== undefined) {
      if (!question.trim()) return res.status(400).json({ error: "question cannot be empty" });
      patch.question = sanitizeText(question.trim());
    }
    if (answer !== undefined) {
      if (!answer.trim()) return res.status(400).json({ error: "answer cannot be empty" });
      patch.answer = sanitizeText(answer.trim());
    }
    if (product_id !== undefined) {
      if (product_id && !isValidUUID(product_id)) return res.status(400).json({ error: "Invalid product_id" });
      patch.product_id = product_id || null;
    }
    if (sort_order !== undefined) patch.sort_order = sort_order;
    const { data, error } = await supabaseAdmin().from("faqs").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/publish", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("faqs").update({ status: "published", updated_at: new Date().toISOString() })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin().from("faqs").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

export default router;
