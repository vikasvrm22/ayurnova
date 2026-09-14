/**
 * DEV Harness - regression check for the admin login "Session expired"
 * mis-reporting bug.
 *
 * Root cause: `admin/js/api.js`'s `Api.request()` treats ANY 401 response
 * as "your existing session token is invalid/expired" - clearing storage,
 * redirecting to login.html, and always throwing the fixed string
 * "Session expired". But `POST /api/admin/auth/login` also legitimately
 * returns 401 for *wrong credentials* (see adminAuthRoutes.js), which is a
 * completely different situation: there is no token yet to expire. Before
 * the fix, a wrong password on the login page discarded the server's real
 * "Invalid credentials" message and showed the misleading "Session
 * expired" instead - looking exactly like a stale-session bug even on a
 * fresh login attempt.
 *
 * This test loads the REAL, shipped `admin/js/api.js` (not a
 * reimplementation) with minimal browser-global shims and exercises it
 * against the real running server, so it fails again if this regresses -
 * whether by editing api.js back to the old behaviour, or by changing the
 * login route's status code.
 *
 * Never logs the actual credential/token values, only booleans/messages.
 *
 * Usage: node dev-harness/test-admin-login-error-message.js
 */
import "dotenv/config.js";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || "http://localhost:5100";
const API_JS_PATH = path.join(__dirname, "../../admin/js/api.js");

const SEED_EMAIL = process.env.SEED_SUPERADMIN_EMAIL;
const SEED_PASSWORD = process.env.SEED_SUPERADMIN_PASSWORD;

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

/** Loads the real, shipped admin/js/api.js into an isolated sandbox with
 * just enough browser globals (localStorage, location, fetch) for its
 * `Api.request()` to run unmodified against the real server. */
function loadRealApiJs({ initialPathname }) {
  const src = fs.readFileSync(API_JS_PATH, "utf8");
  const localStorage = makeLocalStorage();
  const location = { pathname: initialPathname, href: null };
  const sandbox = {
    window: {},
    localStorage,
    location,
    fetch: (url, opts) => fetch(`${BASE_URL}${url}`, opts),
    console,
  };
  sandbox.window.localStorage = localStorage;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "admin/js/api.js" });
  return { Api: sandbox.window.Api, localStorage, location };
}

if (!SEED_EMAIL || !SEED_PASSWORD) {
  console.log("SEED_SUPERADMIN_EMAIL/PASSWORD not set in server/.env - skipping (needs a seeded admin to test a real successful login).");
  process.exit(0);
}

const health = await fetch(`${BASE_URL}/api/health`).then((r) => r.status).catch(() => null);
if (health !== 200) {
  console.log(`Dev server not reachable at ${BASE_URL} (health check returned ${health}) - skipping.`);
  process.exit(0);
}

// ---- 1. Server contract: login's own 401 must still carry a real message ----
{
  const res = await fetch(`${BASE_URL}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: SEED_EMAIL, password: "definitely-wrong-password-xyz" }),
  });
  const body = await res.json();
  check("server: wrong password on /auth/login returns 401", res.status === 401, `status=${res.status}`);
  check("server: wrong password response carries a real error message", body.error === "Invalid credentials", `body=${JSON.stringify(body)}`);
}

// ---- 2. Client regression guard: the real api.js must relay that message,
//         not overwrite it with "Session expired" ----
{
  const { Api, location } = loadRealApiJs({ initialPathname: "/admin/login.html" });
  let caught = null;
  try {
    await Api.post("/auth/login", { email: SEED_EMAIL, password: "definitely-wrong-password-xyz" });
  } catch (e) {
    caught = e;
  }
  check("client: wrong password rejects", !!caught);
  check(
    "client: wrong password shows the real server message (regression guard for the 'Session expired' bug)",
    caught && caught.message === "Invalid credentials",
    `got: ${caught && caught.message}`
  );
  check("client: wrong password does not redirect away from login.html", location.href === null, `href=${location.href}`);
}

// ---- 3. A genuinely invalid token on a protected route must still be
//         treated as expired (this fix must not weaken real expiry handling) ----
{
  const { Api, localStorage, location } = loadRealApiJs({ initialPathname: "/admin/dashboard.html" });
  localStorage.setItem("ayur_admin_token", "not-a-real-jwt.garbage.value");
  let caught = null;
  try {
    await Api.get("/auth/me");
  } catch (e) {
    caught = e;
  }
  check("client: invalid token still throws 'Session expired'", caught && caught.message === "Session expired", `got: ${caught && caught.message}`);
  check("client: invalid token is cleared from storage", localStorage.getItem("ayur_admin_token") === null);
  check("client: invalid token redirects to login.html", location.href === "login.html", `href=${location.href}`);
}

// ---- 4. A correct login must still succeed end-to-end (fix must not break the happy path) ----
{
  const { Api } = loadRealApiJs({ initialPathname: "/admin/login.html" });
  let data = null, err = null;
  try {
    data = await Api.post("/auth/login", { email: SEED_EMAIL, password: SEED_PASSWORD });
  } catch (e) {
    err = e;
  }
  check("client: correct credentials still log in successfully", !!data && !!data.token, err ? `error: ${err.message}` : "");

  if (data && data.token) {
    const meRes = await fetch(`${BASE_URL}/api/admin/auth/me`, { headers: { Authorization: `Bearer ${data.token}` } });
    check("server: fresh token is accepted on a protected route", meRes.status === 200, `status=${meRes.status}`);
  }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
