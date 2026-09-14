import fs from "fs";
import path from "path";

const DEFAULT_IGNORE = new Set(["node_modules", ".git", ".auth", "generated", "reports", "baselines", "screenshots"]);

/** Recursively lists files under `root` whose extension is in `extensions` (e.g. [".js", ".html"]).
 * Skips node_modules and other noise directories. Returns absolute paths. */
export function walkFiles(root, extensions, { ignore = DEFAULT_IGNORE } = {}) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

export function readText(file) {
  return fs.readFileSync(file, "utf8");
}
