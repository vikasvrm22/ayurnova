/**
 * Phase 6B - customer return requests. Same {success,data}/AppError/
 * asyncRoute/catalogErrorHandler convention as Phase 6A's
 * orderDetailPublic.js/addressesPublic.js. Every eligibility rule (order
 * must be delivered, within 7 calendar days of orders.delivered_at,
 * reason from the fixed taxonomy, qty within what's actually still
 * returnable) is re-validated here server-side regardless of what the
 * client claims - the same "never trust the client" principle checkout
 * itself has always followed.
 *
 * Deliberately exposes only customer-safe fields: refund_reference
 * (Razorpay refund id / COD UTR) and refund_notes (staff notes) are never
 * returned here - see toCustomerReturn() below.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireCustomer } from "../auth/customerAuth.js";
import { AppError, sendOk, asyncRoute, catalogErrorHandler } from "../utils/apiResponse.js";
import { isValidUUID, sanitizeText } from "../validation/validators.js";

const router = Router();
router.use(requireCustomer);

const RETURN_REASONS = ["damaged", "leaked", "defective", "wrong_product", "expired", "tampered", "missing_item"];
const RETURN_WINDOW_DAYS = 7;

function toCustomerReturn(r) {
  return {
    id: r.id,
    orderId: r.order_id,
    status: r.status,
    note: r.note,
    rejectionReason: r.rejection_reason,
    refundAmount: r.refund_amount,
    refundMethod: r.refund_method,
    refundStatus: r.refund_status,
    refundProcessedAt: r.refund_processed_at,
    createdAt: r.created_at,
    items: (r.return_request_items || []).map((i) => ({ orderItemId: i.order_item_id, qty: i.qty, reason: i.reason })),
  };
}

// ---- GET /api/public/returns (own return history) ----
router.get(
  "/",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabaseAdmin()
      .from("return_requests").select("*, return_request_items(*)").eq("customer_id", req.customer.id).order("created_at", { ascending: false });
    if (error) throw error;
    sendOk(res, { items: (data || []).map(toCustomerReturn) });
  })
);

// ---- GET /api/public/returns/:id ----
router.get(
  "/:id",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabaseAdmin()
      .from("return_requests").select("*, return_request_items(*)").eq("id", req.params.id).eq("customer_id", req.customer.id).maybeSingle();
    if (error) throw error;
    if (!data) throw new AppError("Return request not found", 404, "RETURN_NOT_FOUND");
    sendOk(res, toCustomerReturn(data));
  })
);

// ---- POST /api/public/returns ----
router.post(
  "/",
  asyncRoute(async (req, res) => {
    const { order_id, note, items } = req.body || {};
    if (!order_id || !isValidUUID(order_id)) throw new AppError("A valid order_id is required", 400, "INVALID_ORDER");
    if (!Array.isArray(items) || !items.length) throw new AppError("At least one item is required", 400, "NO_ITEMS");

    const { data: order, error: orderError } = await supabaseAdmin()
      .from("orders").select("id, status, delivered_at, customer_id").eq("id", order_id).eq("customer_id", req.customer.id).maybeSingle();
    if (orderError) throw orderError;
    if (!order) throw new AppError("Order not found", 404, "ORDER_NOT_FOUND");
    if (order.status !== "delivered" || !order.delivered_at) {
      throw new AppError("Only delivered orders can be returned.", 400, "NOT_ELIGIBLE");
    }
    const daysSinceDelivery = (Date.now() - new Date(order.delivered_at).getTime()) / (24 * 60 * 60 * 1000);
    if (daysSinceDelivery > RETURN_WINDOW_DAYS) {
      throw new AppError(`The ${RETURN_WINDOW_DAYS}-day return window for this order has passed.`, 400, "WINDOW_EXPIRED");
    }

    const orderItemIds = items.map((i) => i?.order_item_id).filter(Boolean);
    if (orderItemIds.length !== items.length) throw new AppError("Each item requires an order_item_id", 400, "INVALID_ITEM");
    const { data: orderItems, error: oiError } = await supabaseAdmin()
      .from("order_items").select("id, qty, order_id").in("id", orderItemIds);
    if (oiError) throw oiError;

    const cleanItems = [];
    for (const requested of items) {
      const oi = (orderItems || []).find((o) => o.id === requested.order_item_id);
      if (!oi || oi.order_id !== order.id) throw new AppError("One or more items do not belong to this order.", 400, "INVALID_ITEM");
      const qty = Number(requested.qty);
      if (!Number.isInteger(qty) || qty <= 0) throw new AppError("Each item's qty must be a positive whole number.", 400, "INVALID_QTY");
      if (!RETURN_REASONS.includes(requested.reason)) {
        throw new AppError(`reason must be one of: ${RETURN_REASONS.join(", ")}`, 400, "INVALID_REASON");
      }

      // Remaining returnable qty = original qty minus whatever is already
      // covered by a non-rejected return request for this same item - a
      // rejected request frees its qty back up for resubmission.
      const { data: existing } = await supabaseAdmin()
        .from("return_request_items").select("qty, return_requests!inner(status)").eq("order_item_id", oi.id);
      const alreadyRequested = (existing || [])
        .filter((e) => e.return_requests?.status !== "rejected")
        .reduce((sum, e) => sum + e.qty, 0);
      const remaining = oi.qty - alreadyRequested;
      if (qty > remaining) {
        throw new AppError(`Only ${Math.max(0, remaining)} unit(s) of this item can still be returned.`, 400, "QTY_EXCEEDS_REMAINING");
      }
      cleanItems.push({ order_item_id: oi.id, qty, reason: requested.reason });
    }

    const { data: returnRequest, error: insertError } = await supabaseAdmin()
      .from("return_requests")
      .insert({ order_id: order.id, customer_id: req.customer.id, note: note ? sanitizeText(String(note).trim()).slice(0, 1000) : null })
      .select().single();
    if (insertError) throw insertError;

    const itemRows = cleanItems.map((i) => ({ ...i, return_request_id: returnRequest.id }));
    const { error: itemsInsertError } = await supabaseAdmin().from("return_request_items").insert(itemRows);
    if (itemsInsertError) throw itemsInsertError;

    await supabaseAdmin().from("activity_log").insert({
      entity_type: "return_request", entity_id: returnRequest.id, action: "requested", actor: `customer(${req.customer.email})`,
    });

    sendOk(res, { id: returnRequest.id, status: returnRequest.status }, undefined, 201);
  })
);

router.use(catalogErrorHandler);

export default router;
