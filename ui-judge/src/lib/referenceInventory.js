// ============================================================
// 13b. REFERENCE INVENTORY
// ============================================================
// Combines auto-discovered design-ref files with the explicit
// pages.config.json registry into one deterministic inventory. Explicit
// configuration always wins (see docs/UI-JUDGE.md "Reference discovery");
// this module never overrides a configured page and never invents a route.
import fs from "node:fs";
import path from "node:path";
import { scanDesignRefDir, parseReferenceFilename, classifyReference, slugify } from "./referenceDiscovery.js";

const HTML_EXTENSIONS = new Set([".html", ".htm"]);

function normalizeForCompare(absPath) {
  return path.resolve(absPath).split(path.sep).join("/").toLowerCase();
}

/**
 * Walks each configured source root for .html files and turns each into a
 * route candidate ({ route, slug }). Used only as a fallback when a
 * discovered reference has no explicit config match - never to override
 * one. Deterministic and read-only (no writes under sourceRoots).
 */
export function discoverRouteCandidates(sourceRoots = []) {
  const candidates = [];
  for (const root of sourceRoots) {
    if (!fs.existsSync(root)) continue;
    const rootName = path.basename(root);
    (function walk(current) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) { walk(abs); continue; }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!HTML_EXTENSIONS.has(ext)) continue;
        const relFromRoot = path.relative(root, abs).split(path.sep).join("/");
        candidates.push({
          route: `/${rootName}/${relFromRoot}`,
          slug: slugify(path.basename(entry.name, ext)),
        });
      }
    })(root);
  }
  return candidates;
}

/**
 * Builds the full reference inventory. Pass `files` / `routeCandidates`
 * directly (as the test suite does) to bypass filesystem scanning, or pass
 * `designRefDir` / `sourceRoots` to scan the real project.
 */
export function buildInventory({ designRefDir, files, pagesConfig, sourceRoots, routeCandidates }) {
  const scanned = files || (designRefDir ? scanDesignRefDir(designRefDir) : []);
  const candidates = routeCandidates || discoverRouteCandidates(sourceRoots || []);

  const configuredByPath = new Map();
  for (const page of pagesConfig?.pages || []) {
    if (page.referenceAbsPath) configuredByPath.set(normalizeForCompare(page.referenceAbsPath), page);
  }

  const byHash = new Map();
  for (const f of scanned) {
    if (!byHash.has(f.hash)) byHash.set(f.hash, []);
    byHash.get(f.hash).push(f);
  }

  return scanned.map((f) => {
    const parsed = parseReferenceFilename(f.filename);
    const type = classifyReference(parsed, f.filename);

    const group = byHash.get(f.hash);
    const isDuplicate = group.length > 1;
    const canonical = group[0];

    const configuredPage = configuredByPath.get(normalizeForCompare(f.absolutePath)) || null;

    let mappingStatus = "UNMAPPED";
    let route = null;

    if (configuredPage) {
      mappingStatus = "CONFIGURED";
      route = configuredPage.route;
    } else if (parsed.phase !== null && parsed.pageName) {
      const slug = slugify(parsed.pageName);
      const matches = candidates.filter((c) => c.slug === slug);
      if (matches.length === 1) { mappingStatus = "READY"; route = matches[0].route; }
      else if (matches.length > 1) { mappingStatus = "AMBIGUOUS"; }
      else { mappingStatus = "NEEDS_MAPPING"; }
    }
    // else: phase or pageName could not be parsed at all -> stays UNMAPPED.
    // We never guess a route from an unparseable filename.

    // A non-canonical duplicate is redundant regardless of what its own
    // filename suggests - unless it happens to be the one explicit config
    // actually points at, which always wins.
    if (isDuplicate && f !== canonical && mappingStatus !== "CONFIGURED") {
      mappingStatus = "DUPLICATE";
    }

    return {
      filename: f.filename,
      path: f.relativePath,
      absolutePath: f.absolutePath,
      phase: parsed.phase,
      sequence: parsed.sequence,
      pageName: parsed.pageName,
      normalizedPageName: parsed.normalizedPageName,
      extension: f.extension,
      hash: f.hash,
      type,
      explicitConfigMatch: configuredPage ? configuredPage.name : null,
      route,
      mappingStatus,
      duplicate: {
        isDuplicate,
        groupSize: group.length,
        canonicalPath: canonical.relativePath,
        members: isDuplicate ? group.map((g) => g.relativePath) : [f.relativePath],
      },
    };
  });
}

function phaseKey(phase) {
  return phase === null || phase === undefined ? "unknown" : `Phase ${phase}`;
}

export function summarizeInventory(items) {
  const summary = {
    total: items.length,
    configured: 0,
    autoDiscovered: 0,
    ready: 0,
    needsMapping: 0,
    ambiguous: 0,
    unmapped: 0,
    duplicates: 0,
    unknown: 0,
    byPhase: {},
  };

  for (const item of items) {
    if (item.mappingStatus === "CONFIGURED") summary.configured++;
    else summary.autoDiscovered++;

    if (item.mappingStatus === "READY") summary.ready++;
    else if (item.mappingStatus === "NEEDS_MAPPING") summary.needsMapping++;
    else if (item.mappingStatus === "AMBIGUOUS") summary.ambiguous++;
    else if (item.mappingStatus === "UNMAPPED") summary.unmapped++;

    if (item.duplicate.isDuplicate) summary.duplicates++;
    if (item.type === "UNKNOWN") summary.unknown++;

    const key = phaseKey(item.phase);
    summary.byPhase[key] = (summary.byPhase[key] || 0) + 1;
  }

  return summary;
}

/** Deterministic ordering for the on-disk inventory file (phase, sequence, filename). */
export function sortInventory(items) {
  return [...items].sort((a, b) => {
    const pa = a.phase === null ? Infinity : a.phase;
    const pb = b.phase === null ? Infinity : b.phase;
    if (pa !== pb) return pa - pb;
    const sa = a.sequence === null ? Infinity : a.sequence;
    const sb = b.sequence === null ? Infinity : b.sequence;
    if (sa !== sb) return sa - sb;
    return a.filename.localeCompare(b.filename);
  });
}

export function writeInventoryFile(items, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    summary: summarizeInventory(items),
    references: sortInventory(items),
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
  return payload;
}
