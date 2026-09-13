/**
 * Run with: npm run seed-admin
 * Creates the first Super Admin staff login using SEED_SUPERADMIN_EMAIL /
 * SEED_SUPERADMIN_PASSWORD from .env. Safe to re-run - does nothing if
 * that email already exists.
 *
 * Phase 9G: SEED_SUPERADMIN_PASSWORD used to silently fall back to the
 * hardcoded, source-committed "ChangeMe123!" (also printed in
 * .env.example) if unset, and this script echoed the real password back
 * to stdout unconditionally - a risk of it landing in deploy/CI logs.
 * Fixed the same way as P0-3 (JWT_SECRET/INTEGRATION_ENCRYPTION_KEY):
 * refuse to seed a real, persistent admin credential with a known-weak
 * or missing value, and never print the password back.
 */
import bcrypt from "bcryptjs";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { config } from "../config.js";

const KNOWN_WEAK_PASSWORDS = new Set(["changeme123!", "changeme", "password", "admin123", "12345678"]);

async function main() {
  const email = config.seed.superAdminEmail;
  const password = config.seed.superAdminPassword;

  if (!password) {
    throw new Error(
      "FATAL: SEED_SUPERADMIN_PASSWORD is not set. Refusing to seed a Super Admin without a real password. " +
      "Set a strong value in server/.env (see server/.env.example)."
    );
  }
  if (password.length < 8 || KNOWN_WEAK_PASSWORDS.has(password.toLowerCase())) {
    throw new Error(
      "FATAL: SEED_SUPERADMIN_PASSWORD is set but too weak or a known placeholder value. " +
      "Set a strong, non-default password in server/.env before seeding a real admin login."
    );
  }

  const { data: existing } = await supabaseAdmin().from("staff_users").select("id").ilike("email", email).maybeSingle();
  if (existing) {
    console.log(`Super Admin ${email} already exists - skipping.`);
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  const { error } = await supabaseAdmin().from("staff_users").insert({
    email, name: "Super Admin", role: "SuperAdmin", status: "active", password_hash: hash, invited_by: "seed-script",
  });
  if (error) throw error;

  // Never echo the password itself - the operator already knows it (they
  // set SEED_SUPERADMIN_PASSWORD), and printing it risks it landing in
  // deploy/CI log output.
  console.log(`Seeded Super Admin login: ${email}`);
  console.log(`IMPORTANT: log in with the password you set in SEED_SUPERADMIN_PASSWORD and change it immediately (Admin -> Change Password).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
