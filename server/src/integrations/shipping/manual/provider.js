/**
 * "Manual" courier - the only provider Phase 8B ships with. Needs no
 * credentials at all (staff enter AWB/courier name/status by hand, same
 * information admins already typed into the old bare tracking-number
 * field), so it's seeded pre-enabled for both environments (see migration
 * 0011's seed insert) - a real courier can be added later purely by
 * writing one more module with this exact same shape and registering it
 * in ../registry.js, without touching order/shipment business logic at all
 * (see shipmentService.js, which never imports a provider module directly
 * except through that registry).
 *
 * Every shipping provider module implements:
 *   PROVIDER, LABEL
 *   getActiveEnvironment() -> 'test'|'production'|null
 *   testConnection(environment) -> {success, message}
 *   createShipment(environment, {order, items}) -> {
 *     providerShipmentId, awbNumber, courierName, labelUrl, trackingUrl, eta, raw
 *   }
 *   cancelShipment(environment, providerShipmentId) -> {success}
 * A provider that can receive a courier webhook additionally exports
 * verifyWebhookSignature({rawBody, signature, webhookSecret}) and
 * mapWebhookStatus(payload) -> one of shipmentService.SHIPMENT_STATUSES or
 * null for an event with no status meaning - see server/src/routes/
 * shipmentWebhooksPublic.js, which checks for their presence before ever
 * dispatching to a provider. "manual" has neither: there is no external
 * system to receive a webhook from.
 */
import { getIntegrationConfig, recordConnectionTest } from "../../integrationService.js";

export const PROVIDER = "manual";
export const LABEL = "Manual (staff-entered tracking)";

/** Production if enabled, else test if enabled, else null - same
 * deterministic preference order every other provider in this codebase
 * already uses (razorpay/email/sms/whatsapp). */
export async function getActiveEnvironment() {
  for (const environment of ["production", "test"]) {
    const row = await getIntegrationConfig(PROVIDER, environment);
    if (row?.enabled) return environment;
  }
  return null;
}

export async function testConnection(environment) {
  const row = await getIntegrationConfig(PROVIDER, environment);
  if (!row) {
    const message = "Not configured yet - this should not normally happen, since migration 0011 seeds this provider automatically.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
  if (!row.enabled) {
    const message = "This channel is currently disabled. Toggle Enabled and Save to activate it.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
  const message = "Manual courier requires no external connection - shipments are tracked entirely by staff-entered AWB/status.";
  await recordConnectionTest(PROVIDER, environment, "success", message);
  return { success: true, message };
}

/** No external system to call - returns an empty shell that staff fill in
 * afterward via PUT /api/admin/shipments/:id (courier name, AWB, label
 * URL, tracking URL, ETA), exactly the information the old bare
 * "Tracking Number" field used to hold, just modeled as a real shipment
 * now instead of a single free-text order column. */
export async function createShipment(_environment, _context) {
  return {
    providerShipmentId: null,
    awbNumber: null,
    courierName: null,
    labelUrl: null,
    trackingUrl: null,
    eta: null,
    raw: {},
  };
}

/** Nothing external to cancel. */
export async function cancelShipment(_environment, _providerShipmentId) {
  return { success: true };
}
