/**
 * Phase 7 - the single reusable dispatcher every order/return/refund code
 * path calls into to notify a customer, across whichever of
 * email/SMS/WhatsApp are actually configured (server/src/integrations/
 * email|sms|whatsapp/provider.js - each independently enabled/disabled
 * via the existing generic Integration Management foundation, Phase 2's
 * integration_configs table, completely unchanged).
 *
 * Hard invariants this module exists to guarantee for every call site:
 *  - notify() NEVER throws. A provider outage, a missing/unmigrated
 *    table, a malformed context - none of it may ever roll back or block
 *    the real order/return/refund action that triggered the call. Every
 *    failure path here ends in a caught error and a logged row, not an
 *    exception (same "log, don't block" tolerance this codebase already
 *    applies to every other non-critical side effect - restock-on-cancel,
 *    QC-batch intake on return approval, post-payment stock allocation).
 *  - A channel that is disabled/unconfigured sends nothing and is
 *    recorded as 'skipped', never attempted.
 *  - Retriggering the same business event is a safe no-op: `dedupe_key`
 *    plus the DB's `unique(event, channel, dedupe_key)` constraint (same
 *    idempotency pattern as Phase 2's webhook_events) makes a duplicate
 *    insert fail fast, before any external call is even attempted.
 *  - Only customer-safe content ever leaves this module for an external
 *    provider or an admin-history row: order number, amounts, a tracking
 *    number, a rejection reason a staff member already wrote for the
 *    customer to see. Never a gateway id, webhook payload, or batch/
 *    inventory detail.
 */
import { supabaseAdmin } from "../db/supabaseClient.js";
import { config } from "../config.js";
import * as emailProvider from "../integrations/email/provider.js";
import * as smsProvider from "../integrations/sms/provider.js";
import * as whatsappProvider from "../integrations/whatsapp/provider.js";
import { logError } from "../services/errorLogService.js";

export const NOTIFICATION_EVENTS = [
  "order_placed", "order_shipped", "order_delivered", "order_cancelled",
  "return_approved", "return_rejected", "refund_completed",
  // Phase 8B - fired by shipmentService.js on the matching shipment
  // transition; dedupeKey defaults to order.id (below), so
  // "order_delivery_failed" firing once for failed_delivery and again
  // later for the same order's rto_initiated still only ever sends once.
  "order_out_for_delivery", "order_delivery_failed",
];
export const NOTIFICATION_CHANNELS = ["email", "sms", "whatsapp"];

const CHANNEL_PROVIDERS = { email: emailProvider, sms: smsProvider, whatsapp: whatsappProvider };

function money(n) {
  return `Rs.${Number(n || 0).toLocaleString("en-IN")}`;
}

/** Plain-text content per event - short enough to work as an SMS/WhatsApp
 * body as-is, reused verbatim as the email body too (kept to one shared
 * template per event rather than three near-duplicate copies). */
function buildContent(event, ctx) {
  const siteName = config.site.name;
  const orderNumber = ctx.orderNumber || "";
  switch (event) {
    case "order_placed":
      return {
        subject: `Order placed - ${orderNumber}`,
        message: `Hi, your ${siteName} order ${orderNumber} has been placed${ctx.total != null ? ` (Total: ${money(ctx.total)})` : ""}. We'll let you know when it ships.`,
      };
    case "order_shipped":
      return {
        subject: `Order shipped - ${orderNumber}`,
        message: `Your ${siteName} order ${orderNumber} has shipped.${ctx.trackingNumber ? ` Tracking number: ${ctx.trackingNumber}.` : ""}`,
      };
    case "order_delivered":
      return {
        subject: `Order delivered - ${orderNumber}`,
        message: `Your ${siteName} order ${orderNumber} has been delivered. Need a return? You have 7 days from delivery to request one.`,
      };
    case "order_cancelled":
      return {
        subject: `Order cancelled - ${orderNumber}`,
        message: `Your ${siteName} order ${orderNumber} has been cancelled.`,
      };
    case "order_out_for_delivery":
      return {
        subject: `Out for delivery - ${orderNumber}`,
        message: `Your ${siteName} order ${orderNumber} is out for delivery today.${ctx.trackingNumber ? ` Tracking number: ${ctx.trackingNumber}.` : ""}`,
      };
    case "order_delivery_failed":
      return {
        subject: `Delivery update - ${orderNumber}`,
        message: `We were unable to deliver your ${siteName} order ${orderNumber}.${ctx.reason ? ` Reason: ${ctx.reason}.` : ""} Our team will follow up with you shortly.`,
      };
    case "return_approved":
      return {
        subject: `Return approved - ${orderNumber}`,
        message: `Your return request for order ${orderNumber} has been approved. Refund amount: ${money(ctx.refundAmount)}.`,
      };
    case "return_rejected":
      return {
        subject: `Return request update - ${orderNumber}`,
        message: `Your return request for order ${orderNumber} was not approved.${ctx.rejectionReason ? ` Reason: ${ctx.rejectionReason}` : ""}`,
      };
    case "refund_completed":
      return {
        subject: `Refund processed - ${orderNumber}`,
        message: `Your refund of ${money(ctx.refundAmount)} for order ${orderNumber} has been processed.`,
      };
    default:
      return null;
  }
}

