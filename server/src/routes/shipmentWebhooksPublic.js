/**
 * Phase 8B - generic courier webhook receiver (server-to-server, no
 * customer/staff auth - a valid provider signature IS the authentication,
 * same trust model as paymentsPublic.js's Razorpay webhook). Mounted at
 * /api/public/shipping-webhooks/:provider so a future courier's dashboard
 * can be pointed at one URL per provider without a route change.
 *
 * "manual" (the only provider registered today - see ../integrations/
 * shipping/registry.js) exports neither verifyWebhookSignature nor
 * mapWebhookStatus, since there is no external system to receive a
 * webhook from - a request here for it correctly 404s below. This route
 * exists now, fully wired end-to-end (signature check -> idempotent
 * recording -> status mapping -> shipmentService.processShipmentWebhookEvent),
 * so a real courier added later only needs its own provider module; no
 * change here or in shipmentService.js.
 */
import { Router } from "express";
import { asyncRoute } from "../utils/apiResponse.js";
import { SHIPPING_PROVIDERS } from "../integrations/shipping/registry.js";
import { getDecryptedCredentials } from "../integrations/integrationService.js";
import * as shipmentService from "../services/shipmentService.js";

const router = Router();

router.post(
  "/:provider",
  asyncRoute(async (req, res) => {
    const provider = req.params.provider;
    const mod = SHIPPING_PROVIDERS[provider];
    if (!mod || typeof mod.verifyWebhookSignature !== "function" || typeof mod.mapWebhookStatus !== "function") {
      return res.status(404).json({ error: `Unknown or non-webhook-capable shipping provider: ${provider}` });
    }

    const signature = req.headers["x-webhook-signature"];
    const rawBody = req.rawBody; // captured globally by express.json's verify() in src/index.js
    if (!rawBody) return res.status(400).json({ error: "Missing body" });

    let signatureValid = false;
    for (const environment of ["production", "test"]) {
      const creds = await getDecryptedCredentials(provider, environment);
      if (!creds?.webhookSecret) continue;
      if (mod.verifyWebhookSignature({ rawBody, signature, webhookSecret: creds.webhookSecret })) {
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

    const eventId = req.headers["x-webhook-event-id"] || payload?.event_id || `${provider}-${Date.now()}`;
    const eventType = payload?.event_type || payload?.event || "unknown";
    // Provider-specific parsing lives ENTIRELY in the provider module -
    // shipmentService.processShipmentWebhookEvent only ever sees the
    // already-mapped internal status/identifiers, never a raw payload
    // shape it would have to understand.
    const newStatus = signatureValid ? mod.mapWebhookStatus(payload) : null;

    const result = await shipmentService.processShipmentWebhookEvent({
      provider, eventId, eventType, payload, signatureValid,
      newStatus,
      providerShipmentId: payload?.provider_shipment_id || null,
      awbNumber: payload?.awb_number || null,
    });

    if (!signatureValid) return res.status(400).json({ received: true, ...result });
    res.json({ received: true, ...result });
  })
);

export default router;
