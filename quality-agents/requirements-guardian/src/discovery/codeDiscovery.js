import fs from "fs";
import path from "path";

// Read-only evidence gathering against the CURRENT repository on disk. This
// is the ONLY place compliance checkers touch the filesystem - every
// checker calls into these helpers rather than reading files itself, so the
// "never modifies application code" boundary (spec section 32/34) is
// enforced structurally: nothing in this module ever opens a file for
// writing outside quality-agents/requirements-guardian/.

export function readFileSafe(repoRoot, relPath) {
  const abs = path.join(repoRoot, relPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, "utf8");
}

export function fileExists(repoRoot, relPath) {
  return fs.existsSync(path.join(repoRoot, relPath));
}

/** Finds every line matching `pattern` (a RegExp) in one file. Returns
 * [{ line, text }] with 1-indexed line numbers, or null if the file is
 * missing (a missing file is itself evidence - callers decide what it
 * means, this helper never assumes). */
export function findLinesInFile(repoRoot, relPath, pattern) {
  const content = readFileSafe(repoRoot, relPath);
  if (content === null) return null;
  const lines = content.split(/\r?\n/);
  const hits = [];
  lines.forEach((text, idx) => {
    if (pattern.test(text)) hits.push({ line: idx + 1, text: text.trim() });
    pattern.lastIndex = 0; // guard against /g regex statefulness
  });
  return hits;
}

/** Same as findLinesInFile but across every file in a directory (recursive)
 * matching an optional file-name filter. Returns a flat array of
 * { file, line, text } relative to repoRoot. */
export function findLinesInDir(repoRoot, relDir, pattern, { fileFilter = () => true, extensions = null } = {}) {
  const absDir = path.join(repoRoot, relDir);
  if (!fs.existsSync(absDir)) return [];
  const results = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (fileFilter(entry.name) && (!extensions || extensions.some((e) => entry.name.endsWith(e)))) {
        const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
        const hits = findLinesInFile(repoRoot, rel, pattern);
        if (hits) for (const h of hits) results.push({ file: rel, ...h });
      }
    }
  }
  walk(absDir);
  return results;
}

/** Lists every *.sql file under supabase/migrations in lexicographic
 * (== applied) order, since migration numbering is this repo's real
 * ordering convention (0001_..., 0002_..., ...). */
export function listMigrations(repoRoot) {
  const dir = path.join(repoRoot, "supabase", "migrations");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => `supabase/migrations/${f}`);
}

/** Extracts the allowed values of the LAST `check (<column> in (...))`
 * constraint found for a given column name across schema.sql + every
 * migration in order - i.e. the live, current constraint after all ALTERs,
 * not just the original CREATE TABLE. Returns null if never found. */
export function currentCheckConstraintValues(repoRoot, columnName) {
  const files = ["supabase/schema.sql", ...listMigrations(repoRoot)];
  const pattern = new RegExp(`\\b${columnName}\\b[\\s\\S]{0,40}?check\\s*\\([^)]*\\bin\\s*\\(([^)]+)\\)`, "gi");
  let last = null;
  for (const rel of files) {
    const content = readFileSafe(repoRoot, rel);
    if (!content) continue;
    let match;
    const re = new RegExp(pattern.source, "gi");
    while ((match = re.exec(content))) {
      const values = match[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
      last = { file: rel, values };
    }
  }
  return last;
}
