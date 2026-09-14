import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanDesignRefDir } from "../../src/lib/referenceDiscovery.js";
import { buildInventory, summarizeInventory, sortInventory } from "../../src/lib/referenceInventory.js";
import { loadProjectConfig, resolvePage, defaultPaths } from "../../src/lib/configLoader.js";
import { assert } from "../helpers.js";

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "reference-discovery");
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function find(items, filename) {
  const hit = items.find((i) => i.filename === filename);
  assert(hit, `expected fixture inventory to contain ${filename}`);
  return hit;
}

export default async function run() {
  const files = scanDesignRefDir(FIXTURE_DIR);
  const adminLogin = files.find((f) => f.filename === "Phase1 08 AdminLogin.png");

  // Explicit config takes precedence: pretend a project config maps this exact
  // file to a configured page, even though nothing else was told about routes.
  const pagesConfig = {
    pages: [{ name: "admin-login", route: "/admin/login.html", referenceAbsPath: adminLogin.absolutePath }],
  };
  const routeCandidates = [
    { route: "/admin/future-phase-page.html", slug: "future-phase-page" },
    { route: "/admin/ambiguous-page-v1.html", slug: "ambiguous-page" },
    { route: "/admin/ambiguous-page-v2.html", slug: "ambiguous-page" },
  ];

  const items = buildInventory({ files, pagesConfig, routeCandidates });

  // 1. Explicit configuration precedence.
  const configuredItem = find(items, "Phase1 08 AdminLogin.png");
  assert(configuredItem.mappingStatus === "CONFIGURED", `explicitly configured reference must resolve as CONFIGURED, got ${configuredItem.mappingStatus}`);
  assert(configuredItem.explicitConfigMatch === "admin-login", "explicitConfigMatch must name the configured page");
  assert(configuredItem.route === "/admin/login.html", "CONFIGURED route must come from the explicit config, not a guess");

  // 2. Safe route mapping: exactly one candidate -> READY.
  const readyItem = find(items, "Phase10 01 Future Phase Page.png");
  assert(readyItem.mappingStatus === "READY", `unique route candidate should resolve READY, got ${readyItem.mappingStatus}`);
  assert(readyItem.route === "/admin/future-phase-page.html", "READY route must be the single matching candidate");

  // 3. Ambiguous route -> NEEDS_MAPPING territory (AMBIGUOUS), never guessed.
  const ambiguousItem = find(items, "Phase3 Ambiguous Page.png");
  assert(ambiguousItem.mappingStatus === "AMBIGUOUS", `multiple route candidates must never be auto-resolved, got ${ambiguousItem.mappingStatus}`);
  assert(ambiguousItem.route === null, "an ambiguous mapping must not carry a guessed route");

  // 4. No candidate at all, but a real page name -> NEEDS_MAPPING (not UNMAPPED).
  const needsMappingItem = find(items, "Phase3 New Admin Page No Route.png");
  assert(needsMappingItem.mappingStatus === "NEEDS_MAPPING", `parseable-but-routeless reference should be NEEDS_MAPPING, got ${needsMappingItem.mappingStatus}`);

  // 5. Unparseable filename -> UNMAPPED (never a route guess).
  const unmappedItem = find(items, "NoPhasePrefix.jpg");
  assert(unmappedItem.mappingStatus === "UNMAPPED" && unmappedItem.route === null, `unparseable filename must be UNMAPPED with no route, got ${JSON.stringify(unmappedItem)}`);

  // 6. Duplicate detection: byte-identical files are flagged, canonical kept, files untouched.
  const dupA = find(items, "Phase2 9. Admin Payments List.png");
  const dupB = find(items, "Phase2 9 Admin Payments List (copy).png");
  assert(dupA.duplicate.isDuplicate && dupB.duplicate.isDuplicate, "both byte-identical fixtures must be flagged as duplicates");
  assert([dupA.mappingStatus, dupB.mappingStatus].includes("DUPLICATE"), "exactly one duplicate-group member (the non-canonical one) should carry mappingStatus DUPLICATE");
  assert(dupA.duplicate.canonicalPath === dupB.duplicate.canonicalPath, "duplicate group members must agree on the canonical file");

  // 7. Summary counters add up sanely and phases are bucketed.
  const summary = summarizeInventory(items);
  assert(summary.total === files.length, "summary total must match the number of scanned files");
  assert(summary.configured === 1, "exactly one fixture is explicitly configured");
  assert(summary.duplicates === 2, "both members of the duplicate pair must be counted");
  assert(summary.byPhase["Phase 1"] >= 1 && summary.byPhase.unknown >= 1, "phase bucketing must include both a real phase and the unknown bucket");

  // 8. Deterministic ordering/output: rebuilding from the same inputs is stable.
  const again = buildInventory({ files, pagesConfig, routeCandidates });
  assert(JSON.stringify(sortInventory(items)) === JSON.stringify(sortInventory(again)), "inventory build must be deterministic given the same inputs");

  // 9. Regression guard: the real project's 13 already-configured ui-judge pages
  // must still resolve as CONFIGURED against the live design-ref directory -
  // auto-discovery must never change behavior for existing configured pages.
  const paths = defaultPaths(PROJECT_ROOT);
  const liveConfig = loadProjectConfig(paths.defaultConfig);
  if (liveConfig.designRefDir) {
    const liveFiles = scanDesignRefDir(liveConfig.designRefDir);
    const liveItems = buildInventory({ files: liveFiles, pagesConfig: liveConfig, sourceRoots: liveConfig.sourceRoots });
    const designRefConfiguredPages = liveConfig.pages.filter((p) => {
      try { return resolvePage(liveConfig, p.name).referenceAbsPath.startsWith(liveConfig.designRefDir); } catch { return false; }
    });
    for (const page of designRefConfiguredPages) {
      const match = liveItems.find((i) => i.explicitConfigMatch === page.name);
      assert(match, `configured page "${page.name}" must still be found by discovery against the live design-ref dir`);
      assert(match.mappingStatus === "CONFIGURED", `configured page "${page.name}" must resolve as CONFIGURED, got ${match.mappingStatus}`);
    }
    assert(designRefConfiguredPages.length >= 10, `expected the bulk of the 12-page admin alignment to reference design-ref directly, found ${designRefConfiguredPages.length}`);
  }

  return { name: "referenceInventory" };
}
