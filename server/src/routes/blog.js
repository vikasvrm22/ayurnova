import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { slugify } from "../seo/seoHelpers.js";
import { sanitizeText } from "../validation/validators.js";

const router = Router();

router.get("/", requireStaffAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin().from("blog_posts").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireStaffAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin().from("blog_posts").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Not found" });
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.post("/", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { title, excerpt, body, cover_image, seo_title, seo_description } = req.body || {};
    if (!title) return res.status(400).json({ error: "Title is required" });
    const slug = slugify(title);
    const { data, error } = await supabaseAdmin().from("blog_posts").insert({
      title: sanitizeText(title), slug, excerpt: sanitizeText(excerpt || ""), body: sanitizeText(body || ""),
      cover_image: cover_image || null, seo_title: seo_title || null, seo_description: seo_description || null,
      status: "draft",
    }).select().single();
    if (error) throw error;
    res.status(201).json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.put("/:id", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { title, excerpt, body, cover_image, seo_title, seo_description } = req.body || {};
    const patch = {};
    if (title) { patch.title = sanitizeText(title); patch.slug = slugify(title); }
    if (excerpt !== undefined) patch.excerpt = sanitizeText(excerpt);
    if (body !== undefined) patch.body = sanitizeText(body);
    if (cover_image !== undefined) patch.cover_image = cover_image;
    if (seo_title !== undefined) patch.seo_title = seo_title;
    if (seo_description !== undefined) patch.seo_description = seo_description;
    const { data, error } = await supabaseAdmin().from("blog_posts").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/publish", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("blog_posts").update({ status: "published", published_at: new Date().toISOString() })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireStaffAuth, requirePermission("manageProducts"), async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin().from("blog_posts").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

export default router;
