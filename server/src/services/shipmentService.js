/**
 * Phase 8B - the only module that writes to shipments/shipment_events/
 * shipment_rto_receipts(_items). Every route (admin create/update/cancel,
 * the courier webhook receiver, RTO receipt) goes through here, same
 * "one module owns the state-transition rules" discipline paymentService.js
 * already established for payments.
 *
 * Locked decision this module exists to enforce: shipment status is
 * AUTHORITATIVE. `orders.status` is a derived reflection of the shipment's
 * lifecycle, kept in sync inside the same transition that changes the
 * shipment - there is no code path anywhere else that sets orders.status
 * to 'shipped'/'delivered'/'rto' (see server/src/routes/orders.js, whose
 * admin status-update endpoint no longer accepts those three values at
 * all).
 *
 * Idempotency pattern mirrors paymentService.markAttemptOutcome exactly: a
 * conditional UPDATE keyed on the row's CURRENT status (`.eq("status",
 * shipment.status)`) means a concurrent duplicate call (two webhook
 * deliveries, or a webhook racing an admin edit) can only ever apply once -
 * the loser sees 0 rows affected and returns the fresh state as a no-op,
 * never a duplicate event/notification/order-sync.
 */
import { supabaseAdmin } from "../db/supabaseClient.js";
import { AppError } from "../utils/apiResponse.js";
import { notify } from "../notify/notificationService.js";
import { SHIPPING_PROVIDERS, SHIPPING_ENVIRONMENTS } from "../integrations/shipping/registry.js";

export const SHIPMENT_STATUSES = [
  "pending", "label_generated", "pickup_scheduled", "picked_up", "in_transit",
  "out_for_delivery", "delivered", "failed_delivery",
  "rto_initiated", "rto_in_transit", "rto_delivered", "cancelled",
];

// A shipment still in one of these states hasn't physically left the
// warehouse yet - cancelling it is a plain "this never happened" undo
// (server-side cancelShipment() below), never a Return/RTO. Anything past
// this point requires the RTO flow instead.
export const PRE_DISPATCH_STATUSES = ["pending", "label_generated", "pickup_scheduled"];

const RTO_RECEIVABLE_STATUSES = ["failed_delivery", "rto_initiated", "rto_in_transit", "rto_delivered"];

// Explicit transition graph - "prevent conflicting/manual invalid
// lifecycle transitions" (Phase 8B locked decision #2). Both the admin
// manual-update route and the webhook receiver go through the SAME
// updateShipmentStatus() below, so neither path can bypass this graph.
// `delivered`/`cancelled`/`rto_delivered` are terminal - a delivered
// shipment that later needs to come back is a Phase 6B return (goods
// already accepted by the customer), never a reopened shipment.
export const SHIPMENT_TRANSITIONS = {
  pending: ["label_generated", "pickup_scheduled", "picked_up", "cancelled"],
  label_generated: ["pickup_scheduled", "picked_up", "cancelled"],
  pickup_scheduled: ["picked_up", "cancelled"],
  picked_up: ["in_transit", "out_for_delivery", "failed_delivery"],
  in_transit: ["out_for_delivery", "failed_delivery"],
  out_for_delivery: ["delivered", "failed_delivery"],
  delivered: [],
  // A failed attempt can retry (courier tries again) or turn into an RTO;
  // "rto_delivered" is also reachable directly from here because the
  // physical warehouse receipt (receiveRtoShipment) is allowed to
  // shortcut whatever intermediate RTO statuses the courier itself did or
  // didn't report - "the package is back" is a fact the courier's own
  // status feed doesn't have to confirm first.
  failed_delivery: ["out_for_delivery", "rto_initiated", "rto_delivered"],
  rto_initiated: ["rto_in_transit", "rto_delivered"],
  rto_in_transit: ["rto_delivered"],
  rto_delivered: [],
  cancelled: [],
};

async function logActivity(entityId, action, actor, note) {
  await supabaseAdmin().from("activity_log").insert({ entity_type: "shipment", entity_id: entityId, action, actor, note });
}

function assertKnownProvider(provider) {
  if (!SHIPPING_PROVIDERS[provider]) throw new AppError(`Unknown shipping provider: ${provider}`, 400, "UNKNOWN_PROVIDER");
}

