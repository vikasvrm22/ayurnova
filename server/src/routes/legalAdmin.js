/**
 * Phase 7 - admin CRUD for the four fixed legal CMS pages (legal_pages,
 * seeded once by the migration - see 0009_phase7_notifications_and_legal_
 * cms.sql). Deliberately no create/delete routes: the set of slugs is
 * fixed by the table's own check constraint, so this is edit-in-place +
 * publish/unpublish only, never "add a new page".
 *
 * RBAC: reuses the existing `manageSettings` permission (SuperAdmin/Admin
 * only) rather than adding a new one - legal/policy content is
 * business-critical, site-wide configuration in the same sense Settings
 * already is, and manageSettings already safely excludes Editor/Viewer.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { sanitizeText } from "../validation/validators.js";
import { sanitizeRichText } from "../utils/richTextSanitizer.js";

const router = Router();
router.use(requireStaffAuth, requirePermission("manageSettings"));

const SLUGS = ["terms-and-conditions", "privacy-policy", "return-refund-policy", "shipping-policy"];

router.get("/", async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin().from("legal_pages").select("*").order("slug");
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    next(e);
  }
});

router.get("/:slug", async (req, res, next) => {
  try {
    if (!SLUGS.includes(req.params.slug)) return res.status(404).json({ error: "Not found" });
    const { data, error } = await supabaseAdmin().from("legal_pages").select("*").eq("slug", req.params.slug).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Not found" });
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.put("/:slug", async (req, res, next) => {
  try {
    if (!SLUGS.includes(req.params.slug)) return res.status(404).json({ error: "Not found" });
    const { title, content_html } = req.body || {};
    const patch = { updated_by: req.staff.email, updated_at: new Date().toISOString() };
    if (title !== undefined) {
      if (!String(title).trim()) return res.status(400).json({ error: "Title cannot be empty" });
      patch.title = sanitizeText(String(title).trim()).slice(0, 200);
    }
    // Sanitized server-side regardless of what the admin's rich-text
    // editor produced client-side - see richTextSanitizer.js.
    if (content_html !== undefined) patch.content_html = sanitizeRichText(content_html);

    const { data, error } = await supabaseAdmin().from("legal_pages").update(patch).eq("slug", req.params.slug).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Not found" });
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.post("/:slug/publish", async (req, res, next) => {
  try {
    if (!SLUGS.includes(req.params.slug)) return res.status(404).json({ error: "Not found" });
    const { data, error } = await supabaseAdmin()
      .from("legal_pages")
      .update({ status: "published", published_at: new Date().toISOString(), updated_by: req.staff.email, updated_at: new Date().toISOString() })
      .eq("slug", req.params.slug).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Not found" });
    // The public SSR render cache (server/src/routes/pages.js's own
    // short-TTL `cached()` wrapper) may serve a stale (pre-publish)
    // version for up to that TTL - the same tolerance blog posts/FAQs
    // already have today, not a new gap introduced here.
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.post("/:slug/unpublish", async (req, res, next) => {
  try {
    if (!SLUGS.includes(req.params.slug)) return res.status(404).json({ error: "Not found" });
    const { data, error } = await supabaseAdmin()
      .from("legal_pages")
      .update({ status: "draft", updated_by: req.staff.email, updated_at: new Date().toISOString() })
      .eq("slug", req.params.slug).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Not found" });
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

export default router;