/** An order's email always comes from either the guest checkout fields or
 * (logged-in customer) their Supabase Auth account - guest_email/
 * guest_phone are both null on a logged-in customer's order (see
 * server/src/routes/public.js's checkout insert), so this is the only
 * reliable source for that case. Phone, on the other hand, is always on
 * shipping_address.phone regardless of guest/logged-in status (checkout's
 * own validateAddress() requires it on every order) - preferred over
 * guest_phone for that reason. */
async function resolveRecipient(order) {
  let email = order.guest_email || null;
  if (!email && order.customer_id) {
    try {
      const { data } = await supabaseAdmin().auth.admin.getUserById(order.customer_id);
      email = data?.user?.email || null;
    } catch {
      email = null;
    }
  }
  const phone = order.shipping_address?.phone || order.guest_phone || null;
  return { email, phone };
}

/** Reserves the idempotency slot, resolves whether the channel is even
 * usable, sends if so, and records the outcome - all in one place so
 * every channel goes through identical bookkeeping. Never throws. */
async function dispatchOne({ event, channel, dedupeKey, orderId, returnRequestId, customerId, recipient, send }) {
  let reserved;
  try {
    const { data, error } = await supabaseAdmin()
      .from("notification_log")
      .insert({
        event, channel, dedupe_key: dedupeKey,
        order_id: orderId || null, return_request_id: returnRequestId || null, customer_id: customerId || null,
        recipient: recipient || null, status: "skipped",
      })
      .select().single();
    if (error) {
      if (error.code === "23505") return; // already attempted for this exact event+channel+dedupe_key - safe no-op
      console.error(`[notify] could not record ${event}/${channel} attempt:`, error.message);
      return;
    }
    reserved = data;
  } catch (e) {
    console.error(`[notify] could not record ${event}/${channel} attempt:`, e.message || e);
    return;
  }

  try {
    if (!recipient) {
      await supabaseAdmin().from("notification_log").update({ skip_reason: "no_recipient" }).eq("id", reserved.id);
      return;
    }
    const provider = CHANNEL_PROVIDERS[channel];
    const environment = await provider.getActiveEnvironment();
    if (!environment) {
      await supabaseAdmin().from("notification_log").update({ skip_reason: "channel_not_configured" }).eq("id", reserved.id);
      return;
    }
    await send(provider, environment);
    await supabaseAdmin().from("notification_log").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", reserved.id);
  } catch (e) {
    await supabaseAdmin()
      .from("notification_log")
      .update({ status: "failed", error_message: String(e.message || "send failed").slice(0, 300) })
      .eq("id", reserved.id);
  }
}

/**
 * The one entry point every order/return/refund code path should call.
 * `order` is the full order row (or at least id, order_number, customer_id,
 * guest_email, guest_phone, shipping_address). `dedupeKey` should be
 * whatever uniquely identifies THIS specific business event (an order id
 * for order-lifecycle events, a return_request id for return decisions, a
 * refund id for refund_completed) - see notification_log's own unique
 * constraint. Awaited by every call site (consistent with how this
 * codebase already awaits-but-tolerates every other non-critical side
 * effect), but internally bulletproofed against ever throwing.
 */
export async function notify(event, { order, returnRequestId, dedupeKey, ...templateCtx } = {}) {
  try {
    if (!NOTIFICATION_EVENTS.includes(event) || !order) return;
    const content = buildContent(event, { orderNumber: order.order_number, ...templateCtx });
    if (!content) return;
    const key = dedupeKey || order.id;
    if (!key) return;

    const { email, phone } = await resolveRecipient(order);
    const common = { event, dedupeKey: key, orderId: order.id, returnRequestId, customerId: order.customer_id || null };

    await dispatchOne({
      ...common, channel: "email", recipient: email,
      send: (provider, environment) => provider.send(environment, { to: email, subject: content.subject, text: content.message }),
    });
    await dispatchOne({
      ...common, channel: "sms", recipient: phone,
      send: (provider, environment) => provider.send(environment, { to: phone, message: content.message }),
    });
    await dispatchOne({
      ...common, channel: "whatsapp", recipient: phone,
      send: (provider, environment) => provider.send(environment, { to: phone, message: content.message }),
    });
  } catch (e) {
    console.error(`[notify] unexpected error dispatching ${event}:`, e.message || e);
    logError("notification_service", e, { event, orderId: order?.id || null });
  }
}
