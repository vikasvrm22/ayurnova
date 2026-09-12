/**
 * Razorpay-specific glue over the generic integration foundation
 * (integrationService.js). This is the ONLY file that imports the
 * `razorpay` SDK - everything else in the app talks to payments through
 * server/src/services/paymentService.js, never directly to this module's
 * internals, so swapping/adding a gateway later doesn't ripple outward.
 */
import Razorpay from "razorpay";
import crypto from "node:crypto";
import { getDecryptedCredentials, getIntegrationConfig, recordConnectionTest } from "../integrationService.js";

export const PROVIDER = "razorpay";

/** Builds a Razorpay SDK client for one environment, or null if that
 * environment has no enabled configuration. */
export async function getClient(environment) {
  const creds = await getDecryptedCredentials(PROVIDER, environment);
  if (!creds || !creds.keyId || !creds.keySecret) return null;
  return { client: new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret }), creds };
}

/** The environment the app should actually use right now: production if
 * enabled, else test, else null (no usable Razorpay configuration at
 * all - callers must treat this as "payments unavailable", never fall
 * back to trusting the client). Never silently mixes environments within
 * one call - the caller gets one deterministic answer. */
export async function getActiveEnvironment() {
  for (const environment of ["production", "test"]) {
    const result = await getClient(environment);
    if (result) return environment;
  }
  return null;
}

/**
 * Non-mutating connection test: lists at most one order to confirm the
 * configured key pair is valid, without creating or changing anything.
 *
 * Diagnostic fix: this used to report a single message ("No credentials
 * configured, or the integration is disabled for this environment") for
 * three genuinely different states - no config row at all, a config row
 * that's disabled, and an enabled row missing a key id/secret - which
 * made a correctly-saved-but-not-yet-enabled configuration look like the
 * save itself had failed. The actual enable/disable security gate
 * (getClient/getDecryptedCredentials, used by every real payment code
 * path) is unchanged; this only makes the ADMIN-FACING diagnosis of why
 * a test failed precise, by inspecting the raw config row first.
 */
export async function testConnection(environment) {
  const row = await getIntegrationConfig(PROVIDER, environment);
  if (!row) {
    const message = "No credentials saved yet for this environment. Enter a Key ID and Key Secret, then Save.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
  if (!row.key_id || !row.key_secret_encrypted) {
    const message = "Credentials are incomplete - both a Key ID and a Key Secret are required.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
  if (!row.enabled) {
    const message = "Credentials are saved, but this integration is currently disabled. Toggle Enabled and Save to activate it.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }

  const result = await getClient(environment);
  if (!result) {
    // Defensive only - the checks above should already cover every case
    // getClient/getDecryptedCredentials can return null for.
    const message = "Credentials could not be loaded for this environment.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
  try {
    await result.client.orders.all({ count: 1 });
    await recordConnectionTest(PROVIDER, environment, "success", "Connected successfully");
    return { success: true, message: "Connected successfully" };
  } catch (e) {
    const message = e?.error?.description || e.message || "Connection failed";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
}

/** Creates a Razorpay Order for one payment attempt. `amount` is in
 * rupees (converted to paise here, since that's Razorpay's unit). */
export async function createOrder(environment, { amountRupees, currency, receipt, notes }) {
  const result = await getClient(environment);
  if (!result) return null;
  return result.client.orders.create({
    amount: Math.round(amountRupees * 100),
    currency: currency || "INR",
    receipt,
    notes,
  });
}

/** Razorpay's documented checkout-verification algorithm: HMAC-SHA256 of
 * "<order_id>|<payment_id>" using the key_secret, compared against the
 * signature Razorpay's Checkout.js handler received. This is what makes
 * verification cryptographic rather than "trusting the browser's claim of
 * success" - the browser only relays Razorpay's own signed response;
 * this function is what actually decides whether to believe it. */
export function verifyPaymentSignature({ orderId, paymentId, signature, keySecret }) {
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  const expected = crypto.createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  return timingSafeEqualHex(expected, signature);
}

/** Verifies a Razorpay webhook's `X-Razorpay-Signature` header: HMAC-SHA256
 * of the exact raw request body using the webhook secret (a DIFFERENT
 * secret from key_secret, configured separately in the Razorpay dashboard
 * and in this app's integration config). Must be computed over the raw
 * byte body, not a re-serialized JSON.parse'd object - see
 * server/src/routes/paymentsPublic.js for how `rawBody` is captured. */
export function verifyWebhookSignature({ rawBody, signature, webhookSecret }) {
  if (!rawBody || !signature || !webhookSecret) return false;
  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  return timingSafeEqualHex(expected, signature);
}

function timingSafeEqualHex(expectedHex, actualHex) {
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(String(actualHex || ""), "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Creates a refund for a captured payment. `amountRupees` omitted means
 * a full refund of whatever remains; Razorpay itself also enforces this
 * server-side, but paymentService.js re-checks the refundable amount
 * against our own records before ever calling this. */
export async function createRefund(environment, { gatewayPaymentId, amountRupees, notes }) {
  const result = await getClient(environment);
  if (!result) throw new Error("Razorpay is not configured/enabled for this environment");
  const payload = { notes };
  if (amountRupees !== undefined) payload.amount = Math.round(amountRupees * 100);
  return result.client.payments.refund(gatewayPaymentId, payload);
}

/** Fetches a payment's current state directly from Razorpay - used by
 * reconciliation to compare against our local record without trusting
 * whatever our own webhook/verify handlers last recorded. */
export async function fetchPayment(environment, gatewayPaymentId) {
  const result = await getClient(environment);
  if (!result) return null;
  return result.client.payments.fetch(gatewayPaymentId);
}
