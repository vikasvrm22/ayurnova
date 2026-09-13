/**
 * Email channel - generic SMTP (works with Gmail SMTP, Amazon SES SMTP,
 * SendGrid/Mailgun SMTP relay, a business's own mail server, etc.) so this
 * is genuinely provider-agnostic rather than tied to one vendor's API.
 * Same shape as server/src/integrations/razorpay/provider.js: this is the
 * ONLY file that imports `nodemailer`; every caller (the notification
 * dispatcher) goes through getClient()/send()/testConnection() here.
 *
 * Config mapping onto the generic integration_configs row (Phase 2 table,
 * unchanged - see integrationService.js):
 *   key_id                -> SMTP username
 *   key_secret_encrypted  -> SMTP password
 *   extra.host            -> SMTP host
 *   extra.port            -> SMTP port (defaults to 587)
 *   extra.secure          -> true for implicit TLS (port 465), false for STARTTLS
 *   extra.fromEmail       -> the "From" address customers see
 *   extra.fromName        -> the "From" display name
 */
import nodemailer from "nodemailer";
import { getDecryptedCredentials, getIntegrationConfig, recordConnectionTest } from "../integrationService.js";

export const PROVIDER = "email";

function buildTransport(creds, extra) {
  if (!creds?.keyId || !creds?.keySecret || !extra?.host || !extra?.fromEmail) return null;
  const transporter = nodemailer.createTransport({
    host: extra.host,
    port: Number(extra.port) || 587,
    secure: !!extra.secure,
    auth: { user: creds.keyId, pass: creds.keySecret },
    // Never let one slow/hanging SMTP handshake stall a checkout/order
    // status response - the caller (notificationService.js) already
    // treats any failure here as "log and move on", but a bounded
    // connection timeout keeps that failure fast rather than eventually.
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000,
  });
  return { transporter, fromEmail: extra.fromEmail, fromName: extra.fromName || "" };
}

/** Builds a transporter for one environment, or null if that environment
 * has no enabled/complete configuration. */
export async function getClient(environment) {
  const creds = await getDecryptedCredentials(PROVIDER, environment);
  if (!creds) return null;
  const row = await getIntegrationConfig(PROVIDER, environment);
  return buildTransport(creds, row?.extra || {});
}

/** Production if enabled and usable, else test, else null - same
 * deterministic preference order as razorpay/provider.js's
 * getActiveEnvironment(), so "which config actually sends right now" is
 * answered identically across every channel. */
export async function getActiveEnvironment() {
  for (const environment of ["production", "test"]) {
    if (await getClient(environment)) return environment;
  }
  return null;
}

/** Read-only-in-spirit check: nodemailer's verify() opens a connection and
 * confirms the SMTP server accepts the given auth, without sending any
 * mail - the email equivalent of razorpay/provider.js's non-mutating
 * `orders.all({count:1})` connection test. */
export async function testConnection(environment) {
  const row = await getIntegrationConfig(PROVIDER, environment);
  if (!row) {
    const message = "No SMTP credentials saved yet for this environment.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
  if (!row.key_id || !row.key_secret_encrypted || !row.extra?.host || !row.extra?.fromEmail) {
    const message = "Configuration is incomplete - SMTP username, password, host, and From email are all required.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
  if (!row.enabled) {
    const message = "Configuration is saved, but this channel is currently disabled. Toggle Enabled and Save to activate it.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
  const client = await getClient(environment);
  if (!client) {
    const message = "Configuration could not be loaded for this environment.";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
  try {
    await client.transporter.verify();
    await recordConnectionTest(PROVIDER, environment, "success", "Connected successfully");
    return { success: true, message: "Connected successfully" };
  } catch (e) {
    const message = e.message || "Connection failed";
    await recordConnectionTest(PROVIDER, environment, "failed", message);
    return { success: false, message };
  }
}

/** Sends one email. Throws on failure - the caller (notificationService.js)
 * is responsible for catching this and recording it, never for letting it
 * propagate to whatever business action triggered the notification. */
export async function send(environment, { to, subject, text, html }) {
  const client = await getClient(environment);
  if (!client) throw new Error("Email is not configured/enabled for this environment");
  const from = client.fromName ? `"${client.fromName}" <${client.fromEmail}>` : client.fromEmail;
  await client.transporter.sendMail({ from, to, subject, text, html: html || undefined });
}
