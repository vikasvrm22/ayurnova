/**
 * AES-256-GCM encryption for integration secrets (Razorpay key_secret,
 * webhook_secret, and any future provider's credentials). Uses Node's
 * built-in `crypto` module - no new dependency needed.
 *
 * The encryption key comes from INTEGRATION_ENCRYPTION_KEY (any string -
 * hashed with SHA-256 to get exactly 32 bytes, so the env var doesn't need
 * to be a precisely-formatted key). Never log, return, or expose the
 * decrypted value outside server-internal code - see integrationService.js
 * for the boundary between "decrypted, server-internal use" and "masked,
 * safe for an API response".
 */
import crypto from "node:crypto";
import { config } from "../config.js";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function deriveKey() {
  return crypto.createHash("sha256").update(config.integrationEncryptionKey).digest();
}

/** Encrypts a plaintext secret. Returns null for an empty/missing value
 * (so "no secret configured" round-trips as null, not a junk ciphertext). */
export function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === "") return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // One column holds everything needed to decrypt: iv + authTag + ciphertext, base64-encoded.
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptSecret(stored) {
  if (!stored) return null;
  const buf = Buffer.from(stored, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGO, deriveKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Masks a secret for display in the admin UI - shows only the last 4
 * characters, e.g. "rzp_test_abc123" -> "•••••••••••123". Never sent to
 * any client except the admin panel, and never the full value. */
export function maskSecret(plaintext) {
  if (!plaintext) return null;
  const s = String(plaintext);
  if (s.length <= 4) return "••••";
  return "•".repeat(s.length - 4) + s.slice(-4);
}
