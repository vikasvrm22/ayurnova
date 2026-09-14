import fs from "fs";
import path from "path";
import os from "os";
import { checkCache } from "../../src/cache-engine/checkCache.js";
import { resetFindingCounter } from "../../src/evidence/Finding.js";
import { assert } from "../helpers.js";

const PAGES_JS = `
function cached(key, renderFn) { return renderFn(); }
export function invalidateCatalogCache() {
  for (const key of pageCache.keys()) {
    if (key === "home" || key.startsWith("shop:")) pageCache.delete(key);
  }
}
router.get("/", async (req, res) => { const html = await cached("home", async () => "x"); });
router.get("/faq", async (req, res) => { const html = await cached("faq", async () => "x"); });
router.get("/legal/:slug", async (req, res) => { const html = await cached(\`legal:\${slug}:\${page.updated_at}\`, async () => "x"); });
`;

export default async function () {
  resetFindingCounter();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wg-cache-test-"));
  fs.mkdirSync(path.join(tmpRoot, "server", "src", "routes"), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, "server", "src", "routes", "pages.js"), PAGES_JS, "utf8");
  fs.mkdirSync(path.join(tmpRoot, "server", "src", "routes"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, "server", "src", "routes", "products.js"),
    `import { invalidateCatalogCache } from "./pages.js";\nrouter.use((req,res,next)=>{ next(); invalidateCatalogCache(); });`,
    "utf8"
  );

  const { findings } = checkCache(tmpRoot);

  assert(findings.some((f) => f.observed.includes('cached("faq"')), "the statically-keyed 'faq' cache entry (uncovered by invalidateCatalogCache) is flagged");
  assert(!findings.some((f) => f.observed.includes('cached("home"')), "the 'home' key IS covered by invalidateCatalogCache, so it raises nothing");
  assert(!findings.some((f) => f.observed.includes("legal:")), "a content-derived key (embeds updated_at) is never flagged - it self-invalidates by construction");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  return { findingsCount: findings.length };
}