/**
 * Creates a shipment for an order currently 'processing' and immediately
 * moves the order to 'shipped' - the same single-action UX the old
 * "set status to Shipped + type in a tracking number" admin flow had, now
 * backed by a real shipment row instead of two loose order columns.
 */
export async function createShipment({ orderId, provider, environment, actor }) {
  assertKnownProvider(provider);
  if (!SHIPPING_ENVIRONMENTS.includes(environment)) throw new AppError("Invalid environment", 400, "INVALID_ENVIRONMENT");

  const { data: order, error } = await supabaseAdmin().from("orders").select("*").eq("id", orderId).maybeSingle();
  if (error) throw error;
  if (!order) throw new AppError("Order not found", 404, "ORDER_NOT_FOUND");
  if (order.status !== "processing") {
    throw new AppError("A shipment can only be created for an order that is currently Processing.", 400, "ORDER_NOT_PROCESSING");
  }

  const { data: existing } = await supabaseAdmin()
    .from("shipments").select("id, status").eq("order_id", orderId).neq("status", "cancelled").maybeSingle();
  if (existing) throw new AppError(`This order already has an active shipment (status: ${existing.status}).`, 409, "SHIPMENT_ALREADY_EXISTS");

  const { data: items } = await supabaseAdmin().from("order_items").select("*").eq("order_id", orderId);

  const result = await SHIPPING_PROVIDERS[provider].createShipment(environment, { order, items: items || [] });

  const { data: shipment, error: insertError } = await supabaseAdmin().from("shipments").insert({
    order_id: orderId, provider, environment,
    provider_shipment_id: result?.providerShipmentId || null,
    awb_number: result?.awbNumber || null,
    courier_name: result?.courierName || null,
    label_url: result?.labelUrl || null,
    tracking_url: result?.trackingUrl || null,
    eta: result?.eta || null,
    status: "pending",
    provider_meta: result?.raw || {},
    created_by: actor,
  }).select().single();
  if (insertError) {
    if (insertError.code === "23505") throw new AppError("This order already has an active shipment.", 409, "SHIPMENT_ALREADY_EXISTS");
    throw insertError;
  }

  await supabaseAdmin().from("shipment_events").insert({
    shipment_id: shipment.id, previous_status: null, new_status: "pending", source: "admin", actor, note: "Shipment created",
  });

  const nowIso = new Date().toISOString();
  await supabaseAdmin().from("orders").update({
    status: "shipped", tracking_number: shipment.awb_number || order.tracking_number, updated_at: nowIso,
  }).eq("id", orderId);

  await logActivity(shipment.id, "created", actor, `order ${order.order_number}, provider ${provider}`);

  await notify("order_shipped", {
    order: { ...order, status: "shipped", tracking_number: shipment.awb_number || order.tracking_number },
    trackingNumber: shipment.awb_number,
  });

  return shipment;
}

/** Patches staff-entered shipment metadata (AWB/courier/label/tracking
 * URL/ETA) - never a status change (see updateShipmentStatus for that).
 * Mirrors orders.tracking_number onto the shipment's own AWB so any
 * legacy reader of that column (notification templates, old exports)
 * keeps seeing a value without needing its own migration. */
export async function updateShipmentDetails({ shipmentId, awbNumber, courierName, labelUrl, trackingUrl, eta, actor }) {
  const patch = { updated_at: new Date().toISOString() };
  if (awbNumber !== undefined) patch.awb_number = awbNumber || null;
  if (courierName !== undefined) patch.courier_name = courierName || null;
  if (labelUrl !== undefined) patch.label_url = labelUrl || null;
  if (trackingUrl !== undefined) patch.tracking_url = trackingUrl || null;
  if (eta !== undefined) patch.eta = eta || null;

  const { data: updated, error } = await supabaseAdmin().from("shipments").update(patch).eq("id", shipmentId).select().maybeSingle();
  if (error) throw error;
  if (!updated) throw new AppError("Shipment not found", 404, "SHIPMENT_NOT_FOUND");

  if (awbNumber !== undefined) {
    await supabaseAdmin().from("orders").update({ tracking_number: awbNumber || null, updated_at: patch.updated_at }).eq("id", updated.order_id);
  }
  await logActivity(shipmentId, "details_updated", actor);
  return updated;
}

