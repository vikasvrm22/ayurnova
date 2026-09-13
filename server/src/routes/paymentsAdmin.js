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
    const { status, from, to, q } = req.query;
    let query = supabaseAdmin()
      .from("payments")
      .select("*, orders(order_number, guest_email, guest_phone, customer_id)", { count: "exact" })
      .order("created_at", { ascending: false });
    if (status && PAYMENT_STATUSES.includes(status)) query = query.eq("status", status);
    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);
    // Order number lives on the joined `orders` row, not `payments` itself -
    // Supabase/PostgREST can't ilike across a join in one query, so a
    // free-text search here matches on the payment's own id instead (still
    // useful for pasting a payment UUID); order-number search is done
    // client-side against the loaded page like the rest of this table.
    if (q) query = query.ilike("id", `%${q}%`);

    const { page, pageSize } = parsePagination(req.query);
    query = query.range((page - 1) * pageSize, page * pageSize - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    // Method (UPI/Card/etc.) lives on payment_attempts, not payments - pull
    // each listed payment's most recent attempt to show it without adding a
    // new column to `payments`.
    const paymentIds = (data || []).map((p) => p.id);
    const { data: attempts } = paymentIds.length
      ? await supabaseAdmin().from("payment_attempts").select("payment_id, method, gateway_payment_id, created_at")
          .in("payment_id", paymentIds).order("created_at", { ascending: false })
      : { data: [] };
    const latestAttemptByPayment = new Map();
    for (const a of attempts || []) if (!latestAttemptByPayment.has(a.payment_id)) latestAttemptByPayment.set(a.payment_id, a);
    const items = (data || []).map((p) => ({
      ...p,
      method: latestAttemptByPayment.get(p.id)?.method || null,
      gatewayPaymentId: latestAttemptByPayment.get(p.id)?.gateway_payment_id || null,
    }));

    res.json({ items, total: count, page, pageSize });
  })
);

// ---- Summary KPIs for the Payments list header cards - all read-only
// aggregates over the same `payments` table already used above. ----
router.get(
  "/summary",
  asyncRoute(async (req, res) => {
    const { data: rows, error } = await supabaseAdmin().from("payments").select("status, amount, refunded_amount");
    if (error) throw error;
    const totalAmount = (rows || []).reduce((s, r) => s + Number(r.amount || 0), 0);
    const totalCount = (rows || []).length;
    const countByStatus = (rows || []).reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    const refundedAmount = (rows || []).reduce((s, r) => s + Number(r.refunded_amount || 0), 0);
    res.json({
      totalAmount, totalCount,
      successfulCount: countByStatus.SUCCESS || 0,
      failedCount: countByStatus.FAILED || 0,
      pendingCount: (countByStatus.PENDING || 0) + (countByStatus.INITIATED || 0),
      refundedCount: (countByStatus.REFUNDED || 0) + (countByStatus.PARTIALLY_REFUNDED || 0),
      refundedAmount,
    });
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

// ---- Webhook / Payment Processing Status (Phase UI-1): exposes the
// existing `webhook_events` table (every Razorpay webhook this app has
// ever received is already logged here by paymentService.processWebhookEvent
// - this just surfaces it in the admin UI, no new logging added). ----
router.get(
  "/webhooks",
  asyncRoute(async (req, res) => {
    const { status, eventType } = req.query;
    let query = supabaseAdmin().from("webhook_events").select("*", { count: "exact" }).order("created_at", { ascending: false });
    if (status) query = query.eq("processing_status", status);
    if (eventType) query = query.eq("event_type", eventType);

    const { page, pageSize } = parsePagination(req.query);
    query = query.range((page - 1) * pageSize, page * pageSize - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    // Stats for the last 24h - the reference dashboard's summary tiles.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await supabaseAdmin().from("webhook_events").select("processing_status").gte("created_at", since);
    const stats = { total24h: (recent || []).length, processed: 0, failed: 0, other: 0 };
    for (const r of recent || []) {
      if (r.processing_status === "PROCESSED") stats.processed++;
      else if (r.processing_status === "ERROR") stats.failed++;
      else stats.other++;
    }

    res.json({ items: data, total: count, page, pageSize, stats });
  })
);

router.get(
  "/webhooks/:id",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabaseAdmin().from("webhook_events").select("*").eq("id", req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) throw new AppError("Webhook event not found", 404, "WEBHOOK_NOT_FOUND");
    res.json({ item: data });
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
    // Order line items for the "Items in Order" breakdown on the payment
    // detail page - same order_items table/columns dashboard.js and
    // order-detail.html already read, just scoped to this payment's order.
    const { data: orderItems } = payment.order_id
      ? await supabaseAdmin().from("order_items").select("title_snapshot, variant_label_snapshot, qty, price_snapshot, subtotal").eq("order_id", payment.order_id)
      : { data: [] };

    res.json({ payment, attempts: attempts || [], refunds: refunds || [], orderItems: orderItems || [] });
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
