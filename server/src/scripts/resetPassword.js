/**
 * Usage: npm run reset-password -- <email> <newPassword> [role]
 * Resets an existing staff login's password, or creates a new one (default
 * role SuperAdmin) if that email doesn't exist yet.
 */
import bcrypt from "bcryptjs";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { validatePassword } from "../validation/validators.js";
import { ROLES } from "../config.js";

async function main() {
  const [, , email, newPassword, roleArg] = process.argv;
  if (!email || !newPassword) {
    console.error("Usage: npm run reset-password -- <email> <newPassword> [role]");
    process.exit(1);
  }
  if (!validatePassword(newPassword)) {
    console.error("Password must be at least 10 characters and include at least one letter and one number.");
    process.exit(1);
  }
  const role = roleArg || "SuperAdmin";
  if (!ROLES.includes(role)) {
    console.error(`Role must be one of: ${ROLES.join(", ")}`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(newPassword, 10);
  const { data: existing } = await supabaseAdmin().from("staff_users").select("id").ilike("email", email).maybeSingle();

  if (existing) {
    const { error } = await supabaseAdmin().from("staff_users").update({ password_hash: hash, status: "active" }).eq("id", existing.id);
    if (error) throw error;
    console.log(`Password reset for existing user: ${email}`);
  } else {
    const { error } = await supabaseAdmin().from("staff_users").insert({
      email, name: email.split("@")[0], role, status: "active", password_hash: hash, invited_by: "reset-password-script",
    });
    if (error) throw error;
    console.log(`Created new ${role} user: ${email}`);
  }
  console.log(`Log in with that email and the password you just set.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
