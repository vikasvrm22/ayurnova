import path from "path";
import { walkFiles, readText } from "./fsWalk.js";

const ADMIN_WRAPPER_RE = /\bApi\.(get|post|put|del|postForm)\(\s*(["'`])((?:(?!\2).)*)\2/g;
const PUBLIC_WRAPPER_RE = /\bapi(Get|Post|Put|Delete)\(\s*(["'`])((?:(?!\2).)*)\2/g;
const RAW_FETCH_RE = /\bfetch\(\s*(["'`])((?:(?!\1).)*)\1\s*(,([\s\S]{0,200}?)\))?/g;

const ADMIN_METHOD_MAP = { get: "GET", post: "POST", put: "PUT", del: "DELETE", postForm: "POST" };
const PUBLIC_METHOD_MAP = { Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE" };

function normalizePath(rawPath) {
  const collapsed = rawPath
    .replace(/\$\{[^}]+\}/g, ":param")
    .replace(/\?.*$/, "")
    .replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

function relOf(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Scans admin/ and public-site/ (HTML + JS, excluding the wrapper files
 * themselves and design-ref assets) for frontend->backend API calls. */
export function discoverFrontend(repoRoot) {
  const adminRoot = path.join(repoRoot, "admin");
  const siteRoot = path.join(repoRoot, "public-site");

  const adminFiles = [...walkFiles(adminRoot, [".html"]), ...walkFiles(path.join(adminRoot, "js"), [".js"])];
  const siteFiles = [
    ...walkFiles(siteRoot, [".html"], { ignore: new Set(["node_modules", ".git", "design-ref"]) }),
    ...walkFiles(path.join(siteRoot, "js"), [".js"]),
  ];

  const calls = [];

  for (const file of adminFiles) {
    const relPath = `admin/${relOf(adminRoot, file)}`;
    if (relPath.endsWith("admin/js/api.js")) continue; // wrapper definition itself, not a call site
    const src = readText(file);
    for (const m of src.matchAll(ADMIN_WRAPPER_RE)) {
      const lineNo = src.slice(0, m.index).split("\n").length;
      calls.push({
        file: relPath,
        line: lineNo,
        method: ADMIN_METHOD_MAP[m[1]],
        rawPath: m[3],
        fullPath: normalizePath(`/api/admin${m[3]}`),
        client: "admin/js/api.js (Api wrapper)",
      });
    }
    collectRawFetch(src, relPath, calls);
  }

  for (const file of siteFiles) {
    const relPath = `public-site/${relOf(siteRoot, file)}`;
    if (relPath.endsWith("public-site/js/site.js")) {
      // site.js defines the wrapper AND makes two real calls inside itself - scan it too,
      // the wrapper-definition regex only matches literal-string call sites, not `path` params.
    }
    const src = readText(file);
    for (const m of src.matchAll(PUBLIC_WRAPPER_RE)) {
      const lineNo = src.slice(0, m.index).split("\n").length;
      calls.push({
        file: relPath,
        line: lineNo,
        method: PUBLIC_METHOD_MAP[m[1]],
        rawPath: m[3],
        fullPath: normalizePath(m[3]),
        client: "public-site/js/site.js (api* wrapper)",
      });
    }
    collectRawFetch(src, relPath, calls);
  }

  return { calls };
}

function collectRawFetch(src, relPath, calls) {
  for (const m of src.matchAll(RAW_FETCH_RE)) {
    const rawPath = m[2];
    if (!rawPath.startsWith("/api/")) continue;
    const optionsText = m[4] || "";
    const methodMatch = optionsText.match(/method\s*:\s*["'`](GET|POST|PUT|DELETE|PATCH)["'`]/);
    const method = methodMatch ? methodMatch[1] : "GET";
    const lineNo = src.slice(0, m.index).split("\n").length;
    calls.push({ file: relPath, line: lineNo, method, rawPath, fullPath: normalizePath(rawPath), client: "raw fetch()" });
  }
}

export { normalizePath };
