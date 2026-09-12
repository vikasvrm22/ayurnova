/**
 * Order/Payment/Attempt/Refund orchestration. This is the only module
 * that writes to the payments/payment_attempts/refunds tables - every
 * route (checkout, verify, webhook, admin refund/reconcile) goes through
 * here so the state-transition rules below are enforced in exactly one
 * place.
 *
 * Core rule (Phase 2 brief's "CRITICAL RULE"): the frontend's claim of
 * payment success is NEVER, on its own, sufficient to mark anything paid.
 * Every path that can lead to `markAttemptOutcome(..., success: true)`
 * first re-verifies a Razorpay-signed proof server-side - either the
 * Checkout.js callback's HMAC signature (verifyCheckoutPayment) or a
 * webhook's HMAC signature (processWebhookEvent). There is no code path
 * that sets a payment/order to "paid" from an unverified client POST body.
 */
import { supabaseAdmin } from "../db/supabaseClient.js";
import { AppError } from "../utils/apiResponse.js";
import * as razorpayProvider from "../integrations/razorpay/provider.js";
import { getDecryptedCredentials } from "../integrations/integrationService.js";

/**
 * Starts (or restarts) a Razorpay payment for an order: creates/reuses
 * the order's `payments` row, creates a new `payment_attempts` row, asks
 * Razorpay for a fresh order, and returns what Checkout.js needs.
 * Never decrements stock - that only happens once a SUCCESS is verified
 * (see markAttemptOutcome), specifically to avoid holding/decrementing
 * inventory for a payment that may never complete (Phase 2 §9 order
 * integrity requirement).
 */
export async function startPaymentAttempt(order) {
  const environment = await razorpayProvider.getActiveEnvironment();
  if (!environment) {
    throw new AppError(
      "Online payment is not available right now. Please choose Cash on Delivery, or try again shortly.",
      503,
      "PAYMENT_GATEWAY_UNAVAILABLE"
    );
  }

  let payment = await getPaymentByOrderId(order.id);
  if (!payment) {
    const { data, error } = await supabaseAdmin().from("payments").insert({
      order_id: order.id, gateway: "razorpay", environment, amount: order.total, currency: "INR", status: "INITIATED",
    }).select().single();
    if (error) throw error;
    payment = data;
  } else {
    if (payment.status === "SUCCESS") {
      throw new AppError("This order has already been paid.", 409, "ALREADY_PAID");
    }
    if (payment.environment !== environment) {
      // Should not normally happen (environment doesn't change mid-order),
      // but never silently mix environments - fail loudly instead.
      throw new AppError("Payment environment mismatch - please contact support.", 500, "PAYMENT_ENV_MISMATCH");
    }
  }

  const { data: existingAttempts, error: attemptsError } = await supabaseAdmin()
    .from("payment_attempts").select("attempt_number").eq("payment_id", payment.id).order("attempt_number", { ascending: false }).limit(1);
  if (attemptsError) throw attemptsError;
  const nextAttemptNumber = (existingAttempts?.[0]?.attempt_number || 0) + 1;

  const razorpayOrder = await razorpayProvider.createOrder(environment, {
    amountRupees: Number(order.total), currency: "INR", receipt: order.order_number, notes: { order_number: order.order_number },
  });
  if (!razorpayOrder) {
    throw new AppError("Online payment is not available right now. Please choose Cash on Delivery, or try again shortly.", 503, "PAYMENT_GATEWAY_UNAVAILABLE");
  }

  const { data: attempt, error: attemptError } = await supabaseAdmin().from("payment_attempts").insert({
    payment_id: payment.id, attempt_number: nextAttemptNumber, gateway_order_id: razorpayOrder.id, status: "INITIATED",
  }).select().single();
  if (attemptError) throw attemptError;

  const creds = await getDecryptedCredentials("razorpay", environment);
  return {
    paymentId: payment.id,
    attemptId: attempt.id,
    razorpay: { orderId: razorpayOrder.id, amount: razorpayOrder.amount, currency: razorpayOrder.currency, keyId: creds.keyId },
  };
}

