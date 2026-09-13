/**
 * Phase 7 - read-only notification delivery history. Deliberately no
 * write routes at all (no manual "resend" action) - the spec for this
 * screen is explicitly read-only; idempotent retry-safety is handled by
 * notification_log's own unique constraint, not by a staff-triggered
 * resend button.
 *
 * RBAC: reuses the existing `viewCustomers` permission (SuperAdmin/Admin/
 * Viewer - see server/src/config.js ROLE_PERMISSIONS) rather than adding a
 * new one - this is read-only visibility into customer-communication
 * history, the same sensitivity tier as viewing customer records, and
 * `viewCustomers` already safely covers exactly that audience (notably
 * excluding Editor, matching every other customer-data-adjacent screen).
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { parsePagination, isValidUUID } from "../validation/validators.js";
import { NOTIFICATION_EVENTS, NOTIFICATION_CHANNELS } from "../notify/notificationService.js";

const router = Router();
router.use(requireStaffAuth, requirePermission("viewCustomers"));

const STATUSES = ["sent", "failed", "skipped"];

router.get("/", async (req, res, next) => {
  try {
    const { event, channel, status, order_id, customer_id, from, to } = req.query;
    let query = supabaseAdmin()
      .from("notification_log")
      .select("*, orders(order_number)", { count: "exact" })
      .order("created_at", { ascending: false });

    if (event && NOTIFICATION_EVENTS.includes(event)) query = query.eq("event", event);
    if (channel && NOTIFICATION_CHANNELS.includes(channel)) query = query.eq("channel", channel);
    if (status && STATUSES.includes(status)) query = query.eq("status", status);
    if (order_id && isValidUUID(order_id)) query = query.eq("order_id", order_id);
    if (customer_id && isValidUUID(customer_id)) query = query.eq("customer_id", customer_id);
    // Plain ISO date bounds (yyyy-mm-dd) - never interpolated into a raw
    // filter expression, only ever passed as a bound value.
    if (from && !Number.isNaN(Date.parse(from))) query = query.gte("created_at", new Date(from).toISOString());
    if (to && !Number.isNaN(Date.parse(to))) query = query.lte("created_at", new Date(to).toISOString());

    const { page, pageSize } = parsePagination(req.query);
    query = query.range((page - 1) * pageSize, page * pageSize - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ items: data, total: count, page, pageSize });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    if (!isValidUUID(req.params.id)) return res.status(404).json({ error: "Not found" });
    const { data, error } = await supabaseAdmin()
      .from("notification_log").select("*, orders(order_number)").eq("id", req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Not found" });
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

export default router;
