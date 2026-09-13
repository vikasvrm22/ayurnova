/**
 * Phase 9B (P1-5) - read-only admin visibility into the new error_log
 * table (server/src/services/errorLogService.js). Same "read-only,
 * no resend/replay action" shape as notificationsAdmin.js - this is an
 * observability screen, not an operational-action screen.
 *
 * RBAC: uses `manageSettings` (SuperAdmin/Admin only), one tier more
 * restrictive than notificationsAdmin's `viewCustomers` - stack traces
 * and internal paths are a more sensitive surface than customer
 * communication history, so Viewer/Editor are correctly excluded here.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { parsePagination } from "../validation/validators.js";

const router = Router();
router.use(requireStaffAuth, requirePermission("manageSettings"));

router.get("/", async (req, res, next) => {
  try {
    const { source, from, to } = req.query;
    const { page, pageSize } = parsePagination(req.query, { defaultPageSize: 25, maxPageSize: 100 });

    let query = supabaseAdmin().from("error_log").select("*", { count: "exact" }).order("created_at", { ascending: false });
    if (source) query = query.eq("source", source);
    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);
    query = query.range((page - 1) * pageSize, page * pageSize - 1);

    const { data, error, count } = await query;
    if (error) {
      // The migration may not be applied yet in this environment - an
      // honest empty list beats a 500 on an otherwise-optional screen.
      if (error.code === "42P01") return res.json({ items: [], total: 0, page, pageSize, migrationApplied: false });
      throw error;
    }
    res.json({ items: data || [], total: count || 0, page, pageSize, migrationApplied: true });
  } catch (e) {
    next(e);
  }
});

export default router;
