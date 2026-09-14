import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseReferenceFilename, classifyReference, scanDesignRefDir, slugify } from "../../src/lib/referenceDiscovery.js";
import { assert } from "../helpers.js";

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "reference-discovery");

export default async function run() {
  // 1. Basic phase/sequence/pageName parsing.
  let p = parseReferenceFilename("Phase1 08 AdminLogin.png");
  assert(p.phase === 1 && p.sequence === 8 && p.pageName === "AdminLogin", `basic parse failed: ${JSON.stringify(p)}`);

  // 2. Trailing space before extension.
  p = parseReferenceFilename("Phase1 09 Admin Dashboard .png");
  assert(p.phase === 1 && p.sequence === 9 && p.pageName === "Admin Dashboard", `trailing-space parse failed: ${JSON.stringify(p)}`);

  // 3. Punctuation (period after sequence) + double-space multi-word page name.
  p = parseReferenceFilename("Phase1 10. Admin Products  Categories Management .png");
  assert(p.phase === 1 && p.sequence === 10 && p.pageName === "Admin Products Categories Management", `punctuation parse failed: ${JSON.stringify(p)}`);

  // 4. Multi-word page name with a leading period, no double digits.
  p = parseReferenceFilename("Phase2 7. Admin Integration Management.png");
  assert(p.phase === 2 && p.sequence === 7 && p.pageName === "Admin Integration Management", `period-sequence parse failed: ${JSON.stringify(p)}`);

  // 5. Sequence number entirely absent - must not throw, must not fabricate one.
  p = parseReferenceFilename("Phase3 New Admin Page No Route.png");
  assert(p.phase === 3 && p.sequence === null && p.pageName === "New Admin Page No Route", `missing-sequence parse failed: ${JSON.stringify(p)}`);

  // 6. Future/multi-digit phase number (Phase10, not just "Phase1" + stray "0").
  p = parseReferenceFilename("Phase10 01 Future Phase Page.png");
  assert(p.phase === 10 && p.sequence === 1 && p.pageName === "Future Phase Page", `Phase10 parse failed: ${JSON.stringify(p)}`);

  // 7. Extension case-insensitivity.
  p = parseReferenceFilename("PHASE5 01 Something.PNG");
  assert(p.extension === ".png" && p.phase === 5, `extension case handling failed: ${JSON.stringify(p)}`);

  // 8. No phase prefix at all -> everything null, never a guess.
  p = parseReferenceFilename("NoPhasePrefix.jpg");
  assert(p.phase === null && p.sequence === null && p.pageName === null, `no-prefix parse should be all-null: ${JSON.stringify(p)}`);

  // 9. classifyReference: state / panel / mobile / asset / unknown / page.
  assert(classifyReference(parseReferenceFilename("Phase2 15 Integration Connection Test  Error States.png"), "x.png") === "STATE_REFERENCE", "connection-test filename should classify as STATE_REFERENCE");
  assert(classifyReference(parseReferenceFilename("Phase2 10. Payment Detail  Attempts.png"), "x.png") === "PANEL_REFERENCE", "detail/attempts filename should classify as PANEL_REFERENCE");
  assert(classifyReference(parseReferenceFilename("Phase4 02 Nested Mobile View.png"), "x.png") === "MOBILE_REFERENCE", "mobile filename should classify as MOBILE_REFERENCE");
  assert(classifyReference(parseReferenceFilename("Phase1 09 Admin Dashboard .png"), "x.png") === "PAGE_REFERENCE", "plain page filename should classify as PAGE_REFERENCE");
  assert(classifyReference(parseReferenceFilename("ChatGPT Image Sep 13, 2026, 02_41_28 PM.png"), "ChatGPT Image Sep 13, 2026, 02_41_28 PM.png") === "ASSET_REFERENCE", "ChatGPT-generated art should classify as ASSET_REFERENCE");
  assert(classifyReference(parseReferenceFilename("NoPhasePrefix.jpg"), "NoPhasePrefix.jpg") === "UNKNOWN", "unparseable filename should classify as UNKNOWN, never guessed");

  // 10. slugify is deterministic and safe for route matching.
  assert(slugify("Admin Payments List") === "admin-payments-list", "slugify should kebab-case and lowercase");
  assert(slugify("  Weird!!  Spacing__Here  ") === "weird-spacing-here", "slugify should collapse punctuation/whitespace runs");

  // 11. Recursive scan + case-insensitive extension + unsupported-extension exclusion.
  const scanned = scanDesignRefDir(FIXTURE_DIR);
  const names = scanned.map((f) => f.relativePath);
  assert(names.includes("sub/Phase4 02 Nested Mobile View.png"), "scan must recurse into subdirectories");
  assert(names.includes("IMAGE.WEBP"), "scan must accept uppercase extensions");
  assert(!names.some((n) => n.endsWith(".txt")), "scan must ignore unsupported extensions");
  assert(scanned.every((f) => typeof f.hash === "string" && f.hash.length === 64), "every scanned file must have a sha256 hex hash");

  // 12. Duplicate-hash detection: the two byte-identical "Admin Payments List" fixtures.
  const paymentsListFiles = scanned.filter((f) => f.filename.startsWith("Phase2 9"));
  assert(paymentsListFiles.length === 2, "expected two Payments List fixture variants");
  assert(paymentsListFiles[0].hash === paymentsListFiles[1].hash, "byte-identical fixtures must hash identically");

  // 13. Scan ordering is deterministic (sorted by relative path) so duplicate-group
  // "canonical" selection doesn't flap between runs.
  const scannedAgain = scanDesignRefDir(FIXTURE_DIR);
  assert(JSON.stringify(scanned.map((f) => f.relativePath)) === JSON.stringify(scannedAgain.map((f) => f.relativePath)), "scan order must be deterministic across runs");

  return { name: "referenceDiscovery" };
}
