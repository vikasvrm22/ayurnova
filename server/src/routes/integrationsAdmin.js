/**
 * Admin API for the generic Integration Management foundation
 * (server/src/integrations/). Razorpay is its first consumer but this
 * router itself has no Razorpay-specific logic beyond the one
 * provider-dispatch in the /test-connection route.
 */
import { Router } from "express";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import {
  listIntegrationConfigs, getIntegrationConfig, upsertIntegrationConfig, setEnabled, toSafeView, ENVIRONMENTS,
} from "../integrations/integrationService.js";
import * as razorpayProvider from "../integrations/razorpay/provider.js";
import * as emailProvider from "../integrations/email/provider.js";
import * as smsProvider from "../integrations/sms/provider.js";
import * as whatsappProvider from "../integrations/whatsapp/provider.js";

const router = Router();
router.use(requireStaffAuth, requirePermission("manageIntegrations"));

// Phase 7: email/sms/whatsapp are notification channels, not payment
// gateways, but they reuse this exact same generic (provider, environment)
// foundation unchanged - see integrationService.js's own original comment
// ("Razorpay is its first consumer... a future SMS/email provider reuses
// this same table"), now realized.
const PROVIDERS = {
  razorpay: razorpayProvider,
  email: emailProvider,
  sms: smsProvider,
  whatsapp: whatsappProvider,
};

function assertValidProviderEnv(req, res) {
  const { provider, environment } = req.params;
  if (!PROVIDERS[provider]) {
    res.status(404).json({ error: `Unknown provider: ${provider}` });
    return false;
  }
  if (!ENVIRONMENTS.includes(environment)) {
    res.status(400).json({ error: `Invalid environment: must be one of ${ENVIRONMENTS.join(", ")}` });
    return false;
  }
  return true;
}

router.get("/", async (req, res, next) => {
  try {
    const rows = await listIntegrationConfigs();
    res.json({ items: rows.map(toSafeView) });
  } catch (e) {
    next(e);
  }
});

router.get("/:provider/:environment", async (req, res, next) => {
  try {
    if (!assertValidProviderEnv(req, res)) return;
    const row = await getIntegrationConfig(req.params.provider, req.params.environment);
    res.json({ item: toSafeView(row) });
  } catch (e) {
    next(e);
  }
});

router.put("/:provider/:environment", async (req, res, next) => {
  try {
    if (!assertValidProviderEnv(req, res)) return;
    const { keyId, keySecret, webhookSecret, enabled, extra } = req.body || {};
    const row = await upsertIntegrationConfig(
      req.params.provider, req.params.environment,
      { keyId, keySecret, webhookSecret, enabled, extra },
      req.staff.email
    );
    res.json({ item: toSafeView(row) });
  } catch (e) {
    next(e);
  }
});

router.post("/:provider/:environment/enable", async (req, res, next) => {
  try {
    if (!assertValidProviderEnv(req, res)) return;
    const row = await setEnabled(req.params.provider, req.params.environment, true, req.staff.email);
    res.json({ item: toSafeView(row) });
  } catch (e) {
    next(e);
  }
});

router.post("/:provider/:environment/disable", async (req, res, next) => {
  try {
    if (!assertValidProviderEnv(req, res)) return;
    const row = await setEnabled(req.params.provider, req.params.environment, false, req.staff.email);
    res.json({ item: toSafeView(row) });
  } catch (e) {
    next(e);
  }
});

// ---- Connection test abstraction: every provider module exposes
// testConnection(environment); this route dispatches to whichever one
// the path names, never assuming Razorpay specifically. ----
router.post("/:provider/:environment/test-connection", async (req, res, next) => {
  try {
    if (!assertValidProviderEnv(req, res)) return;
    const result = await PROVIDERS[req.params.provider].testConnection(req.params.environment);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
