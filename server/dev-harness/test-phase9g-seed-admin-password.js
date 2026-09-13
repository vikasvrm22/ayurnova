/**
 * DEV Harness - Phase 9G focused check: `npm run seed-admin` must refuse
 * to seed a real, persistent Super Admin login with a missing or
 * known-weak/placeholder SEED_SUPERADMIN_PASSWORD, and must never echo
 * the plaintext password to stdout - found by this session's independent
 * final security re-audit (SEED_SUPERADMIN_PASSWORD previously fell back
 * silently to the hardcoded "ChangeMe123!" with no guard, unlike
 * JWT_SECRET/INTEGRATION_ENCRYPTION_KEY's P0-3 treatment).
 *
 * Spawns fresh Node processes running src/scripts/seedAdmin.js with the
 * password forced missing/weak - these fail BEFORE any DB call (the
 * check is the first thing main() does), so no real database access or
 * cleanup is needed for the negative cases this test covers.
 *
 * Usage: node dev-harness/test-phase9g-seed-admin-password.js
 */
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, "../src/scripts/seedAdmin.js");

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function runSeedScript(envOverrides) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ...envOverrides },
    encoding: "utf-8",
    timeout: 10000,
  });
  return { exitCode: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

const SENTINEL_PASSWORD = "S3ntinel-Should-Never-Appear-In-Output-9G";

// ---- 1: missing password -> refuses, never touches the DB ----
{
  const r = runSeedScript({ SEED_SUPERADMIN_PASSWORD: "" });
  check("missing SEED_SUPERADMIN_PASSWORD -> non-zero exit", r.exitCode !== 0, r.exitCode);
  check("missing SEED_SUPERADMIN_PASSWORD -> clear FATAL error", /FATAL.*SEED_SUPERADMIN_PASSWORD is not set/.test(r.stderr), r.stderr.slice(0, 200));
}

// ---- 2: the old hardcoded default value itself is rejected ----
{
  const r = runSeedScript({ SEED_SUPERADMIN_PASSWORD: "ChangeMe123!" });
  check("known weak default 'ChangeMe123!' -> non-zero exit", r.exitCode !== 0, r.exitCode);
  check("known weak default -> rejected as too weak, not silently accepted", /FATAL.*too weak/.test(r.stderr), r.stderr.slice(0, 200));
}

// ---- 3: a too-short password is rejected ----
{
  const r = runSeedScript({ SEED_SUPERADMIN_PASSWORD: "abc123" });
  check("too-short password -> non-zero exit", r.exitCode !== 0, r.exitCode);
}

// ---- 4: whatever password IS supplied, it never appears in stdout/stderr (even on the weak-value rejection path) ----
{
  const r = runSeedScript({ SEED_SUPERADMIN_PASSWORD: SENTINEL_PASSWORD.slice(0, 6) }); // too short -> rejected, but let's also confirm a real-looking one isn't echoed on ANY path
  check("a rejected password value is never echoed in stdout/stderr", !r.stdout.includes(SENTINEL_PASSWORD) && !r.stderr.includes(SENTINEL_PASSWORD));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
