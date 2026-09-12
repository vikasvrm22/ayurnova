/**
 * Admin Payments module: All Payments, Payment Attempts, Failed Payments,
 * Refunds, Reconciliation. RBAC: `managePayments` (SuperAdmin/Admin only -
 * see server/src/config.js ROLE_PERMISSIONS), same pattern as every other
 * admin module.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { parsePagination } from "../validation/validators.js";
import { AppError, asyncRoute } from "../utils/apiResponse.js";
import * as paymentService from "../services/paymentService.js";
import { PAYMENT_STATUSES } from "../config.js";

const router = Router();
router.use(requireStaffAuth, requirePermission("managePayments"));

// ---- All Payments (with order/customer context) ----
router.get(
  "/",
  asyncRoute(async (req, res) => {
    const { status } = req.query;
    let query = supabaseAdmin()
      .from("payments")
      .select("*, orders(order_number, guest_email, guest_phone, customer_id)", { count: "exact" })
      .order("created_at", { ascending: false });
    if (status && PAYMENT_STATUSES.includes(status)) query = query.eq("status", status);

    const { page, pageSize } = parsePagination(req.query);
    query = query.range((page - 1) * pageSize, page * pageSize - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ items: data, total: count, page, pageSize });
  })
);

// ---- Failed Payments (convenience filter - every failed attempt, most recent first) ----
router.get(
  "/failed-attempts",
  asyncRoute(async (req, res) => {
    const { page, pageSize } = parsePagination(req.query);
    const { data, error, count } = await supabaseAdmin()
      .from("payment_attempts")
      .select("*, payments(order_id, orders(order_number))", { count: "exact" })
      .eq("status", "FAILED")
      .order("created_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);
    if (error) throw error;
    res.json({ items: data, total: count, page, pageSize });
  })
);

// ---- Payment detail: attempts + refunds + order context ----
router.get(
  "/:id",
  asyncRoute(async (req, res) => {
    const { data: payment, error } = await supabaseAdmin()
      .from("payments").select("*, orders(*)").eq("id", req.params.id).maybeSingle();
    if (error) throw error;
    if (!payment) throw new AppError("Payment not found", 404, "PAYMENT_NOT_FOUND");

    const { data: attempts } = await supabaseAdmin()
      .from("payment_attempts").select("*").eq("payment_id", payment.id).order("attempt_number", { ascending: true });
    const { data: refunds } = await supabaseAdmin()
      .from("refunds").select("*").eq("payment_id", payment.id).order("created_at", { ascending: false });

    res.json({ payment, attempts: attempts || [], refunds: refunds || [] });
  })
);

// ---- Refunds (full or partial) ----
router.post(
  "/:id/refund",
  requirePermission("managePayments"),
  asyncRoute(async (req, res) => {
    const { amount, reason } = req.body || {};
    const refund = await paymentService.createRefund({
      paymentId: req.params.id,
      amountRupees: amount !== undefined && amount !== "" ? Number(amount) : undefined,
      reason: reason || "",
      actorEmail: req.staff.email,
    });
    res.status(201).json({ item: refund });
  })
);

// ---- Reconciliation: compare local state against Razorpay's record.
// Read-only - never auto-repairs (Phase 2 §8). The run itself is logged
// for auditability even though nothing is changed by it. ----
router.post(
  "/:id/reconcile",
  asyncRoute(async (req, res) => {
    const report = await paymentService.reconcilePayment(req.params.id);
    await supabaseAdmin().from("activity_log").insert({
      entity_type: "payment", entity_id: req.params.id, action: "reconcile_run", actor: req.staff.email,
      note: report.consistent === null ? "inconclusive" : report.consistent ? "consistent" : `mismatch: ${report.mismatches.join("; ")}`,
    });
    res.json(report);
  })
);

export default router;
