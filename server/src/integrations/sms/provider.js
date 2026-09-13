/**
 * SMS channel - a generic HTTP gateway adapter, not one hardcoded vendor
 * SDK. Unlike email (SMTP) or WhatsApp (Meta's Cloud API), there is no
 * single dominant request shape across SMS gateways (MSG91, Twilio,
 * Gupshup, TextLocal, a telco's own API, ...), so this defines one fixed,
 * documented HTTP contract and lets the admin point it at whichever
 * gateway's endpoint speaks it (most gateways offer a "custom HTTP/
 * webhook" send mode compatible with a simple JSON POST like this one).
 *
 * Config mapping onto the generic integration_configs row (unchanged
 * Phase 2 table - see integrationService.js):
 *   key_id                -> optional Sender ID (sent as `senderId` in the body)
 *   key_secret_encrypted  -> the gateway's API key/token
 *   extra.endpointUrl     -> the gateway's send-message HTTP endpoint (required)
 *   extra.authScheme      -> 'bearer' (default, `Authorization: Bearer <key>`)
 *                             or 'apikey' (sent under extra.authHeaderName)
 *   extra.authHeaderName  -> header name for the 'apikey' scheme (default 'X-API-Key')
 *
 * Request contract this adapter sends: `POST {endpointUrl}` with a JSON
 * body `{ to, message, senderId }` (senderId omitted if not configured)
 * and the auth header above. A 2xx response is treated as success; any
 * other status/network error is treated as failure. This is deliberately
 * the full extent of the mapping - no per-vendor field renaming/templating
 * engine, to keep this a minimal, auditable adapter rather than its own
 * mini integration-platform.
 */
import { getDecryptedCredentials, getIntegrationConfig, recordConnectionTest } from "../integrationService.js";

export const PROVIDER = "sms";
const REQUEST_TIMEOUT_MS = 8000;

async function getConfig(environment) {
  const creds = await getDecryptedCredentials(PROVIDER, environment);
  if (!creds?.keySecret) return null;
  const row = await getIntegrationConfig(PROVIDER, environment);
  if (!row?.extra?.endpointUrl) return null;
  return { senderId: creds.keyId || null, apiKey: creds.keySecret, ...row.extra };
}

export async function getActiveEnvironment() {
  for (const environment of ["production", "test"]) {
    if (await getConfig(environment)) return environment;
  }
  return null;
}

function authHeaders(cfg) {
  if (cfg.authScheme === "apikey") return { [cfg.authHeaderName || "X-API-Key"]: cfg.apiKey };
  return { Authorization: `Bearer ${cfg.apiKey}` };
}

/** Reachability-only check: there is no universal safe "ping" endpoint
 * across arbitrary SMS gateways, so this validates configuration
 * completeness and probes the endpoint with a lightweight, non-sending
 * HEAD request. A network-level success here does NOT guarantee the API
 * key itself is valid - that's only ever confirmed by an actual send,
 * same disclosure this function's own message gives the admin. */
export async function testConnection(environment) {
  const row = await getIntegrationConfig(PROVIDER, environment);
  if (!row) {
    const message = "No SMS gateway configuration saved yet for this environment.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
  if (!row.key_secret_encrypted || !row.extra?.endpointUrl) {
    const message = "Configuration is incomplete - an API key and an Endpoint URL are both required.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
  if (!row.enabled) {
    const message = "Configuration is saved, but this channel is currently disabled. Toggle Enabled and Save to activate it.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
  const cfg = await getConfig(environment);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    await fetch(cfg.endpointUrl, { method: "HEAD", headers: authHeaders(cfg), signal: controller.signal }).finally(() => clearTimeout(timer));
    const message = "Endpoint is reachable. This does not confirm the API key is valid - that's only verified on an actual send.";
    await recordConnectionTest(PROVIDER, environment, "success", message);
    return { success: true, message };
  } catch (e) {
    const message = `Endpoint was not reachable: ${e.message || "network error"}`;
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
}

/** Sends one SMS. Throws on failure - see email/provider.js's send() for
 * the same contract (caller is responsible for catching/recording it). */
export async function send(environment, { to, message }) {
  const cfg = await getConfig(environment);
  if (!cfg) throw new Error("SMS is not configured/enabled for this environment");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(cfg.endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(cfg) },
      body: JSON.stringify({ to, message, ...(cfg.senderId ? { senderId: cfg.senderId } : {}) }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`SMS gateway responded with ${resp.status}`);
  } finally {
    clearTimeout(timer);
  }
}