/**
 * The transition engine - both the admin manual-update route and the
 * webhook receiver call this, so SHIPMENT_TRANSITIONS is enforced exactly
 * once, in exactly one place, regardless of who initiated the change.
 */
export async function updateShipmentStatus({ shipmentId, newStatus, actor, source, note, rawPayload }) {
  if (!SHIPMENT_STATUSES.includes(newStatus)) throw new AppError(`Invalid shipment status: ${newStatus}`, 400, "INVALID_STATUS");

  const { data: shipment, error } = await supabaseAdmin().from("shipments").select("*, orders(*)").eq("id", shipmentId).maybeSingle();
  if (error) throw error;
  if (!shipment) throw new AppError("Shipment not found", 404, "SHIPMENT_NOT_FOUND");

  if (shipment.status === newStatus) {
    // Idempotent resend (e.g. a courier redelivering the same webhook
    // event under a different event id) - a safe no-op, not an error.
    return { shipment, changed: false };
  }
  const allowed = SHIPMENT_TRANSITIONS[shipment.status] || [];
  if (!allowed.includes(newStatus)) {
    throw new AppError(`Cannot move a shipment from '${shipment.status}' to '${newStatus}'.`, 400, "INVALID_TRANSITION");
  }

  const nowIso = new Date().toISOString();
  const patch = { status: newStatus, updated_at: nowIso };
  if (newStatus === "out_for_delivery") patch.out_for_delivery_at = nowIso;
  if (newStatus === "delivered") patch.delivered_at = nowIso;
  if (newStatus === "failed_delivery") patch.failed_delivery_at = nowIso;
  if (newStatus === "rto_initiated") patch.rto_initiated_at = nowIso;
  if (newStatus === "rto_delivered") patch.rto_delivered_at = nowIso;
  if (newStatus === "cancelled") patch.cancelled_at = nowIso;
  if (note) patch.last_status_reason = note;

  // Conditional update keyed on the status we just read - the same
  // optimistic-concurrency guard as paymentService.markAttemptOutcome and
  // orderDetailPublic.js's customer cancel, so two concurrent callers can
  // never both "win" the same transition.
  const { data: updated, error: updateError } = await supabaseAdmin()
    .from("shipments").update(patch).eq("id", shipmentId).eq("status", shipment.status).select().maybeSingle();
  if (updateError) throw updateError;
  if (!updated) {
    const { data: fresh } = await supabaseAdmin().from("shipments").select("*").eq("id", shipmentId).single();
    return { shipment: fresh, changed: false };
  }

  await supabaseAdmin().from("shipment_events").insert({
    shipment_id: shipmentId, previous_status: shipment.status, new_status: newStatus,
    source, actor: actor || null, note: note || null, raw_payload: rawPayload || null,
  });

  const order = shipment.orders;
  if (newStatus === "delivered" && order.status !== "delivered") {
    await supabaseAdmin().from("orders").update({ status: "delivered", delivered_at: nowIso, updated_at: nowIso }).eq("id", order.id);
  } else if (["rto_initiated", "rto_in_transit", "rto_delivered"].includes(newStatus) && order.status !== "rto") {
    await supabaseAdmin().from("orders").update({ status: "rto", updated_at: nowIso }).eq("id", order.id);
  }

  // Notifications - never block the transition itself (notify() already
  // never throws). dedupeKey defaults to order.id inside notify(), so
  // failed_delivery followed later by rto_initiated for the SAME order
  // still only ever sends this event once - no explicit dedupe bookkeeping
  // needed here.
  const orderForNotify = { ...order, tracking_number: updated.awb_number || order.tracking_number };
  if (newStatus === "out_for_delivery") {
    await notify("order_out_for_delivery", { order: orderForNotify, trackingNumber: updated.awb_number });
  } else if (newStatus === "delivered") {
    await notify("order_delivered", { order: orderForNotify });
  } else if (newStatus === "failed_delivery" || newStatus === "rto_initiated") {
    await notify("order_delivery_failed", { order: orderForNotify, reason: note });
  }

  await logActivity(shipmentId, `status -> ${newStatus}`, actor || `webhook:${shipment.provider}`);

  return { shipment: updated, changed: true };
}

