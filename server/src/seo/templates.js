import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(__dirname, "../../../public-site");

const cache = new Map();

export function getTemplate(filename) {
  if (cache.has(filename)) return cache.get(filename);
  const full = path.join(SITE_DIR, filename);
  const content = fs.readFileSync(full, "utf-8");
  cache.set(filename, content);
  return content;
}

export function clearTemplateCache() {
  cache.clear();
}
