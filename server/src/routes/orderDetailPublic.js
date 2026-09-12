/**
 * Phase 6A - customer order detail + self-service cancellation. Mounted at
 * /api/public/my-orders, alongside (not replacing) public.js's existing
 * GET /api/public/my-orders list route - that route is untouched; this
 * file only adds the /:id sub-routes, which publicRoutes never defined.
 *
 * Same {success,data}/AppError/asyncRoute/catalogErrorHandler envelope as
 * catalogPublic.js/wellnessPublic.js (the project's current preferred
 * convention for new public endpoints) - public.js's own /my-orders stays
 * on its original {items}/{error} shape unchanged, per that file's
 * documented "existing routes keep their original response shapes" rule.
 *
 * Deliberately NOT a copy of the admin order-detail route
 * (server/src/routes/orders.js GET /:id): that route returns raw
 * payment_attempts/refunds rows (gateway ids, full webhook payloads) and
 * Phase 5B batch_allocations (operational inventory detail) - none of
 * that belongs in a customer response. This route hand-picks only
 * customer-safe fields, some already sitting right on the order row
 * itself (payment_method/payment_status), so it never even queries the
 * payments/payment_attempts/refunds tables.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireCustomer } from "../auth/customerAuth.js";
import { AppError, sendOk, asyncRoute, catalogErrorHandler } from "../utils/apiResponse.js";

const router = Router();
router.use(requireCustomer);

function toCustomerOrder(order) {
  return {
    id: order.id,
    orderNumber: order.order_number,
    status: order.status,
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status,
    subtotal: order.subtotal,
    shippingFee: order.shipping_fee,
    discount: order.discount,
    total: order.total,
    couponCode: order.coupon_code,
    trackingNumber: order.tracking_number,
    shippingAddress: order.shipping_address,
    createdAt: order.created_at,
    // The only business rule a customer needs to know is whether the
    // Cancel action is available right now - the actual enforcement
    // happens server-side again at cancel time regardless, this is a UI
    // hint only (same "hint, never authoritative" spirit as Phase 5C's
    // FEFO "Next" badge).
    canCancel: order.status === "pending",
  };
}

// ---- GET /api/public/my-orders/:id ----
router.get(
  "/:id",
  asyncRoute(async (req, res) => {
    // Filtering by customer_id in the query itself (not a fetch-then-
    // compare) means an order that exists but isn't owned by this
    // customer returns the exact same 404 as one that doesn't exist at
    // all - never reveals order existence to a non-owner.
    const { data: order, error } = await supabaseAdmin()
      .from("orders").select("*").eq("id", req.params.id).eq("customer_id", req.customer.id).maybeSingle();
    if (error) throw error;
    if (!order) throw new AppError("Order not found", 404, "ORDER_NOT_FOUND");

    const { data: items } = await supabaseAdmin()
      .from("order_items").select("title_snapshot, variant_label_snapshot, price_snapshot, qty, subtotal").eq("order_id", order.id);

    sendOk(res, {
      ...toCustomerOrder(order),
      items: (items || []).map((i) => ({
        title: i.title_snapshot, variantLabel: i.variant_label_snapshot, price: i.price_snapshot, qty: i.qty, subtotal: i.subtotal,
      })),
    });
  })
);

// ---- POST /api/public/my-orders/:id/cancel ----
router.post(
  "/:id/cancel",
  asyncRoute(async (req, res) => {
    const { data: order, error } = await supabaseAdmin()
      .from("orders").select("id, status, customer_id").eq("id", req.params.id).eq("customer_id", req.customer.id).maybeSingle();
    if (error) throw error;
    if (!order) throw new AppError("Order not found", 404, "ORDER_NOT_FOUND");
    if (order.status !== "pending") {
      throw new AppError(
        "This order has already started processing and can no longer be cancelled here - please contact support.",
        400, "NOT_CANCELLABLE"
      );
    }

    // Atomic conditional update - only flips status if it is STILL
    // "pending" at write time. A concurrent duplicate cancel request (or
    // a staff member processing the order in the same instant) finds 0
    // rows matched and falls into the 409 below instead of double-
    // cancelling/double-restocking - the same conditional-update
    // idempotency pattern paymentService.markAttemptOutcome already uses.
    const { data: updated, error: updateError } = await supabaseAdmin()
      .from("orders")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", order.id).eq("customer_id", req.customer.id).eq("status", "pending")
      .select().maybeSingle();
    if (updateError) throw updateError;
    if (!updated) throw new AppError("This order can no longer be cancelled.", 409, "NOT_CANCELLABLE");

    const actor = `customer(${req.customer.email})`;

    // Reuses Phase 5B's restock_order() RPC completely unchanged - same
    // batch(es) that were actually allocated, same auditable ledger entry
    // per batch, same "log, don't block" tolerance the admin cancellation
    // route already applies for a restock failure (cancelling the order
    // is the customer-visible action that must succeed; an inventory-
    // accounting hiccup is a follow-up concern for staff, not a reason to
    // fail the customer's cancellation).
    const { error: restockError } = await supabaseAdmin().rpc("restock_order", {
      p_order_id: order.id, p_actor: actor, p_reason: "customer_cancelled",
    });
    if (restockError) {
      await supabaseAdmin().from("activity_log").insert({
        entity_type: "order", entity_id: order.id, action: "restock_failed", actor,
        note: (restockError.message || "restock_order RPC failed").slice(0, 500),
      });
    }
    await supabaseAdmin().from("activity_log").insert({
      entity_type: "order", entity_id: order.id, action: "status -> cancelled (customer)", actor,
    });

    sendOk(res, { id: updated.id, status: updated.status });
  })
);

router.use(catalogErrorHandler);

export default router;