/** Only ever allowed pre-dispatch - a shipment that has already been
 * picked up represents something physically true in the warehouse/with
 * the courier, so "cancelling" it here would be a lie; RTO is the correct
 * (and only) way to unwind a shipment that has actually left. */
export async function cancelShipment({ shipmentId, actor }) {
  const { data: shipment, error } = await supabaseAdmin().from("shipments").select("*").eq("id", shipmentId).maybeSingle();
  if (error) throw error;
  if (!shipment) throw new AppError("Shipment not found", 404, "SHIPMENT_NOT_FOUND");
  if (!PRE_DISPATCH_STATUSES.includes(shipment.status)) {
    throw new AppError(
      `This shipment has already been picked up (current status: ${shipment.status}) and cannot be cancelled here - use the RTO flow once it comes back instead.`,
      400, "NOT_CANCELLABLE"
    );
  }

  try {
    await SHIPPING_PROVIDERS[shipment.provider]?.cancelShipment?.(shipment.environment, shipment.provider_shipment_id);
  } catch (e) {
    await logActivity(shipmentId, "provider_cancel_failed", actor, (e.message || "").slice(0, 300));
  }

  const nowIso = new Date().toISOString();
  const { data: updated, error: updateError } = await supabaseAdmin()
    .from("shipments").update({ status: "cancelled", cancelled_at: nowIso, updated_at: nowIso })
    .eq("id", shipmentId).eq("status", shipment.status).select().maybeSingle();
  if (updateError) throw updateError;
  if (!updated) throw new AppError("This shipment can no longer be cancelled.", 409, "NOT_CANCELLABLE");

  await supabaseAdmin().from("shipment_events").insert({
    shipment_id: shipmentId, previous_status: shipment.status, new_status: "cancelled", source: "admin", actor, note: "Shipment cancelled",
  });

  const { data: order } = await supabaseAdmin().from("orders").select("id, status").eq("id", shipment.order_id).maybeSingle();
  if (order?.status === "shipped") {
    await supabaseAdmin().from("orders").update({ status: "processing", updated_at: nowIso }).eq("id", order.id);
  }
  await logActivity(shipmentId, "cancelled", actor);
  return updated;
}

/** One QC-pending batch per order line, exactly Phase 6B's
 * receiveReturnedItem() pattern - reuses Phase 5A's adjust_batch_quantity()
 * completely unchanged. A 'pending' batch is never sellable, so this
 * writes a full ledger entry without touching product_variants.stock at
 * all; only a later admin QC pass (existing Inventory page) can move it
 * into sellable stock. */
async function receiveRtoItem({ variantId, qty, shipmentId, orderItemId, actor }) {
  const { data: batch, error: insertError } = await supabaseAdmin()
    .from("batches")
    .insert({
      variant_id: variantId, batch_number: `RTO-${shipmentId}-${orderItemId}`,
      quality_status: "pending", batch_status: "active", created_by: actor,
    })
    .select().single();
  if (insertError) throw insertError;

  const { error: adjustError } = await supabaseAdmin().rpc("adjust_batch_quantity", {
    p_batch_id: batch.id, p_delta: qty, p_reason: "rto_received", p_actor: actor,
  });
  if (adjustError) throw adjustError;
  return batch;
}

/** The physical "package is back in the warehouse" action - deliberately
 * separate from whatever status the courier itself has reported (a
 * shipment can be marked RTO-received directly from 'failed_delivery' if
 * the package physically shows up before the courier's own tracking feed
 * catches up). Creates one QC-pending batch per order line and a single
 * shipment_rto_receipts row (unique per shipment - can only ever run
 * once). Never calls restock_order() (Phase 5B) - that is exclusively for
 * cancellations where nothing physically left the building. */
