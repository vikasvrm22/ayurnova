import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { parsePagination, sanitizeOrFilterValue } from "../validation/validators.js";
import { notify } from "../notify/notificationService.js";

const router = Router();

const ORDER_STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled"];

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
    const { status, tracking_number } = req.body || {};
    if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${ORDER_STATUSES.join(", ")}` });

    const { data: existing } = await supabaseAdmin().from("orders").select("status").eq("id", req.params.id).single();

    // Phase 5B: cancelling an order restocks exactly the batch(es)
    // originally allocated to it (never re-derived via FEFO), each
    // producing its own auditable ledger entry - see restock_order() in
    // 0007_phase5b_fefo_allocation.sql. Only on a genuine transition INTO
    // cancelled (never on a no-op re-save of an already-cancelled order),
    // so this can never double-restock. An order that was never allocated
    // (e.g. a prepaid order cancelled before payment ever succeeded) has
    // no allocation rows, so restock_order() is correctly a no-op for it.
    //
    // A restock failure is logged, not thrown - cancelling an order is
    // pre-existing Phase 1 functionality staff already rely on working;
    // an inventory-accounting side effect (or, pre-migration, the RPC not
    // existing yet) must never block the cancellation itself, same risk
    // tolerance as decrementStockForOrder's post-payment accounting.
    if (status === "cancelled" && existing?.status !== "cancelled") {
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

    const patch = { status, updated_at: new Date().toISOString() };
    if (tracking_number !== undefined) patch.tracking_number = tracking_number;
    // Phase 6B: delivered_at is set exactly once, on the genuine
    // transition INTO delivered - never overwritten by a later edit (e.g.
    // a tracking-number correction after delivery). This is the
    // authoritative timestamp the customer return-eligibility window
    // (server/src/routes/returnsPublic.js) is computed from; orders.
    // updated_at cannot be used for that, since it changes on any edit.
    //
    // Merged into the SAME atomic update as the core status change (not a
    // separate follow-up write): a delivered_at write that could silently
    // fail independently of the status write would let status='delivered'
    // persist with delivered_at left null, permanently blocking that
    // order's real return eligibility with no visible error to anyone.
    // One statement - it either sets both together or the whole request
    // fails and the caller sees it, exactly as every other field in this
    // patch already behaves.
    if (status === "delivered" && existing?.status !== "delivered") {
      patch.delivered_at = patch.updated_at;
    }

    const { data, error } = await supabaseAdmin().from("orders").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;

    await supabaseAdmin().from("activity_log").insert({
      entity_type: "order", entity_id: req.params.id, action: `status -> ${status}`, actor: req.staff.email,
    });

    // Phase 7: customer notification on a genuine status transition only
    // (never on a no-op re-save of the same status, e.g. re-entering the
    // same tracking number) - awaited but internally bulletproofed
    // against ever throwing (see notificationService.js), same "must
    // never block the real action" tolerance as restock_order()/
    // delivered_at above.
    if (existing?.status !== status) {
      if (status === "shipped") await notify("order_shipped", { order: data, trackingNumber: data.tracking_number });
      else if (status === "delivered") await notify("order_delivered", { order: data });
      else if (status === "cancelled") await notify("order_cancelled", { order: data });
    }

    res.json({ order: data });
  } catch (e) {
    next(e);
  }
});

export default router;
