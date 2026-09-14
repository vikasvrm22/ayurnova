import path from "path";
import fs from "fs";
import { readText } from "../discovery/fsWalk.js";
import { makeFinding } from "../evidence/Finding.js";

const CACHED_CALL_RE = /\bcached\(\s*(`[^`]*`|"[^"]*")\s*,/g;
const INVALIDATOR_FN_RE = /export\s+function\s+(\w*[Ii]nvalidate\w*)\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/;
const COVERED_KEY_RE = /key\s*===\s*"([^"]+)"|key\.startsWith\(\s*"([^"]+)"\s*\)/g;

/** Layer/section 17 (cache wiring) checker. Discovers every cached(key, ...)
 * call site in the SSR page router, classifies each key as content-derived
 * (safe - e.g. a template literal embedding updated_at, so a new value
 * naturally busts the cache) or static (needs an explicit invalidation
 * path), then checks whether the discovered invalidator function's own body
 * actually covers every static key. A static key with no covering
 * clear-on-write path is a real staleness risk - admin edits to that
 * content can sit invisible on the storefront for up to the cache TTL. */
export function checkCache(repoRoot) {
  const findings = [];
  const pagesPath = "server/src/routes/pages.js";
  const src = safeRead(path.join(repoRoot, pagesPath));
  if (!src) return { findings };

  const cacheSites = [];
  for (const m of src.matchAll(CACHED_CALL_RE)) {
    const keyExpr = m[1];
    const lineNo = src.slice(0, m.index).split("\n").length;
    const isDynamic = keyExpr.startsWith("`") && /\$\{/.test(keyExpr);
    cacheSites.push({ keyExpr, line: lineNo, isDynamic });
  }
  if (cacheSites.length === 0) return { findings };

  const invalidatorMatch = src.match(INVALIDATOR_FN_RE);
  if (!invalidatorMatch) {
    findings.push(
      makeFinding({
        layer: "L-cache",
        category: "cache",
        file: pagesPath,
        route: null,
        observed: `${cacheSites.length} cached() call site(s) found (e.g. line ${cacheSites[0].line}) but no exported *invalidate* function was found anywhere in the same file.`,
        expected: "An SSR page cache needs a discoverable, callable invalidation path for content that can be edited by an admin.",
        evidence: `Regex scan of ${pagesPath} found cached() calls but no function matching /export function \\w*Invalidate\\w*/.`,
        severity: "P2",
        confidence: "medium",
        recommendedFix: "Confirm whether this cache is expected to self-expire only (TTL-only, acceptable staleness) or needs an explicit invalidator.",
      })
    );
    return { findings };
  }

  const [, invalidatorName, invalidatorBody] = invalidatorMatch;
  const coveredStatic = new Set();
  for (const m of invalidatorBody.matchAll(COVERED_KEY_RE)) coveredStatic.add(m[1] || m[2]);

  const callerFiles = findCallers(repoRoot, invalidatorName);
  if (callerFiles.length === 0) {
    findings.push(
      makeFinding({
        layer: "L-cache",
        category: "cache",
        file: pagesPath,
        route: null,
        observed: `${invalidatorName}() is exported but no route file under server/src/routes was found calling it.`,
        expected: "A cache-invalidation function that no admin mutation route ever calls cannot actually be doing its job.",
        evidence: `Grep of server/src/routes/*.js for '${invalidatorName}(' found zero call sites (definition site excluded).`,
        severity: "P1",
        confidence: "medium",
        recommendedFix: `Confirm ${invalidatorName}() is genuinely unused, or wire it into the admin mutation route(s) for the content it targets.`,
      })
    );
  }

  for (const site of cacheSites) {
    if (site.isDynamic) continue; // e.g. `legal:${slug}:${page.updated_at}` - self-invalidating by construction
    const keyLiteral = site.keyExpr.slice(1, -1);
    const isCovered = [...coveredStatic].some((c) => keyLiteral === c || keyLiteral.startsWith(c));
    if (isCovered) continue;
    findings.push(
      makeFinding({
        layer: "L-cache",
        category: "cache",
        file: pagesPath,
        line: site.line,
        route: null,
        observed: `cached(${site.keyExpr}, ...) at ${pagesPath}:${site.line} uses a static (non-content-derived) cache key that ${invalidatorName}() does not cover (${invalidatorName}() only clears: ${[...coveredStatic].join(", ") || "(nothing)"}).`,
        expected: "Every statically-keyed SSR cache entry for admin-editable content should be cleared on write (like 'home'/'shop:*'/'sitemap' already are), or use a content-derived key (like the legal-page cache already does via page.updated_at).",
        evidence: `${pagesPath}: cached() call at line ${site.line}; ${invalidatorName}() body only matches key literal(s)/prefix(es) [${[...coveredStatic].join(", ")}].`,
        severity: "P2",
        confidence: "high",
        recommendedFix: `Either add this key to ${invalidatorName}()'s clear-list and call ${invalidatorName}() from the admin route that edits this content (same pattern as products.js/categories.js), or switch to a content-derived cache key (same pattern as the legal-page cache).`,
      })
    );
  }

  return { findings };
}

function findCallers(repoRoot, fnName) {
  const routesDir = path.join(repoRoot, "server/src/routes");
  let files = [];
  try {
    files = fs.readdirSync(routesDir).filter((f) => f.endsWith(".js"));
  } catch {
    return [];
  }
  const callers = [];
  for (const f of files) {
    if (f === "pages.js") continue; // the definition site, not a caller
    const text = safeRead(path.join(routesDir, f));
    if (text && new RegExp(`\\b${fnName}\\(\\)`).test(text)) callers.push(`server/src/routes/${f}`);
  }
  return callers;
}

function safeRead(p) {
  try {
    return readText(p);
  } catch {
    return null;
  }
}