export async function getPaymentByOrderId(orderId) {
  const { data, error } = await supabaseAdmin().from("payments").select("*").eq("order_id", orderId).maybeSingle();
  if (error) throw error;
  return data;
}

async function getAttemptByGatewayOrderId(gatewayOrderId) {
  const { data, error } = await supabaseAdmin()
    .from("payment_attempts").select("*, payments(*, orders(*))").eq("gateway_order_id", gatewayOrderId).maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Verifies a Checkout.js success callback server-side and, only if the
 * signature is genuinely valid, marks the attempt/payment/order paid.
 * This is the customer-facing half of the "never trust the frontend
 * alone" rule - the value being trusted is Razorpay's HMAC signature,
 * cryptographically verified here, not the browser's say-so.
 */
export async function verifyCheckoutPayment({ razorpayOrderId, razorpayPaymentId, razorpaySignature, customerId, guestPhone }) {
  const attempt = await getAttemptByGatewayOrderId(razorpayOrderId);
  if (!attempt) throw new AppError("Payment attempt not found", 404, "ATTEMPT_NOT_FOUND");

  const order = attempt.payments.orders;
  const isOwner = customerId ? order.customer_id === customerId : guestPhone && order.guest_phone === guestPhone;
  if (!isOwner) throw new AppError("This payment does not belong to you", 403, "FORBIDDEN");

  const creds = await getDecryptedCredentials("razorpay", attempt.payments.environment);
  if (!creds) throw new AppError("Payment gateway is not configured", 503, "PAYMENT_GATEWAY_UNAVAILABLE");

  const valid = razorpayProvider.verifyPaymentSignature({
    orderId: razorpayOrderId, paymentId: razorpayPaymentId, signature: razorpaySignature, keySecret: creds.keySecret,
  });

  if (!valid) {
    await markAttemptOutcome(attempt, { success: false, failureReason: "Signature verification failed" });
    throw new AppError("Payment verification failed", 400, "SIGNATURE_INVALID");
  }

  const result = await markAttemptOutcome(attempt, { success: true, gatewayPaymentId: razorpayPaymentId, rawEvent: { source: "checkout_verify" } });
  return { order, payment: result.payment, attempt: result.attempt };
}

/**
 * Idempotent state transition - safe to call twice for the same outcome
 * (e.g. both the Checkout.js verify callback AND the webhook arrive for
 * the same payment): the conditional update below only actually changes
 * anything, and only decrements stock, on the FIRST call that observes a
 * non-terminal attempt. A second call sees the attempt already in a
 * terminal state and returns the current state as a no-op.
 */
export async function markAttemptOutcome(attempt, { success, gatewayPaymentId, method, rawEvent, failureReason }) {
  if (["SUCCESS", "FAILED", "CANCELLED"].includes(attempt.status)) {
    // Already resolved - idempotent no-op (Phase 2 §9: no duplicate webhook effects).
    const { data: payment } = await supabaseAdmin().from("payments").select("*").eq("id", attempt.payment_id).single();
    return { attempt, payment };
  }

  const attemptPatch = {
    status: success ? "SUCCESS" : "FAILED",
    updated_at: new Date().toISOString(),
  };
  if (gatewayPaymentId) attemptPatch.gateway_payment_id = gatewayPaymentId;
  if (method) attemptPatch.method = method;
  if (rawEvent) attemptPatch.raw_event = rawEvent;
  if (failureReason) attemptPatch.failure_reason = failureReason;

  const { data: updatedAttempt, error: attemptUpdateError } = await supabaseAdmin()
    .from("payment_attempts").update(attemptPatch).eq("id", attempt.id).eq("status", attempt.status) // conditional: only if still unresolved
    .select().maybeSingle();
  if (attemptUpdateError) throw attemptUpdateError;
  if (!updatedAttempt) {
    // Lost the race to a concurrent call - treat as the idempotent no-op case.
    const { data: payment } = await supabaseAdmin().from("payments").select("*").eq("id", attempt.payment_id).single();
    const { data: freshAttempt } = await supabaseAdmin().from("payment_attempts").select("*").eq("id", attempt.id).single();
    return { attempt: freshAttempt, payment };
  }

  if (!success) {
    const { data: payment } = await supabaseAdmin().from("payments").select("*").eq("id", attempt.payment_id).single();
    return { attempt: updatedAttempt, payment };
  }

  // Conditional update: only the call that actually flips payment status
  // away from a non-terminal state gets to proceed to decrement stock.
  const { data: updatedPayment, error: paymentUpdateError } = await supabaseAdmin()
    .from("payments").update({ status: "SUCCESS", updated_at: new Date().toISOString() })
    .eq("id", attempt.payment_id).in("status", ["INITIATED", "PENDING"])
    .select().maybeSingle();
  if (paymentUpdateError) throw paymentUpdateError;

  if (updatedPayment) {
    const { data: order } = await supabaseAdmin().from("orders").select("*").eq("id", updatedPayment.order_id).single();
    await supabaseAdmin().from("orders").update({ payment_status: "paid", updated_at: new Date().toISOString() }).eq("id", order.id);
    await decrementStockForOrder(order.id);
    await supabaseAdmin().from("activity_log").insert({
      entity_type: "order", entity_id: order.id, action: "payment_succeeded", actor: "system",
      note: `Razorpay payment ${gatewayPaymentId || ""}`.trim(),
    });
    return { attempt: updatedAttempt, payment: updatedPayment };
  }

  const { data: payment } = await supabaseAdmin().from("payments").select("*").eq("id", attempt.payment_id).single();
  return { attempt: updatedAttempt, payment };
}

/** Decrements stock for every item in an order - the prepaid-flow
 * counterpart to the COD flow's immediate decrement in public.js's
 * checkout route. Shares the same RPC + fallback pattern. Only ever
 * called once per order in practice (guarded by markAttemptOutcome's
 * conditional payment-status update above), but written so a stray
 * extra call would only ever slightly under/over-decrement, never throw -
 * same risk tolerance already documented elsewhere in this codebase. */
async function decrementStockForOrder(orderId) {
  const { data: items } = await supabaseAdmin().from("order_items").select("variant_id, qty").eq("order_id", orderId);
  for (const item of items || []) {
    if (!item.variant_id) continue;
    // supabase-js's .rpc() builder is thenable but has no .catch() method -
    // calling .catch() on it threw instead of ever reaching the fallback,
    // contradicting this function's own "never throw" comment above (Phase
    // 5A post-migration verification fix).
    const { error: rpcError } = await supabaseAdmin().rpc("decrement_variant_stock", { variant_id: item.variant_id, qty: item.qty });
    if (rpcError) {
      const { data: v } = await supabaseAdmin().from("product_variants").select("stock").eq("id", item.variant_id).single();
      if (v) await supabaseAdmin().from("product_variants").update({ stock: Math.max(0, v.stock - item.qty) }).eq("id", item.variant_id);
    }
  }
}

// Explicit event-type classification - deliberately NOT "anything that
// isn't captured counts as failed". That fallback (the pre-audit
// behaviour) would have wrongly classified an unrelated payment.* event
// (e.g. payment.authorized under a manual-capture flow) as a failure.
// Only these named sets ever drive a state transition; anything else is
// recorded (in webhook_events, above) but explicitly IGNORED, not guessed at.
const PAYMENT_SUCCESS_EVENT_TYPES = new Set(["payment.captured"]);
const PAYMENT_FAILURE_EVENT_TYPES = new Set(["payment.failed"]);
const REFUND_EVENT_TYPES = new Set(["refund.created", "refund.processed", "refund.failed"]);

/**
 * Records a webhook event and processes it idempotently. The unique
 * (gateway, event_id) constraint on webhook_events is the actual
 * idempotency guard: a duplicate delivery fails the insert with a unique
 * violation, which is treated as "already processed" rather than an
 * error (Phase 2 §5/§9: duplicate webhook protection). This guard runs
 * for every event type below, before any business-state logic.
 */
export async function processWebhookEvent({ eventId, eventType, payload, signatureValid }) {
  const { error: insertError } = await supabaseAdmin().from("webhook_events").insert({
    gateway: "razorpay", event_id: eventId, event_type: eventType, payload, signature_valid: signatureValid,
    processing_status: "RECEIVED",
  });
  if (insertError) {
    if (insertError.code === "23505") return { duplicate: true }; // unique_violation - already recorded, no-op
    throw insertError;
  }

  if (!signatureValid) {
    await updateWebhookStatus(eventId, "ERROR", "Invalid signature");
    return { duplicate: false, processed: false, reason: "invalid_signature" };
  }

  if (REFUND_EVENT_TYPES.has(eventType)) {
    const result = await processRefundWebhookEvent({ eventType, payload });
    await updateWebhookStatus(eventId, result.handled ? "PROCESSED" : "IGNORED", result.handled ? null : result.reason);
    return { duplicate: false, processed: result.handled, reason: result.handled ? undefined : result.reason };
  }

  const gatewayOrderId = payload?.payload?.payment?.entity?.order_id;
  if (!gatewayOrderId) {
    await updateWebhookStatus(eventId, "IGNORED", `Unhandled event type or missing order id: ${eventType}`);
    return { duplicate: false, processed: false, reason: "no_matching_order" };
  }

  const attempt = await getAttemptByGatewayOrderId(gatewayOrderId);
  if (!attempt) {
    await updateWebhookStatus(eventId, "IGNORED", `No local attempt for gateway order ${gatewayOrderId}`);
    return { duplicate: false, processed: false, reason: "attempt_not_found" };
  }

  const entity = payload.payload.payment.entity;
  const isSuccess = PAYMENT_SUCCESS_EVENT_TYPES.has(eventType) || entity.status === "captured";
  const isFailure = PAYMENT_FAILURE_EVENT_TYPES.has(eventType) || entity.status === "failed";
  if (!isSuccess && !isFailure) {
    // A payment.* event with no explicit success/failure meaning for us
    // (e.g. payment.authorized) - recorded above for audit visibility,
    // but never used to guess at an attempt's outcome.
    await updateWebhookStatus(eventId, "IGNORED", `Unhandled payment event type: ${eventType} (payment status: ${entity.status})`);
    return { duplicate: false, processed: false, reason: "unhandled_event_type" };
  }

  await markAttemptOutcome(attempt, {
    success: isSuccess,
    gatewayPaymentId: entity.id,
    method: entity.method,
    rawEvent: { source: "webhook", event_type: eventType },
    failureReason: isSuccess ? undefined : entity.error_description || "Payment failed",
  });
  await updateWebhookStatus(eventId, "PROCESSED", null);
  return { duplicate: false, processed: true };
}

/**
 * Handles refund.created / refund.processed / refund.failed. Razorpay's
 * refund webhook payload carries the refund entity itself
 * (payload.refund.entity: id, payment_id, amount in paise, status) -
 * that `payment_id` is used directly to find the local payment via the
 * attempt whose gateway_payment_id matches, rather than depending on an
 * accompanying payment entity also being present.
 *
 * Idempotent per gateway_refund_id, NOT merely per webhook event_id: two
 * different events for the same refund (refund.created then
 * refund.processed) must not double-apply the amount. The first sighting
 * of a gateway_refund_id in a PROCESSED state - whether via our own
 * admin-initiated createRefund() (which records it synchronously) or via
 * this webhook - applies payments.refunded_amount exactly once; every
 * later event for that same refund only updates its status.
 *
 * Fixes a real Phase 2 gap found by audit: a refund issued directly via
 * the Razorpay Dashboard (not through /api/admin/payments/:id/refund)
 * previously left no trace anywhere in this app's database at all.
 */
async function processRefundWebhookEvent({ eventType, payload }) {
  const refundEntity = payload?.payload?.refund?.entity;
  if (!refundEntity?.payment_id) {
    return { handled: false, reason: "no_refund_entity" };
  }

  const { data: attempt } = await supabaseAdmin()
    .from("payment_attempts").select("*, payments(*)").eq("gateway_payment_id", refundEntity.payment_id).maybeSingle();
  if (!attempt) {
    return { handled: false, reason: "payment_not_found" };
  }
  const payment = attempt.payments;

  const STATUS_BY_EVENT = { "refund.created": "INITIATED", "refund.processed": "PROCESSED", "refund.failed": "FAILED" };
  const refundStatus = STATUS_BY_EVENT[eventType] || "INITIATED";
  const amountRupees = Number(refundEntity.amount) / 100;

  const { data: existingRefund } = await supabaseAdmin()
    .from("refunds").select("*").eq("gateway_refund_id", refundEntity.id).maybeSingle();

  if (existingRefund) {
    await supabaseAdmin().from("refunds").update({ status: refundStatus, updated_at: new Date().toISOString() }).eq("id", existingRefund.id);
  } else {
    await supabaseAdmin().from("refunds").insert({
      payment_id: payment.id, attempt_id: attempt.id, gateway_refund_id: refundEntity.id,
      amount: amountRupees, reason: "Initiated outside the admin panel (recorded via Razorpay webhook)",
      status: refundStatus, created_by: "system(webhook)",
    });
  }

  // Apply to payments/orders exactly once - only on the transition INTO
  // PROCESSED, and only if this gateway_refund_id hasn't already reached
  // PROCESSED before (covers both "webhook arrives twice for the same
  // refund" and "we already recorded this refund as PROCESSED ourselves").
  if (refundStatus === "PROCESSED" && existingRefund?.status !== "PROCESSED") {
    const newRefundedAmount = Number(payment.refunded_amount) + amountRupees;
    const fullyRefunded = newRefundedAmount >= Number(payment.amount) - 0.005;
    await supabaseAdmin().from("payments").update({
      refunded_amount: newRefundedAmount,
      status: fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED",
      updated_at: new Date().toISOString(),
    }).eq("id", payment.id);
    await supabaseAdmin().from("orders").update({
      payment_status: fullyRefunded ? "refunded" : "partially_refunded", updated_at: new Date().toISOString(),
    }).eq("id", payment.order_id);
    await supabaseAdmin().from("activity_log").insert({
      entity_type: "payment", entity_id: payment.id, action: "refund_confirmed_via_webhook", actor: "system",
      note: `₹${amountRupees} (${eventType})`,
    });
  }

  return { handled: true };
}

async function updateWebhookStatus(eventId, status, note) {
  await supabaseAdmin().from("webhook_events").update({ processing_status: status, processing_note: note }).eq("gateway", "razorpay").eq("event_id", eventId);
}

/** Creates a refund, validated against what's actually refundable. Never
 * exceeds payment.amount - payment.refunded_amount (Phase 2 §6). */
export async function createRefund({ paymentId, amountRupees, reason, actorEmail }) {
  const { data: payment, error } = await supabaseAdmin().from("payments").select("*, orders(*)").eq("id", paymentId).single();
  if (error || !payment) throw new AppError("Payment not found", 404, "PAYMENT_NOT_FOUND");
  if (!["SUCCESS", "PARTIALLY_REFUNDED"].includes(payment.status)) {
    throw new AppError("Only a successfully paid payment can be refunded", 400, "NOT_REFUNDABLE");
  }

  const refundable = Number(payment.amount) - Number(payment.refunded_amount);
  const amount = amountRupees !== undefined ? Number(amountRupees) : refundable;
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError("Refund amount must be a positive number", 400, "INVALID_AMOUNT");
  if (amount > refundable + 0.005) { // small epsilon for floating-point rupee/paise rounding
    throw new AppError(`Refund amount exceeds the refundable balance (₹${refundable.toFixed(2)})`, 400, "AMOUNT_EXCEEDS_REFUNDABLE");
  }

  const { data: successAttempt } = await supabaseAdmin()
    .from("payment_attempts").select("*").eq("payment_id", paymentId).eq("status", "SUCCESS").order("attempt_number", { ascending: false }).limit(1).maybeSingle();
  if (!successAttempt?.gateway_payment_id) throw new AppError("No successful payment attempt found to refund", 400, "NO_SUCCESSFUL_ATTEMPT");

  let gatewayRefund;
  try {
    gatewayRefund = await razorpayProvider.createRefund(payment.environment, {
      gatewayPaymentId: successAttempt.gateway_payment_id, amountRupees: amount, notes: { reason: reason || "" },
    });
  } catch (e) {
    const message = e?.error?.description || e.message || "Refund request failed";
    await supabaseAdmin().from("refunds").insert({
      payment_id: paymentId, attempt_id: successAttempt.id, amount, reason, status: "FAILED", created_by: actorEmail,
    });
    throw new AppError(`Refund failed: ${message}`, 502, "REFUND_FAILED");
  }

  const { data: refundRow, error: refundInsertError } = await supabaseAdmin().from("refunds").insert({
    payment_id: paymentId, attempt_id: successAttempt.id, gateway_refund_id: gatewayRefund.id,
    amount, reason, status: "PROCESSED", created_by: actorEmail,
  }).select().single();
  if (refundInsertError) throw refundInsertError;

  const newRefundedAmount = Number(payment.refunded_amount) + amount;
  const fullyRefunded = newRefundedAmount >= Number(payment.amount) - 0.005;
  const newPaymentStatus = fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED";
  await supabaseAdmin().from("payments").update({
    refunded_amount: newRefundedAmount, status: newPaymentStatus, updated_at: new Date().toISOString(),
  }).eq("id", paymentId);
  await supabaseAdmin().from("orders").update({
    payment_status: fullyRefunded ? "refunded" : "partially_refunded", updated_at: new Date().toISOString(),
  }).eq("id", payment.order_id);

  await supabaseAdmin().from("activity_log").insert({
    entity_type: "payment", entity_id: paymentId, action: "refund_issued", actor: actorEmail,
    note: `₹${amount} (${newPaymentStatus})`,
  });

  return refundRow;
}

/**
 * Read-only comparison between local state and Razorpay's own record for
 * one payment's latest attempt. Never writes anything - Phase 2 §8
 * explicitly requires reconciliation findings to be surfaced, not
 * silently auto-repaired. Returns a report; a human (or a deliberate,
 * separately-audited follow-up action) decides what to do about it.
 */
export async function reconcilePayment(paymentId) {
  const { data: payment, error } = await supabaseAdmin().from("payments").select("*").eq("id", paymentId).single();
  if (error || !payment) throw new AppError("Payment not found", 404, "PAYMENT_NOT_FOUND");

  const { data: attempts } = await supabaseAdmin()
    .from("payment_attempts").select("*").eq("payment_id", paymentId).order("attempt_number", { ascending: false });
  const latest = attempts?.[0];

  if (!latest?.gateway_payment_id) {
    return { paymentId, consistent: null, note: "No attempt with a gateway payment id yet - nothing to reconcile against.", local: { status: payment.status }, remote: null };
  }

  let remote;
  try {
    remote = await razorpayProvider.fetchPayment(payment.environment, latest.gateway_payment_id);
  } catch (e) {
    return { paymentId, consistent: null, note: `Could not reach Razorpay: ${e?.error?.description || e.message}`, local: { status: payment.status }, remote: null };
  }

  const remoteSuccess = remote.status === "captured";
  const localSuccess = payment.status === "SUCCESS" || payment.status === "PARTIALLY_REFUNDED" || payment.status === "REFUNDED";
  const amountMatches = Math.abs(Number(remote.amount) / 100 - Number(payment.amount)) < 0.01;
  const consistent = remoteSuccess === localSuccess && amountMatches;

  return {
    paymentId,
    consistent,
    local: { status: payment.status, amount: payment.amount },
    remote: { status: remote.status, amount: Number(remote.amount) / 100, captured: remote.captured },
    mismatches: consistent ? [] : [
      ...(remoteSuccess !== localSuccess ? [`status: local=${payment.status} vs Razorpay=${remote.status}`] : []),
      ...(!amountMatches ? [`amount: local=₹${payment.amount} vs Razorpay=₹${Number(remote.amount) / 100}`] : []),
    ],
  };
}
