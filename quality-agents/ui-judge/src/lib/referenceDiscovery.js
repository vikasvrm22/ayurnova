// ============================================================
// 13. DESIGN REFERENCE AUTO-DISCOVERY
// ============================================================
// Scans a design-reference directory (e.g. public-site/design-ref/) and
// turns filenames into structured metadata, without ever touching the
// files themselves (no move/rename/delete/convert - see docs/UI-JUDGE.md).
// This module only reads bytes and filenames; it never decodes images, so
// it has no dependency on sharp and works even for non-image test fixtures.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

// "Phase<N> <sequence>? <page name>.<ext>" - sequence and punctuation between
// the parts are optional/inconsistent in real filenames (see docs). We only
// hard-require the "Phase<digits>" prefix; everything else degrades
// gracefully to null rather than throwing or guessing.
const PHASE_PREFIX_RE = /^phase\s*(\d+)/i;
const SEQUENCE_PREFIX_RE = /^(\d+)\s*\.?\s*/;

function collapseWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

function stripEdgePunctuation(s) {
  // Trims stray leading/trailing separators left over once the phase and
  // sequence tokens are removed ("- Admin Login" -> "Admin Login").
  return s.replace(/^[\s.\-–—:]+/, "").replace(/[\s.\-–—:]+$/, "");
}

export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Parses the filename-based metadata convention documented in UI-JUDGE.md.
 * Never throws - an unparseable filename simply yields null fields, which
 * callers must treat as "cannot safely auto-map", not as an error.
 */
export function parseReferenceFilename(filename) {
  const extension = path.extname(filename).toLowerCase();
  const base = path.basename(filename, path.extname(filename));
  const trimmedBase = base.trim();

  const phaseMatch = PHASE_PREFIX_RE.exec(trimmedBase);
  if (!phaseMatch) {
    return { phase: null, sequence: null, pageName: null, normalizedPageName: null, extension };
  }

  const phase = Number(phaseMatch[1]);
  let rest = trimmedBase.slice(phaseMatch[0].length);
  rest = stripEdgePunctuation(rest);

  let sequence = null;
  const seqMatch = SEQUENCE_PREFIX_RE.exec(rest);
  if (seqMatch) {
    sequence = Number(seqMatch[1]);
    rest = stripEdgePunctuation(rest.slice(seqMatch[0].length));
  }

  const pageName = collapseWhitespace(rest) || null;
  const normalizedPageName = pageName ? pageName.toLowerCase() : null;

  return { phase, sequence, pageName, normalizedPageName, extension };
}

/**
 * Best-effort classification of what kind of reference an image is. Returns
 * "UNKNOWN" whenever the filename doesn't give a safe signal - this
 * function must never guess a specific type it isn't reasonably sure of.
 */
export function classifyReference(parsed, filename) {
  const haystack = `${parsed.normalizedPageName || ""} ${filename}`.toLowerCase();

  if (parsed.phase === null) {
    // No phase prefix at all. A handful of generic AI-generated art
    // filenames ("ChatGPT Image ...", "Gemini_Generated_Image_...") show up
    // in this project's design-ref folder as raw art assets, not page
    // mockups - recognize that narrow, safe pattern; everything else with
    // no phase prefix is UNKNOWN rather than guessed.
    if (/^(chatgpt image|gemini_generated_image)/i.test(filename.trim())) return "ASSET_REFERENCE";
    return "UNKNOWN";
  }

  if (!parsed.pageName) return "UNKNOWN";

  if (/\bmobile\b/.test(haystack)) return "MOBILE_REFERENCE";
  if (/\b(error state|error states|connection test|verification|processing state)\b/.test(haystack)) return "STATE_REFERENCE";
  if (/\b(detail|partial|attempts)\b/.test(haystack)) return "PANEL_REFERENCE";

  return "PAGE_REFERENCE";
}

function sha256File(absolutePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
}

/**
 * Recursively scans a directory for supported image files. Read-only:
 * never moves, renames, deletes, or modifies anything under `dir`. Returns
 * a deterministically-ordered list (sorted by relative path) so downstream
 * duplicate-group "canonical" selection is stable across runs.
 */
export function scanDesignRefDir(dir) {
  if (!fs.existsSync(dir)) return [];

  const results = [];
  (function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
      results.push({
        absolutePath: abs,
        relativePath: path.relative(dir, abs).split(path.sep).join("/"),
        filename: entry.name,
        extension: ext,
        hash: sha256File(abs),
      });
    }
  })(dir);

  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}