export async function receiveRtoShipment({ shipmentId, actor }) {
  const { data: shipment, error } = await supabaseAdmin().from("shipments").select("*").eq("id", shipmentId).maybeSingle();
  if (error) throw error;
  if (!shipment) throw new AppError("Shipment not found", 404, "SHIPMENT_NOT_FOUND");
  if (!RTO_RECEIVABLE_STATUSES.includes(shipment.status)) {
    throw new AppError(`This shipment is not in an RTO-receivable state (current status: ${shipment.status}).`, 400, "NOT_RTO_RECEIVABLE");
  }

  const { data: items, error: itemsError } = await supabaseAdmin().from("order_items").select("*").eq("order_id", shipment.order_id);
  if (itemsError) throw itemsError;

  const { data: receipt, error: receiptError } = await supabaseAdmin()
    .from("shipment_rto_receipts").insert({ shipment_id: shipmentId, order_id: shipment.order_id, received_by: actor }).select().single();
  if (receiptError) {
    if (receiptError.code === "23505") throw new AppError("This shipment's RTO has already been received.", 409, "ALREADY_RECEIVED");
    throw receiptError;
  }

  for (const item of items || []) {
    if (!item.variant_id || !item.qty) continue;
    try {
      const batch = await receiveRtoItem({ variantId: item.variant_id, qty: item.qty, shipmentId, orderItemId: item.id, actor });
      await supabaseAdmin().from("shipment_rto_receipt_items").insert({ receipt_id: receipt.id, order_item_id: item.id, qty: item.qty, batch_id: batch.id });
    } catch (intakeError) {
      await logActivity(shipmentId, "rto_intake_failed", actor, (intakeError.message || "receiveRtoItem failed").slice(0, 500));
    }
  }

  if (shipment.status !== "rto_delivered") {
    await updateShipmentStatus({ shipmentId, newStatus: "rto_delivered", actor, source: "admin", note: "Physically received at warehouse" });
  }

  await logActivity(shipmentId, "rto_received", actor);
  return receipt;
}

/**
 * Records a courier webhook event and processes it idempotently - same
 * `unique(gateway, event_id)`-on-webhook_events guard paymentService.js's
 * processWebhookEvent already uses (a duplicate delivery fails the insert
 * with 23505, treated as "already processed", never as an error). The
 * caller (server/src/routes/shipmentWebhooksPublic.js) is responsible for
 * signature verification and for mapping the provider's own raw status
 * string to one of SHIPMENT_STATUSES via that provider's own
 * mapWebhookStatus() - this function only ever deals in the ALREADY-MAPPED
 * internal status, keeping provider-specific parsing fully isolated from
 * shipment/order business logic.
 */
export async function processShipmentWebhookEvent({ provider, eventId, eventType, payload, signatureValid, newStatus, providerShipmentId, awbNumber }) {
  const { error: insertError } = await supabaseAdmin().from("webhook_events").insert({
    gateway: provider, event_id: eventId, event_type: eventType, payload, signature_valid: signatureValid, processing_status: "RECEIVED",
  });
  if (insertError) {
    if (insertError.code === "23505") return { duplicate: true };
    throw insertError;
  }

  if (!signatureValid) {
    await updateWebhookStatus(provider, eventId, "ERROR", "Invalid signature");
    return { duplicate: false, processed: false, reason: "invalid_signature" };
  }
  if (!newStatus) {
    await updateWebhookStatus(provider, eventId, "IGNORED", `Unhandled/unmapped event type: ${eventType}`);
    return { duplicate: false, processed: false, reason: "unmapped_status" };
  }

  let query = supabaseAdmin().from("shipments").select("id").eq("provider", provider);
  if (providerShipmentId) query = query.eq("provider_shipment_id", providerShipmentId);
  else if (awbNumber) query = query.eq("awb_number", awbNumber);
  else {
    await updateWebhookStatus(provider, eventId, "IGNORED", "No shipment identifier in payload");
    return { duplicate: false, processed: false, reason: "no_identifier" };
  }
  const { data: shipment } = await query.maybeSingle();
  if (!shipment) {
    await updateWebhookStatus(provider, eventId, "IGNORED", "No matching local shipment");
    return { duplicate: false, processed: false, reason: "shipment_not_found" };
  }

  try {
    await updateShipmentStatus({ shipmentId: shipment.id, newStatus, source: "webhook", rawPayload: payload });
    await updateWebhookStatus(provider, eventId, "PROCESSED", null);
    return { duplicate: false, processed: true };
  } catch (e) {
    await updateWebhookStatus(provider, eventId, "ERROR", (e.message || "transition failed").slice(0, 300));
    return { duplicate: false, processed: false, reason: "transition_failed" };
  }
}

async function updateWebhookStatus(gateway, eventId, status, note) {
  await supabaseAdmin().from("webhook_events").update({ processing_status: status, processing_note: note }).eq("gateway", gateway).eq("event_id", eventId);
}
