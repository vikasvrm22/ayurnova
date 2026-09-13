/**
 * WhatsApp channel - Meta's WhatsApp Business Cloud API, the de facto
 * standard contract (used directly or mirrored by virtually every BSP
 * reseller), so targeting it specifically here is the "provider-agnostic
 * for WhatsApp" choice rather than a narrow vendor pick the way a
 * random SMS gateway SDK would be.
 *
 * Config mapping onto the generic integration_configs row (unchanged
 * Phase 2 table - see integrationService.js):
 *   key_id                -> WhatsApp Phone Number ID
 *   key_secret_encrypted  -> the Cloud API access token
 *   extra.apiVersion      -> Graph API version, defaults to 'v19.0'
 */
import { getDecryptedCredentials, getIntegrationConfig, recordConnectionTest } from "../integrationService.js";

export const PROVIDER = "whatsapp";
const REQUEST_TIMEOUT_MS = 8000;

async function getConfig(environment) {
  const creds = await getDecryptedCredentials(PROVIDER, environment);
  if (!creds?.keyId || !creds?.keySecret) return null;
  const row = await getIntegrationConfig(PROVIDER, environment);
  return { phoneNumberId: creds.keyId, accessToken: creds.keySecret, apiVersion: row?.extra?.apiVersion || "v19.0" };
}

export async function getActiveEnvironment() {
  for (const environment of ["production", "test"]) {
    if (await getConfig(environment)) return environment;
  }
  return null;
}

function withTimeout() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** Non-mutating connection test: fetches the configured phone number's own
 * metadata (a plain GET, changes nothing) to confirm the phone number id
 * and access token are both valid - the WhatsApp equivalent of razorpay/
 * provider.js's `orders.all({count:1})`. */
export async function testConnection(environment) {
  const row = await getIntegrationConfig(PROVIDER, environment);
  if (!row) {
    const message = "No WhatsApp credentials saved yet for this environment.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
  if (!row.key_id || !row.key_secret_encrypted) {
    const message = "Configuration is incomplete - both a Phone Number ID and an Access Token are required.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
  if (!row.enabled) {
    const message = "Configuration is saved, but this channel is currently disabled. Toggle Enabled and Save to activate it.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
  const cfg = await getConfig(environment);
  const { signal, clear } = withTimeout();
  try {
    const resp = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}?fields=display_phone_number`, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
      signal,
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const message = body?.error?.message || `WhatsApp API responded with ${resp.status}`;
      await recordConnectionTest(PROVIDER, environment, "failed", message);
      return { success: false, message };
    }
    await recordConnectionTest(PROVIDER, environment, "success", "Connected successfully");
    return { success: true, message: "Connected successfully" };
  } catch (e) {
    const message = e.message || "Connection failed";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  } finally {
    clear();
  }
}

/** Sends one plain-text WhatsApp message. Throws on failure - see
 * email/provider.js's send() for the same contract. Note: outside Meta's
 * 24-hour customer-service window, a free-form text message like this one
 * is only deliverable if the recipient messaged the business number
 * first, or if a pre-approved template message is used instead - this
 * adapter intentionally sends only free-form text (the minimal, template-
 * approval-free option) and never registers/manages templates. */
export async function send(environment, { to, message }) {
  const cfg = await getConfig(environment);
  if (!cfg) throw new Error("WhatsApp is not configured/enabled for this environment");
  const { signal, clear } = withTimeout();
  try {
    const resp = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.accessToken}` },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: message } }),
      signal,
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body?.error?.message || `WhatsApp API responded with ${resp.status}`);
    }
  } finally {
    clear();
  }
}
