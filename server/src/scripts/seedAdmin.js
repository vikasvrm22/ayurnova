/**
 * Run with: npm run seed-admin
 * Creates the first Super Admin staff login using SEED_SUPERADMIN_EMAIL /
 * SEED_SUPERADMIN_PASSWORD from .env. Safe to re-run - does nothing if
 * that email already exists.
 */
import bcrypt from "bcryptjs";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { config } from "../config.js";

async function main() {
  const email = config.seed.superAdminEmail;
  const password = config.seed.superAdminPassword;

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

  console.log(`Seeded Super Admin login: ${email} / ${password}`);
  console.log(`IMPORTANT: log in and change this password immediately (Admin -> Change Password).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
