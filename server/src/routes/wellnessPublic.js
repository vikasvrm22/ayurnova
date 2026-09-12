/**
 * Public/customer JSON API for the Phase 4 Wellness Assessment, Profile,
 * and personalized recommendations. Same {success,data,meta} envelope as
 * catalogPublic.js. `attachCustomerIfPresent` is applied router-wide
 * (matching public.js's own convention) since most routes here work for
 * both guests and logged-in customers - only `/profile`,
 * `/recommendations`, and `/routines/recommended` hard-require a
 * customer (`requireCustomer`), since a "profile" has no meaning for a
 * guest who can't have one persisted.
 */
import { Router } from "express";
import { attachCustomerIfPresent, requireCustomer } from "../auth/customerAuth.js";
import { AppError, sendOk, asyncRoute, catalogErrorHandler } from "../utils/apiResponse.js";
import { parsePagination } from "../validation/validators.js";
import {
  listPublicQuestions, submitAssessment, getProfile, getRecommendedProducts, getRecommendedRoutines,
} from "../services/wellnessService.js";

const router = Router();
router.use(attachCustomerIfPresent);

function toCard(row) {
  const variant = row.product_variants?.[0];
  const image = row.product_images?.[0]?.url || null;
  return {
    id: row.id, title: row.title, slug: row.slug, brand: row.brand || null, image,
    price: variant ? Number(variant.price) : null, mrp: variant?.mrp ? Number(variant.mrp) : null,
    avgRating: row.avg_rating, reviewCount: row.review_count,
  };
}

// ---- GET /api/public/wellness/assessment (published questions - guest-ok) ----
router.get(
  "/assessment",
  asyncRoute(async (req, res) => {
    const questions = await listPublicQuestions();
    sendOk(res, {
      items: questions.map((q) => ({
        id: q.id, question: q.question, dimension: q.dimension,
        options: (q.wellness_question_options || []).map((o) => ({
          id: o.id, label: o.label,
          dosha: o.dosha || null,
          goal: o.goal ? { id: o.goal.id, name: o.goal.name, slug: o.goal.slug } : null,
          concern: o.concern ? { id: o.concern.id, name: o.concern.name, slug: o.concern.slug } : null,
        })),
      })),
    });
  })
);

// ---- POST /api/public/wellness/assessment/submit (guest-ok; persisted only if logged in) ----
router.post(
  "/assessment/submit",
  asyncRoute(async (req, res) => {
    const { answers } = req.body || {};
    let result;
    try {
      result = await submitAssessment(req.customer?.id || null, answers);
    } catch (e) {
      if (e.expose) throw new AppError(e.message, e.status || 400, "INVALID_ANSWERS");
      throw e;
    }
    sendOk(res, { resultDosha: result.resultDosha, goalIds: result.goalIds, concernIds: result.concernIds, saved: result.saved });
  })
);

// ---- GET /api/public/wellness/profile (customer required) ----
router.get(
  "/profile",
  requireCustomer,
  asyncRoute(async (req, res) => {
    const profile = await getProfile(req.customer.id);
    sendOk(res, profile);
  })
);

// ---- GET /api/public/wellness/recommendations (customer required) ----
router.get(
  "/recommendations",
  requireCustomer,
  asyncRoute(async (req, res) => {
    const { page, pageSize } = parsePagination(req.query, { defaultPageSize: 12, maxPageSize: 50 });
    const { items, total, matchType } = await getRecommendedProducts(req.customer.id, { page, pageSize, sort: req.query.sort });
    sendOk(res, { items: items.map(toCard), matchType }, { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  })
);

// ---- GET /api/public/wellness/routines/recommended (customer required) ----
router.get(
  "/routines/recommended",
  requireCustomer,
  asyncRoute(async (req, res) => {
    const { items, matchType } = await getRecommendedRoutines(req.customer.id);
    sendOk(res, { items, matchType });
  })
);

router.use(catalogErrorHandler);

export default router;
