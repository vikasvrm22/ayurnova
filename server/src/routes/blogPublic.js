/**
 * Public read-only JSON API for the Ayurveda Knowledge Hub (Phase 3).
 * `blog_posts` and its admin CRUD (server/src/routes/blog.js) already
 * existed from an earlier phase - what was missing (Phase 3 audit §3.5)
 * was any way for a shopper to actually read a published post. This is
 * that missing public read side, nothing about authoring changes. Same
 * {success,data}/{success,error} envelope as catalogPublic.js.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { parsePagination, isValidSlug } from "../validation/validators.js";
import { AppError, sendOk, asyncRoute, catalogErrorHandler } from "../utils/apiResponse.js";

const router = Router();
const MAX_PAGE_SIZE = 50;

function toPostCard(p) {
  return {
    id: p.id, title: p.title, slug: p.slug, excerpt: p.excerpt || null,
    coverImage: p.cover_image || null, publishedAt: p.published_at,
  };
}

// ---- GET /api/public/blog ----
router.get(
  "/",
  asyncRoute(async (req, res) => {
    const { page, pageSize } = parsePagination(req.query, { defaultPageSize: 10, maxPageSize: MAX_PAGE_SIZE });
    const { data, error, count } = await supabaseAdmin()
      .from("blog_posts")
      .select("id, title, slug, excerpt, cover_image, published_at", { count: "exact" })
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);
    if (error) throw error;
    sendOk(res, { items: (data || []).map(toPostCard) }, { page, pageSize, total: count || 0, totalPages: Math.max(1, Math.ceil((count || 0) / pageSize)) });
  })
);

// ---- GET /api/public/blog/:slug ----
router.get(
  "/:slug",
  asyncRoute(async (req, res) => {
    if (!isValidSlug(req.params.slug)) throw new AppError("Post not found", 404, "POST_NOT_FOUND");
    const { data: post } = await supabaseAdmin()
      .from("blog_posts").select("*").eq("slug", req.params.slug).eq("status", "published").maybeSingle();
    if (!post) throw new AppError("Post not found", 404, "POST_NOT_FOUND");
    sendOk(res, {
      id: post.id, title: post.title, slug: post.slug, excerpt: post.excerpt || null,
      body: post.body || "", coverImage: post.cover_image || null,
      seoTitle: post.seo_title || null, seoDescription: post.seo_description || null,
      publishedAt: post.published_at,
    });
  })
);

router.use(catalogErrorHandler);

export default router;
