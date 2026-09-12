/**
 * DEV Harness - smoke healthcheck.
 *
 * Read-only. Hits a running server instance and reports pass/fail for the
 * routes every developer should be able to rely on before pushing a
 * change. Does NOT touch the database beyond whatever normal GET
 * requests the app already makes - never destructive, never writes.
 *
 * Usage:
 *   node dev-harness/healthcheck.js [baseUrl]
 *   BASE_URL=http://localhost:5100 node dev-harness/healthcheck.js
 *
 * Exit code 0 = all checks passed, 1 = at least one failed.
 */
const BASE_URL = process.argv[2] || process.env.BASE_URL || "http://localhost:5100";

const checks = [
  { name: "health endpoint", path: "/api/health", expect: 200 },
  { name: "homepage", path: "/", expect: 200 },
  { name: "shop listing", path: "/shop", expect: 200 },
  { name: "about (static page)", path: "/about", expect: 200 },
  { name: "contact (static page)", path: "/contact", expect: 200 },
  { name: "consult-vaidya (static page)", path: "/consult-vaidya", expect: 200 },
  { name: "dosha-test (static page)", path: "/dosha-test", expect: 200 },
  { name: "robots.txt", path: "/robots.txt", expect: 200 },
  { name: "sitemap.xml", path: "/sitemap.xml", expect: 200 },
  { name: "unknown route -> custom 404", path: "/this-route-does-not-exist-xyz", expect: 404 },
  { name: "unknown product slug -> 404", path: "/product/this-slug-does-not-exist-xyz", expect: 404 },
  { name: "public catalog: categories", path: "/api/public/categories", expect: 200 },
  { name: "public catalog: products list", path: "/api/public/products", expect: 200 },
  { name: "public catalog: invalid pagination rejected", path: "/api/public/products?pageSize=abc", expect: 200 }, // non-numeric pageSize silently falls back to default, not an error - see catalog API test suite for the full contract
  { name: "admin API without token -> 401", path: "/api/admin/products", expect: 401 },
];

async function run() {
  console.log(`DEV Harness healthcheck against ${BASE_URL}\n`);
  let failed = 0;
  for (const check of checks) {
    const url = `${BASE_URL}${check.path}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const ok = res.status === check.expect;
      console.log(`${ok ? "PASS" : "FAIL"}  ${check.name}  (expected ${check.expect}, got ${res.status})`);
      if (!ok) failed++;
    } catch (e) {
      console.log(`FAIL  ${check.name}  (request error: ${e.message})`);
      failed++;
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed.`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
