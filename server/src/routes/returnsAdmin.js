/**
 * Phase 6B - admin return review + refund processing. Same legacy
 * {item}/{items}/{error} shape as every other admin route (orders.js,
 * paymentsAdmin.js, inventoryAdmin.js) - the {success,data} convention is
 * specifically for the new customer-facing API, not admin routes, which
 * have consistently stayed on their original shape since Phase 1.
 *
 * Reads are open to any staff role (requireStaffAuth only); review/refund
 * writes require the dedicated `manageReturns` permission
 * (SuperAdmin/Admin only - Editor/Viewer excluded, same tier as
 * manageOrders/managePayments/manageInventory).
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { parsePagination } from "../validation/validators.js";
import * as paymentService from "../services/paymentService.js";
import { receiveReturnedItem } from "../services/returnsService.js";
import { notify } from "../notify/notificationService.js";

const router = Router();
const RETURN_STATUSES = ["requested", "approved", "rejected", "refunded"];

router.get("/", requireStaffAuth, async (req, res, next) => {
  try {
    const { status } = req.query;
    let query = supabaseAdmin()
      .from("return_requests")
      .select("*, orders(order_number, payment_method), return_request_items(*)", { count: "exact" })
      .order("created_at", { ascending: false });
    if (status && RETURN_STATUSES.includes(status)) query = query.eq("status", status);
    const { page, pageSize } = parsePagination(req.query);
    query = query.range((page - 1) * pageSize, page * pageSize - 1);
    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ items: data, total: count, page, pageSize });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireStaffAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("return_requests")
      .select("*, orders(*), return_request_items(*, order_items(title_snapshot, variant_label_snapshot, price_snapshot))")
      .eq("id", req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Return request not found" });
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

// ---- POST /:id/review - approve (sets refund_amount) or reject (sets rejection_reason) ----
router.post("/:id/review", requireStaffAuth, requirePermission("manageReturns"), async (req, res, next) => {
  try {
    const { decision, refund_amount, rejection_reason } = req.body || {};
    if (!["approve", "reject"].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
    }

    const { data: ret, error } = await supabaseAdmin()
      .from("return_requests")
      .select("*, orders(*), return_request_items(*, order_items(price_snapshot, qty, variant_id))")
      .eq("id", req.params.id).maybeSingle();
    if (error) throw error;
    if (!ret) return res.status(404).json({ error: "Return request not found" });
    if (ret.status !== "requested") {
      return res.status(400).json({ error: `This return has already been reviewed (status: ${ret.status}).` });
    }

    if (decision === "reject") {
      if (!rejection_reason || !String(rejection_reason).trim()) {
        return res.status(400).json({ error: "A rejection reason is required" });
      }
      const { data: updated, error: updateError } = await supabaseAdmin()
        .from("return_requests")
        .update({
          status: "rejected", rejection_reason: String(rejection_reason).trim(),
          reviewed_by: req.staff.email, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        })
        .eq("id", ret.id).eq("status", "requested").select().maybeSingle();
      if (updateError) throw updateError;
      if (!updated) return res.status(409).json({ error: "This return has already been reviewed." });

      await supabaseAdmin().from("activity_log").insert({
        entity_type: "return_request", entity_id: ret.id, action: "rejected", actor: req.staff.email, note: rejection_reason,
      });
      await notify("return_rejected", { order: ret.orders, dedupeKey: ret.id, rejectionReason: rejection_reason });
      return res.json({ item: updated });
    }

    // approve - refund_amount is capped server-side at the returned
    // items' own value (price_snapshot * qty), never client-trusted
    // beyond that ceiling. Defaults to the full returned-items value if
    // not explicitly given.
    const maxRefundable = ret.return_request_items.reduce((sum, i) => sum + Number(i.order_items?.price_snapshot || 0) * i.qty, 0);
    const amount = refund_amount !== undefined && refund_amount !== "" ? Number(refund_amount) : maxRefundable;
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "refund_amount must be a positive number" });
    if (amount > maxRefundable + 0.005) {
      return res.status(400).json({ error: `refund_amount cannot exceed the returned items' value (₹${maxRefundable.toFixed(2)})` });
    }

    const { data: updated, error: updateError } = await supabaseAdmin()
      .from("return_requests")
      .update({
        status: "approved", refund_amount: amount,
        reviewed_by: req.staff.email, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      })
      .eq("id", ret.id).eq("status", "requested").select().maybeSingle();
    if (updateError) throw updateError;
    if (!updated) return res.status(409).json({ error: "This return has already been reviewed." });

    // Receive the physical stock into a QC-pending batch per returned
    // line - never restock_order() (that's for cancellations, where
    // nothing physically left the warehouse). A stock-intake failure is
    // logged, not blocking: the approval decision itself must stand
    // regardless, same tolerance as every other inventory-accounting
    // side effect in this codebase (restock-on-cancel, post-payment
    // decrement).
    for (const item of ret.return_request_items) {
      if (!item.order_items?.variant_id) continue;
      try {
        await receiveReturnedItem({
          variantId: item.order_items.variant_id, qty: item.qty, returnRequestItemId: item.id, actor: req.staff.email,
        });
      } catch (intakeError) {
        await supabaseAdmin().from("activity_log").insert({
          entity_type: "return_request", entity_id: ret.id, action: "stock_intake_failed", actor: req.staff.email,
          note: (intakeError.message || "receiveReturnedItem failed").slice(0, 500),
        });
      }
    }

    await supabaseAdmin().from("activity_log").insert({
      entity_type: "return_request", entity_id: ret.id, action: "approved", actor: req.staff.email, note: `₹${amount}`,
    });
    await notify("return_approved", { order: ret.orders, dedupeKey: ret.id, refundAmount: amount });
    res.json({ item: updated });
  } catch (e) {
    next(e);
  }
});

// ---- POST /:id/refund - the actual money movement, once approved ----
router.post("/:id/refund", requireStaffAuth, requirePermission("manageReturns"), async (req, res, next) => {
  try {
    const { data: ret, error } = await supabaseAdmin()
      .from("return_requests").select("*, orders(*)").eq("id", req.params.id).maybeSingle();
    if (error) throw error;
    if (!ret) return res.status(404).json({ error: "Return request not found" });
    if (ret.status !== "approved") return res.status(400).json({ error: "Only an approved return can be refunded." });
    if (ret.refund_status === "completed") return res.status(409).json({ error: "This return has already been refunded." });
    if (!ret.refund_amount) return res.status(400).json({ error: "No refund amount was set on approval." });

    const order = ret.orders;

    if (order.payment_method === "prepaid") {
      const payment = await paymentService.getPaymentByOrderId(order.id);
      if (!payment) return res.status(400).json({ error: "No payment record found for this order." });

      let refund;
      try {
        // Reuses the existing, Razorpay-verified refund path unchanged -
        // no parallel refund implementation. createRefund() itself
        // re-validates the amount against the payment's own refundable
        // balance (server/src/services/paymentService.js), a second,
        // independent ceiling on top of the returned-items cap already
        // applied at approval time above.
        refund = await paymentService.createRefund({
          paymentId: payment.id, amountRupees: ret.refund_amount, reason: `Return ${ret.id}`, actorEmail: req.staff.email,
        });
      } catch (refundError) {
        return res.status(refundError.status || 502).json({ error: refundError.message || "Refund failed" });
      }

      const { data: updated, error: updateError } = await supabaseAdmin()
        .from("return_requests")
        .update({
          status: "refunded", refund_status: "completed", refund_method: "razorpay",
          refund_reference: refund.gateway_refund_id, refund_processed_at: new Date().toISOString(),
          refund_processed_by: req.staff.email, updated_at: new Date().toISOString(),
        })
        .eq("id", ret.id).eq("refund_status", "none").select().maybeSingle();
      if (updateError) throw updateError;
      if (!updated) return res.status(409).json({ error: "This return has already been refunded." });
      return res.json({ item: updated });
    }

    // COD - manual/offline refund tracking only, gated by the
    // cod_refund_enabled feature flag (default OFF). Never touches
    // payments/payment_attempts/refunds or the Razorpay refund path -
    // there is no gateway transaction to refund for a COD order.
    const { data: settingRow } = await supabaseAdmin().from("settings").select("value").eq("key", "returns").maybeSingle();
    if (!settingRow?.value?.cod_refund_enabled) {
      return res.status(400).json({ error: "COD refunds are currently disabled. Enable them in Settings first." });
    }

    const { method, reference, notes } = req.body || {};
    if (!["upi", "bank_transfer"].includes(method)) return res.status(400).json({ error: "method must be 'upi' or 'bank_transfer'" });
    if (!reference || !String(reference).trim()) return res.status(400).json({ error: "A reference (UTR/transaction id) is required" });

    const { data: updated, error: updateError } = await supabaseAdmin()
      .from("return_requests")
      .update({
        status: "refunded", refund_status: "completed", refund_method: method,
        refund_reference: String(reference).trim(), refund_notes: notes ? String(notes).trim() : null,
        refund_processed_at: new Date().toISOString(), refund_processed_by: req.staff.email, updated_at: new Date().toISOString(),
      })
      .eq("id", ret.id).eq("refund_status", "none").select().maybeSingle();
    if (updateError) throw updateError;
    if (!updated) return res.status(409).json({ error: "This return has already been refunded." });

    await supabaseAdmin().from("orders").update({ payment_status: "refunded", updated_at: new Date().toISOString() }).eq("id", order.id);
    await supabaseAdmin().from("activity_log").insert({
      entity_type: "return_request", entity_id: ret.id, action: "cod_refund_recorded", actor: req.staff.email,
      note: `₹${ret.refund_amount} via ${method} (${reference})`,
    });
    // COD has no gateway transaction, so this never goes through
    // paymentService.createRefund (the prepaid branch above does, which
    // already fires refund_completed itself) - notify explicitly here
    // instead, keyed off this return request (matches the prepaid path's
    // "at most one refund outcome per return" invariant).
    await notify("refund_completed", { order, dedupeKey: ret.id, refundAmount: ret.refund_amount });
    res.json({ item: updated });
  } catch (e) {
    next(e);
  }
});

export default router;
