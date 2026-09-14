import path from "path";
import { readText } from "./fsWalk.js";
import { parseRouteFile } from "./routeDiscovery.js";

const IMPORT_RE = /import\s+(\w+)(?:,\s*{[^}]*})?\s+from\s+["'`]\.\/routes\/([\w./-]+)\.js["'`]/g;
const MOUNT_RE = /app\.use\(\s*["'`]([^"'`]+)["'`]\s*,\s*(\w+)\s*\)/g;
const PHASE_COMMENT_RE = /\/\/\s*-{2,}\s*(Phase[^-]+?)\s*-{2,}/gi;

/**
 * Parses server/src/index.js to recover:
 *  - which route-file each imported router variable comes from
 *  - which URL prefix each router variable is mounted at (app.use)
 *  - the phase label a route file was introduced under (from the repo's own
 *    "---- Phase N: ... ----" comments directly above each import block)
 * This is real evidence pulled from the app's own entrypoint, not invented.
 */
export function discoverServer(serverRoot) {
  const indexPath = path.join(serverRoot, "src/index.js");
  const indexSrc = readText(indexPath);

  const varToFile = new Map();
  const varToPhase = new Map();
  let currentPhase = "Phase 1-2 (foundation, no phase comment above import)";
  const lines = indexSrc.split("\n");
  for (const line of lines) {
    const phaseMatch = line.match(/\/\/\s*-{2,}\s*(Phase[^-]+?)\s*-{2,}/i);
    if (phaseMatch) {
      currentPhase = phaseMatch[1].trim();
      continue;
    }
    const importMatch = line.match(/import\s+(\w+)(?:,\s*{[^}]*})?\s+from\s+["'`]\.\/routes\/([\w./-]+)\.js["'`]/);
    if (importMatch) {
      varToFile.set(importMatch[1], importMatch[2]);
      varToPhase.set(importMatch[1], currentPhase);
    }
  }

  const mounts = [];
  for (const m of indexSrc.matchAll(MOUNT_RE)) {
    const [, prefix, varName] = m;
    if (varToFile.has(varName)) {
      mounts.push({ prefix, varName, routeFile: varToFile.get(varName), phase: varToPhase.get(varName) });
    }
  }

  const globalMiddleware = {
    helmet: /app\.use\(\s*helmet\(/.test(indexSrc),
    cors: /app\.use\(\s*cors\(/.test(indexSrc),
    compression: /app\.use\(\s*compression\(\)/.test(indexSrc),
    rateLimiters: [...indexSrc.matchAll(/app\.use\(\s*["'`]([^"'`]+)["'`]\s*,\s*(\w*[Ll]imiter)\s*\)/g)].map((x) => ({
      path: x[1],
      limiter: x[2],
    })),
    errorHandlerLast: /app\.use\(\s*errorHandler\s*\)\s*;\s*$/.test(indexSrc.trimEnd()) || /errorHandler/.test(indexSrc),
  };

  const routes = [];
  for (const mount of mounts) {
    const filePath = path.join(serverRoot, "src/routes", `${mount.routeFile}.js`);
    let src;
    try {
      src = readText(filePath);
    } catch {
      continue;
    }
    const relPath = `server/src/routes/${mount.routeFile}.js`;
    const fileRoutes = parseRouteFile(src, relPath);
    for (const r of fileRoutes) {
      const fullPath = joinPath(mount.prefix, r.routePath);
      routes.push({
        ...r,
        prefix: mount.prefix,
        fullPath,
        phase: mount.phase,
        actorType: classifyActor(mount.prefix, r),
      });
    }
  }

  return { indexPath, mounts, globalMiddleware, routes };
}

function joinPath(prefix, routePath) {
  if (routePath === "/") return prefix;
  return `${prefix}${routePath}`.replace(/\/{2,}/g, "/");
}

function classifyActor(prefix, route) {
  if (prefix.startsWith("/api/admin")) return "admin";
  if (prefix.includes("webhook")) return "external-webhook";
  const hardCustomer =
    route.fileLevelMiddleware.includes("requireCustomer") || route.routeMiddleware.includes("requireCustomer");
  const softCustomer =
    route.fileLevelMiddleware.includes("attachCustomerIfPresent") || route.routeMiddleware.includes("attachCustomerIfPresent");
  if (hardCustomer) return "customer";
  if (softCustomer || route.inlineCustomerCheck) return "customer-or-guest";
  return "public";
}
