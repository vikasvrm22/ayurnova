import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { parsePagination, sanitizeOrFilterValue } from "../validation/validators.js";
import { notify } from "../notify/notificationService.js";
import * as shipmentService from "../services/shipmentService.js";

const router = Router();

// Every value this column can ever hold (for filtering GET / below) - 'rto'
// (Phase 8B) is only ever set by shipmentService.js, never by this route.
const ORDER_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled", "rto"];
// Phase 8B: 'shipped'/'delivered'/'rto' are now derived exclusively from a
// shipment's lifecycle (server/src/services/shipmentService.js) - the
// locked "shipment status is authoritative" rule. This admin endpoint can
// still freely move an order between the three PRE-shipment states.
const ADMIN_SETTABLE_STATUSES = ["pending", "processing", "cancelled"];

router.get("/", requireStaffAuth, async (req, res, next) => {
  try {
    const { q, status } = req.query;
    let query = supabaseAdmin().from("orders").select("*", { count: "exact" }).order("created_at", { ascending: false });
    if (status && ORDER_STATUSES.includes(status)) query = query.eq("status", status);

    // Phase 0 §7.3: `q` used to be interpolated directly into this PostgREST
    // `.or()` filter-expression string - a crafted value containing `,`/`.`/
    // `()` could alter which columns/conditions get evaluated. Fixed by
    // allowlisting `q` down to only the characters a real order number,
    // email, or phone number can contain before it ever reaches `.or()`.
    const safeQ = sanitizeOrFilterValue(q);
    if (safeQ) query = query.or(`order_number.ilike.%${safeQ}%,guest_email.ilike.%${safeQ}%,guest_phone.ilike.%${safeQ}%`);

    const { page: p, pageSize: ps } = parsePagination(req.query);
    query = query.range((p - 1) * ps, p * ps - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ items: data, total: count, page: p, pageSize: ps });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireStaffAuth, async (req, res, next) => {
  try {
    const { data: order, error } = await supabaseAdmin().from("orders").select("*").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Not found" });
    const { data: items } = await supabaseAdmin().from("order_items").select("*").eq("order_id", req.params.id);

    // Phase 5B: attach each item's batch-allocation trail (which batch(es)
    // fulfilled it, and how much from each) for traceability - read-only,
    // same JSON envelope, no new endpoint needed.
    const itemIds = (items || []).map((i) => i.id);
    let allocationsByItem = {};
    if (itemIds.length) {
      const { data: allocations } = await supabaseAdmin()
        .from("order_item_batch_allocations").select("*").in("order_item_id", itemIds);
      allocationsByItem = (allocations || []).reduce((acc, a) => {
        (acc[a.order_item_id] = acc[a.order_item_id] || []).push(a);
        return acc;
      }, {});
    }
    const itemsWithAllocations = (items || []).map((i) => ({ ...i, batch_allocations: allocationsByItem[i.id] || [] }));

    // Phase 2: surface payment + attempt history alongside the order, so
    // the admin order-detail page doesn't need a second round trip. Only
    // present for prepaid orders that have actually started a payment -
    // COD orders and abandoned-before-any-attempt prepaid orders have none.
    let payment = null;
    const { data: paymentRow } = await supabaseAdmin().from("payments").select("*").eq("order_id", req.params.id).maybeSingle();
    if (paymentRow) {
      const { data: attempts } = await supabaseAdmin()
        .from("payment_attempts").select("*").eq("payment_id", paymentRow.id).order("attempt_number", { ascending: true });
      const { data: refunds } = await supabaseAdmin()
        .from("refunds").select("*").eq("payment_id", paymentRow.id).order("created_at", { ascending: false });
      payment = { ...paymentRow, attempts: attempts || [], refunds: refunds || [] };
    }

    res.json({ order, items: itemsWithAllocations, payment });
  } catch (e) {
    next(e);
  }
});

router.put("/:id/status", requireStaffAuth, requirePermission("manageOrders"), async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${ORDER_STATUSES.join(", ")}` });
    if (!ADMIN_SETTABLE_STATUSES.includes(status)) {
      return res.status(400).json({
        error: "'shipped', 'delivered' and 'rto' are now driven by the Shipment section - create or update a shipment instead of setting this directly.",
      });
    }

    const { data: existing } = await supabaseAdmin().from("orders").select("status").eq("id", req.params.id).single();
    if (!existing) return res.status(404).json({ error: "Order not found" });

    // Phase 8B lifecycle-safety fix: an order in 'shipped'/'delivered'/
    // 'rto' always has a real shipment row behind it now (those three
    // states are unreachable any other way - see ADMIN_SETTABLE_STATUSES
    // above), so this is the one guard that actually needs to inspect it.
    // A shipment still pre-dispatch (nothing physically left the
    // warehouse) is cancelled right along with the order - anything past
    // that point must be resolved via the Shipment section's own RTO flow
    // first, never silently overridden by a raw status flip (the exact
    // "delivered/shipped -> cancelled inconsistency" the Phase 8B audit
    // flagged in this route).
    if (status === "cancelled" && existing.status !== "cancelled") {
      const { data: activeShipment } = await supabaseAdmin()
        .from("shipments").select("*").eq("order_id", req.params.id).neq("status", "cancelled").maybeSingle();
      if (activeShipment) {
        if (shipmentService.PRE_DISPATCH_STATUSES.includes(activeShipment.status)) {
          await shipmentService.cancelShipment({ shipmentId: activeShipment.id, actor: req.staff.email });
        } else {
          return res.status(409).json({
            error: `This order has an active shipment (status: ${activeShipment.status}) that has already left processing. Resolve it from the Shipment section (RTO) before cancelling the order.`,
          });
        }
      }
    }

    // Phase 9B (P2-1): atomic conditional update - only flips status if it
    // is STILL at the status this request read at the top of the handler.
    // A second, near-simultaneous admin cancel request on the same order
    // (the race the Phase 9 audit flagged, unlike the already-guarded
    // customer-facing cancel route) finds 0 rows matched and gets a 409
    // instead of both requests independently restocking the same order.
    const patch = { status, updated_at: new Date().toISOString() };
    const { data, error } = await supabaseAdmin()
      .from("orders").update(patch).eq("id", req.params.id).eq("status", existing.status)
      .select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: "This order was just modified by another request. Please refresh and try again." });

    // Phase 5B: cancelling an order restocks exactly the batch(es)
    // originally allocated to it (never re-derived via FEFO), each
    // producing its own auditable ledger entry - see restock_order() in
    // 0007_phase5b_fefo_allocation.sql. Only runs after the conditional
    // update above has actually won the transition INTO cancelled (never
    // on a no-op re-save of an already-cancelled order, and never twice
    // for the same order), so this can never double-restock. An order
    // that was never allocated (e.g. a prepaid order cancelled before
    // payment ever succeeded) has no allocation rows, so restock_order()
    // is correctly a no-op for it.
    //
    // A restock failure is logged, not thrown - cancelling an order is
    // pre-existing Phase 1 functionality staff already rely on working;
    // an inventory-accounting side effect (or, pre-migration, the RPC not
    // existing yet) must never block the cancellation itself, same risk
    // tolerance as decrementStockForOrder's post-payment accounting.
    if (status === "cancelled" && existing.status !== "cancelled") {
      const { error: restockError } = await supabaseAdmin().rpc("restock_order", {
        p_order_id: req.params.id, p_actor: req.staff.email, p_reason: "order_cancelled",
      });
      if (restockError) {
        await supabaseAdmin().from("activity_log").insert({
          entity_type: "order", entity_id: req.params.id, action: "restock_failed", actor: req.staff.email,
          note: (restockError.message || "restock_order RPC failed").slice(0, 500),
        });
      }
    }

    await supabaseAdmin().from("activity_log").insert({
      entity_type: "order", entity_id: req.params.id, action: `status -> ${status}`, actor: req.staff.email,
    });

    // Phase 7: customer notification on a genuine status transition only -
    // awaited but internally bulletproofed against ever throwing (see
    // notificationService.js), same "must never block the real action"
    // tolerance as restock_order() above. order_shipped/order_delivered
    // are now fired exclusively by shipmentService.js (Phase 8B).
    if (existing?.status !== status && status === "cancelled") {
      await notify("order_cancelled", { order: data });
    }

    res.json({ order: data });
  } catch (e) {
    next(e);
  }
});

export default router;
