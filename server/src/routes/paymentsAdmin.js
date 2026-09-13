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

// ---- Refund Management (Phase UI-1): every refund across all payments,
// not just the ones inline on one payment's detail page. Same `refunds`
// table paymentsAdmin already reads per-payment - just without the
// payment_id filter, joined out to order/customer context for display. ----
router.get(
  "/refunds",
  asyncRoute(async (req, res) => {
    const { status } = req.query;
    let query = supabaseAdmin()
      .from("refunds")
      .select("*, payments(id, amount, method:gateway, orders(order_number, guest_email, guest_phone))", { count: "exact" })
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);

    const { page, pageSize } = parsePagination(req.query);
    query = query.range((page - 1) * pageSize, page * pageSize - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ items: data, total: count, page, pageSize });
  })
);

// ---- Reconciliation dashboard (Phase UI-1): a real summary built ONLY
// from data this app already has (payment status + the reconcile_run
// entries paymentsAdmin's /:id/reconcile already writes to activity_log)
// - there is no Razorpay Settlements API integration in this codebase, so
// this does NOT claim to match bank/gateway settlement files. `matched`
// here means "we have logged a consistent reconcile run for it", not
// "the money has landed in the bank" - the admin page states this
// explicitly rather than implying more than is actually verified. ----
router.get(
  "/reconciliation-summary",
  asyncRoute(async (req, res) => {
    const { data: payments, error } = await supabaseAdmin()
      .from("payments")
      .select("id, amount, status, gateway, created_at, orders(order_number)")
      .eq("status", "SUCCESS")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;

    const paymentIds = (payments || []).map((p) => p.id);
    const { data: logs } = paymentIds.length
      ? await supabaseAdmin().from("activity_log").select("entity_id, note, created_at")
          .eq("entity_type", "payment").eq("action", "reconcile_run").in("entity_id", paymentIds)
          .order("created_at", { ascending: false })
      : { data: [] };

    const latestLogByPayment = new Map();
    for (const log of logs || []) if (!latestLogByPayment.has(log.entity_id)) latestLogByPayment.set(log.entity_id, log);

    const rows = (payments || []).map((p) => {
      const log = latestLogByPayment.get(p.id);
      const reconStatus = !log ? "not_run" : log.note === "consistent" ? "matched" : log.note === "inconclusive" ? "inconclusive" : "mismatch";
      return {
        id: p.id, orderNumber: p.orders?.order_number, amount: p.amount, gateway: p.gateway,
        createdAt: p.created_at, reconciliationStatus: reconStatus, lastCheckedAt: log?.created_at || null,
      };
    });

    const totals = rows.reduce((acc, r) => {
      acc.total += 1;
      acc[r.reconciliationStatus] = (acc[r.reconciliationStatus] || 0) + 1;
      return acc;
    }, { total: 0 });

    res.json({ rows, totals });
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
