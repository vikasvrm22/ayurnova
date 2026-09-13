/**
 * Phase 8D - "Buy Again". Read-only: the actual reorder action is the
 * existing client-side cart (js/site.js's addToCart(variantId, qty)),
 * re-priced/re-validated server-side at checkout exactly like any other
 * cart addition - no parallel add-to-cart endpoint needed here. Same
 * shape as server/src/routes/wishlistPublic.js/addressesPublic.js:
 * requireCustomer, {success,data} envelope via sendOk/AppError/asyncRoute/
 * catalogErrorHandler, ownership enforced by construction (the service
 * function only ever queries by req.customer.id, never a client-supplied
 * customer id).
 */
import { Router } from "express";
import { requireCustomer } from "../auth/customerAuth.js";
import { sendOk, asyncRoute, catalogErrorHandler } from "../utils/apiResponse.js";
import { parsePagination } from "../validation/validators.js";
import { getBuyAgainItems } from "../services/buyAgainService.js";

const router = Router();
router.use(requireCustomer);

// ---- GET /api/public/buy-again ----
router.get(
  "/",
  asyncRoute(async (req, res) => {
    const { page, pageSize } = parsePagination(req.query, { defaultPageSize: 20, maxPageSize: 50 });
    const { items, total } = await getBuyAgainItems({ customerId: req.customer.id, page, pageSize });
    sendOk(res, { items }, { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  })
);

router.use(catalogErrorHandler);

export default router;
