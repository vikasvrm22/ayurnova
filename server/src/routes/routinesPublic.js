/**
 * Public read-only JSON API for Personalized Routines (Phase 4) - general
 * browsing (list/detail of every published routine), as distinct from
 * server/src/routes/wellnessPublic.js's `/wellness/routines/recommended`
 * (the personalized subset for one logged-in customer). Same {success,
 * data}/{success,error} envelope as catalogPublic.js/blogPublic.js.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { parsePagination, isValidSlug } from "../validation/validators.js";
import { AppError, sendOk, asyncRoute, catalogErrorHandler } from "../utils/apiResponse.js";

const router = Router();
const MAX_PAGE_SIZE = 50;

function toRoutineCard(r) {
  return { id: r.id, name: r.name, slug: r.slug, description: r.description || null, dosha: r.dosha || null };
}

// ---- GET /api/public/routines ----
router.get(
  "/",
  asyncRoute(async (req, res) => {
    const { page, pageSize } = parsePagination(req.query, { defaultPageSize: 12, maxPageSize: MAX_PAGE_SIZE });
    const { data, error, count } = await supabaseAdmin()
      .from("routine_templates")
      .select("id, name, slug, description, dosha", { count: "exact" })
      .eq("status", "published")
      .order("sort_order")
      .range((page - 1) * pageSize, page * pageSize - 1);
    if (error) throw error;
    sendOk(res, { items: (data || []).map(toRoutineCard) }, { page, pageSize, total: count || 0, totalPages: Math.max(1, Math.ceil((count || 0) / pageSize)) });
  })
);

// ---- GET /api/public/routines/:slug ----
router.get(
  "/:slug",
  asyncRoute(async (req, res) => {
    if (!isValidSlug(req.params.slug)) throw new AppError("Routine not found", 404, "ROUTINE_NOT_FOUND");
    const { data: routine } = await supabaseAdmin()
      .from("routine_templates")
      .select("id, name, slug, description, dosha, routine_steps(id, step_order, time_of_day, title, instructions, product_id), routine_goals(categories(id,name,slug))")
      .eq("slug", req.params.slug).eq("status", "published").maybeSingle();
    if (!routine) throw new AppError("Routine not found", 404, "ROUTINE_NOT_FOUND");

    const steps = [...(routine.routine_steps || [])].sort((a, b) => a.step_order - b.step_order)
      .map((s) => ({ id: s.id, stepOrder: s.step_order, timeOfDay: s.time_of_day, title: s.title, instructions: s.instructions || null, productId: s.product_id || null }));
    const goals = (routine.routine_goals || []).map((g) => g.categories).filter(Boolean);

    sendOk(res, { id: routine.id, name: routine.name, slug: routine.slug, description: routine.description || null, dosha: routine.dosha || null, steps, goals });
  })
);

router.use(catalogErrorHandler);

export default router;
