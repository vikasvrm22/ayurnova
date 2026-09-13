/**
 * DEV Harness - Phase 9A P0-3 checks (secret fallback removal).
 *
 * JWT_SECRET and INTEGRATION_ENCRYPTION_KEY used to silently fall back to
 * hardcoded, source-committed default values if unset - if either var
 * were ever missing in production, admin JWTs become forgeable and/or
 * integration credentials get encrypted with a publicly-visible key. This
 * spawns fresh Node processes with each var forced missing/weak/known-
 * placeholder and asserts that loading server/src/config.js throws
 * immediately (fail-fast, before the server ever binds a port), and that
 * the resulting error text never contains the secret value itself. No DB,
 * no network, no running server required.
 *
 * Usage: node dev-harness/test-phase9a-secrets.js
 */
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "../src/config.js").replace(/\\/g, "/");

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function tryLoadConfig(envOverrides) {
  const result = spawnSync(
    process.execPath,
    ["-e", `import(${JSON.stringify("file:///" + CONFIG_PATH)}).then(()=>{console.log("BOOTED_OK")}).catch(e=>{console.error("BOOT_FAILED: " + e.message); process.exit(1)})`],
    {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, ...envOverrides },
      encoding: "utf-8",
      timeout: 10000,
    }
  );
  return {
    exitCode: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

const REAL_JWT = "1521f2b0ef2db0709b935884f46ad0aebae0398a3a6469d49ee23fad711874746abf58ff7a1303438575a2b5bc1b7b53";
const REAL_KEY = "d036b8392fcec0a963ff56eebb9615d7b94983286db86229bfe0e1dc552fa831019161282a84ec99cba6776de67fe1cd";

// ---- 1: both real secrets set -> boots successfully ----
{
  const r = tryLoadConfig({ JWT_SECRET: REAL_JWT, INTEGRATION_ENCRYPTION_KEY: REAL_KEY });
  check("boots successfully with two real random secrets set", r.exitCode === 0 && r.stdout.includes("BOOTED_OK"), `exit=${r.exitCode} stdout=${r.stdout.trim()}`);
}

// ---- 2: JWT_SECRET missing -> fails fast, no hardcoded fallback ----
{
  const r = tryLoadConfig({ JWT_SECRET: "", INTEGRATION_ENCRYPTION_KEY: REAL_KEY });
  check("JWT_SECRET missing -> boot fails (no silent fallback)", r.exitCode !== 0 && r.stderr.includes("JWT_SECRET"), r.stderr.trim());
  check("JWT_SECRET missing -> never boots with old hardcoded default", !r.stdout.includes("BOOTED_OK"));
}

// ---- 3: INTEGRATION_ENCRYPTION_KEY missing -> fails fast ----
{
  const r = tryLoadConfig({ JWT_SECRET: REAL_JWT, INTEGRATION_ENCRYPTION_KEY: "" });
  check("INTEGRATION_ENCRYPTION_KEY missing -> boot fails (no silent fallback)", r.exitCode !== 0 && r.stderr.includes("INTEGRATION_ENCRYPTION_KEY"), r.stderr.trim());
}

// ---- 4: known-weak placeholder values are rejected even when "set" ----
{
  const r = tryLoadConfig({ JWT_SECRET: "dev-secret-change-me", INTEGRATION_ENCRYPTION_KEY: REAL_KEY });
  check("old hardcoded JWT default value itself is rejected if copy-pasted into env", r.exitCode !== 0, r.stderr.trim());
}
{
  const r = tryLoadConfig({ JWT_SECRET: REAL_JWT, INTEGRATION_ENCRYPTION_KEY: "dev-insecure-integration-key-change-me" });
  check("old hardcoded encryption-key default value itself is rejected if copy-pasted into env", r.exitCode !== 0, r.stderr.trim());
}
{
  const r = tryLoadConfig({ JWT_SECRET: "change-this-to-a-long-random-string", INTEGRATION_ENCRYPTION_KEY: REAL_KEY });
  check(".env.example's own placeholder text is rejected, not accepted as a real secret", r.exitCode !== 0, r.stderr.trim());
}

// ---- 5: too-short value is rejected ----
{
  const r = tryLoadConfig({ JWT_SECRET: "too-short", INTEGRATION_ENCRYPTION_KEY: REAL_KEY });
  check("a too-short JWT_SECRET is rejected", r.exitCode !== 0, r.stderr.trim());
}

// ---- 6: never leak the actual secret value in error output ----
{
  const secretCanary = "CANARY_SECRET_VALUE_MUST_NOT_APPEAR_1234567890";
  const r = tryLoadConfig({ JWT_SECRET: secretCanary.slice(0, 10), INTEGRATION_ENCRYPTION_KEY: REAL_KEY }); // too short, will fail
  check("error output never echoes the rejected secret value itself", !r.stderr.includes(secretCanary.slice(0, 10)), r.stderr.trim());
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures > 0 ? 1 : 0);
