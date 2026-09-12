/**
 * Customer-facing payment endpoints - verify (Checkout.js success
 * callback) and webhook (Razorpay server-to-server) both converge on
 * paymentService.markAttemptOutcome, so whichever arrives first is what
 * actually marks a payment paid; the other becomes a no-op. Retry lets a
 * customer start a fresh attempt on an order whose previous attempt
 * failed or was abandoned.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { attachCustomerIfPresent } from "../auth/customerAuth.js";
import { validatePhone } from "../validation/validators.js";
import { AppError, asyncRoute } from "../utils/apiResponse.js";
import * as paymentService from "../services/paymentService.js";
import * as razorpayProvider from "../integrations/razorpay/provider.js";
import { getDecryptedCredentials } from "../integrations/integrationService.js";

const router = Router();

// ---- Verify a Checkout.js success callback ----
router.post(
  "/verify",
  attachCustomerIfPresent,
  asyncRoute(async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, guest_phone } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      throw new AppError("razorpay_order_id, razorpay_payment_id and razorpay_signature are required", 400, "MISSING_FIELDS");
    }
    const { order, payment } = await paymentService.verifyCheckoutPayment({
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
      customerId: req.customer?.id || null,
      guestPhone: guest_phone || null,
    });
    res.json({ success: true, order_number: order.order_number, payment_status: payment.status });
  })
);

// ---- Retry payment on an order whose previous attempt failed/was abandoned ----
router.post(
  "/retry",
  attachCustomerIfPresent,
  asyncRoute(async (req, res) => {
    const { order_number, guest_phone } = req.body || {};
    if (!order_number) throw new AppError("order_number is required", 400, "MISSING_FIELDS");

    const { data: order, error } = await supabaseAdmin().from("orders").select("*").eq("order_number", order_number).maybeSingle();
    if (error) throw error;
    if (!order) throw new AppError("Order not found", 404, "ORDER_NOT_FOUND");

    const isOwner = req.customer ? order.customer_id === req.customer.id : validatePhone(guest_phone || "") && order.guest_phone === guest_phone;
    if (!isOwner) throw new AppError("This order does not belong to you", 403, "FORBIDDEN");
    if (order.payment_method !== "prepaid") throw new AppError("This order is not a prepaid order", 400, "NOT_PREPAID");
    if (order.payment_status === "paid") throw new AppError("This order has already been paid.", 409, "ALREADY_PAID");

    const result = await paymentService.startPaymentAttempt(order);
    res.json({ order_number: order.order_number, ...result });
  })
);

// ---- Razorpay webhook (server-to-server, no customer auth - the HMAC
// signature over the raw body IS the authentication) ----
router.post(
  "/webhook/razorpay",
  asyncRoute(async (req, res) => {
    const signature = req.headers["x-razorpay-signature"];
    const rawBody = req.rawBody; // captured by express.json's verify() in index.js
    if (!signature || !rawBody) {
      // Malformed/unexpected request - acknowledge with 400 so Razorpay's
      // dashboard shows a clear delivery failure, but never process it.
      return res.status(400).json({ error: "Missing signature or body" });
    }

    // Webhook secrets are configured per environment; try whichever one
    // this signature actually matches rather than assuming - Razorpay
    // delivers test-mode and live-mode webhooks to the same URL.
    let signatureValid = false;
    for (const environment of ["production", "test"]) {
      const creds = await getDecryptedCredentials("razorpay", environment);
      if (!creds?.webhookSecret) continue;
      if (razorpayProvider.verifyWebhookSignature({ rawBody, signature, webhookSecret: creds.webhookSecret })) {
        signatureValid = true;
        break;
      }
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const eventId = req.headers["x-razorpay-event-id"] || payload?.payload?.payment?.entity?.id || `${payload?.event}-${Date.now()}`;
    const result = await paymentService.processWebhookEvent({ eventId, eventType: payload.event, payload, signatureValid });

    if (!signatureValid) {
      // Deliberately a 4xx, not a swallowed 200: an invalid signature
      // means either a misconfigured webhook secret or someone probing
      // the endpoint - either way it should show up as a failed delivery
      // in Razorpay's dashboard, not look like a quiet success. The event
      // is still recorded (processWebhookEvent above) for audit purposes.
      return res.status(400).json({ received: true, ...result });
    }
    // 200 for a genuinely verified, received webhook (Razorpay retries on
    // non-2xx) - the body tells the rest of the story (duplicate/ignored/
    // processed) for our own logs/admin reconciliation view, not for
    // Razorpay's retry logic.
    res.json({ received: true, ...result });
  })
);

export default router;
