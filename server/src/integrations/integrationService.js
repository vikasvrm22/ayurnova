/**
 * Generic integration-credential management - Razorpay is its first and
 * currently only consumer, but nothing here is Razorpay-specific: a row
 * is keyed by (provider, environment), so a future gateway/SMS/email
 * provider reuses this same table and these same functions rather than
 * getting its own parallel credential-storage system.
 *
 * Boundary to respect everywhere this is used: `getDecryptedCredentials`
 * returns plaintext secrets for server-internal use only (building a
 * Razorpay client, computing an HMAC) and must NEVER be returned from an
 * API response. `toSafeView` is what every admin API response uses
 * instead - it only ever contains a masked secret preview.
 */
import { supabaseAdmin } from "../db/supabaseClient.js";
import { encryptSecret, decryptSecret, maskSecret } from "./crypto.js";
import { AppError } from "../utils/apiResponse.js";

export const ENVIRONMENTS = ["test", "production"];

async function logIntegrationActivity(provider, environment, action, actor) {
  await supabaseAdmin().from("activity_log").insert({
    entity_type: "integration", entity_id: `${provider}:${environment}`, action, actor,
  });
}

export async function listIntegrationConfigs() {
  const { data, error } = await supabaseAdmin().from("integration_configs").select("*").order("provider").order("environment");
  if (error) throw error;
  return data || [];
}

export async function getIntegrationConfig(provider, environment) {
  const { data, error } = await supabaseAdmin()
    .from("integration_configs").select("*").eq("provider", provider).eq("environment", environment).maybeSingle();
  if (error) throw error;
  return data;
}

/** Decrypted credentials for internal server use ONLY. Returns null if no
 * config exists or the integration is disabled - callers should treat
 * both cases identically ("this gateway/environment isn't usable"). */
export async function getDecryptedCredentials(provider, environment) {
  const row = await getIntegrationConfig(provider, environment);
  if (!row || !row.enabled) return null;
  return {
    keyId: row.key_id,
    keySecret: decryptSecret(row.key_secret_encrypted),
    webhookSecret: decryptSecret(row.webhook_secret_encrypted),
  };
}

/** Masked, API-response-safe shape. Never includes a decrypted secret. */
export function toSafeView(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    environment: row.environment,
    enabled: row.enabled,
    keyId: row.key_id || null,
    keySecretConfigured: !!row.key_secret_encrypted,
    keySecretMasked: row.key_secret_encrypted ? maskSecret(decryptSecret(row.key_secret_encrypted)) : null,
    webhookSecretConfigured: !!row.webhook_secret_encrypted,
    // Non-secret, provider-specific config (SMTP host/port, an SMS
    // gateway's endpoint URL, a WhatsApp API version, etc.) - safe to
    // return as-is, same boundary the column's own comment in
    // 0002_phase2_payments_and_integrations.sql already documents
    // ("room for provider-specific non-secret config").
    extra: row.extra || {},
    lastTestedAt: row.last_tested_at,
    lastTestStatus: row.last_test_status,
    lastTestMessage: row.last_test_message,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** Creates/updates one (provider, environment) config. Only overwrites a
 * secret field when a non-empty new value is explicitly given - omitting
 * it (e.g. the admin is only toggling `enabled`, or updating key_id)
 * leaves the existing encrypted secret untouched rather than blanking it.
 * `extra` (Phase 7) is merged shallowly over whatever's already stored,
 * so a caller updating one non-secret field (e.g. just `fromEmail`)
 * never has to resend every other one to avoid blanking it. */
export async function upsertIntegrationConfig(provider, environment, { keyId, keySecret, webhookSecret, enabled, extra }, actorEmail) {
  if (!ENVIRONMENTS.includes(environment)) {
    throw new AppError(`Invalid environment: must be one of ${ENVIRONMENTS.join(", ")}`, 400, "INVALID_ENVIRONMENT");
  }
  const patch = { provider, environment, updated_by: actorEmail, updated_at: new Date().toISOString() };
  if (keyId !== undefined) patch.key_id = keyId || null;
  if (keySecret !== undefined && keySecret !== "") patch.key_secret_encrypted = encryptSecret(keySecret);
  if (webhookSecret !== undefined && webhookSecret !== "") patch.webhook_secret_encrypted = encryptSecret(webhookSecret);
  if (enabled !== undefined) patch.enabled = !!enabled;
  if (extra !== undefined && extra !== null && typeof extra === "object") {
    const existing = await getIntegrationConfig(provider, environment);
    patch.extra = { ...(existing?.extra || {}), ...extra };
  }

  const { data, error } = await supabaseAdmin()
    .from("integration_configs")
    .upsert(patch, { onConflict: "provider,environment" })
    .select()
    .single();
  if (error) throw error;

  await logIntegrationActivity(provider, environment, "config_updated", actorEmail);
  return data;
}

export async function setEnabled(provider, environment, enabled, actorEmail) {
  const existing = await getIntegrationConfig(provider, environment);
  if (!existing) throw new AppError("No configuration exists for this provider/environment yet", 404, "INTEGRATION_NOT_FOUND");
  const { data, error } = await supabaseAdmin()
    .from("integration_configs")
    .update({ enabled: !!enabled, updated_by: actorEmail, updated_at: new Date().toISOString() })
    .eq("provider", provider).eq("environment", environment)
    .select().single();
  if (error) throw error;
  await logIntegrationActivity(provider, environment, enabled ? "enabled" : "disabled", actorEmail);
  return data;
}

export async function recordConnectionTest(provider, environment, status, message) {
  await supabaseAdmin().from("integration_configs").update({
    last_tested_at: new Date().toISOString(), last_test_status: status, last_test_message: message,
  }).eq("provider", provider).eq("environment", environment);
}
