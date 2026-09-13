// Loads pages.config.json / weights.json / severity.thresholds.json and
// resolves everything relative to the config file's own directory, then
// applies CLI overrides on top. Keeping path resolution in one place is
// what lets the same engine serve any project: nothing here is aware of
// "admin" or "public-site" specifically.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI_JUDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

export function loadProjectConfig(configPath) {
  const abs = path.resolve(configPath);
  const dir = path.dirname(abs);
  const raw = readJson(abs);
  const pages = (raw.pages || []).map((p) => ({
    ...p,
    referenceAbsPath: path.resolve(dir, p.reference),
  }));
  const sourceRoots = (raw.sourceRoots || []).map((r) => path.resolve(dir, r));
  const authStorageStatePath = raw.auth?.storageState ? path.resolve(dir, raw.auth.storageState) : null;
  return { baseUrl: raw.baseUrl, pages, sourceRoots, configDir: dir, authStorageStatePath };
}

export function resolvePage(projectConfig, name, overrides = {}) {
  const found = projectConfig.pages.find((p) => p.name === name);
  const base = found || { name, viewport: { width: 1440, height: 900 } };
  const merged = { ...base };

  if (overrides.url) merged.route = overrides.url; // full override, treated as an absolute URL below
  if (overrides.reference) {
    merged.referenceAbsPath = path.resolve(process.cwd(), overrides.reference);
    merged.reference = overrides.reference;
  }
  if (overrides.width || overrides.height) {
    merged.viewport = { width: overrides.width || merged.viewport?.width || 1440, height: overrides.height || merged.viewport?.height || 900 };
  }
  if (!merged.viewport) merged.viewport = { width: 1440, height: 900 };

  if (!found && !overrides.url) throw new Error(`Page "${name}" not found in config and no --url override given.`);
  if (!merged.referenceAbsPath) throw new Error(`Page "${name}" has no reference image (config or --reference).`);
  if (!fs.existsSync(merged.referenceAbsPath)) throw new Error(`Reference image not found: ${merged.referenceAbsPath}`);

  const isAbsoluteUrl = /^https?:\/\//i.test(merged.route || "");
  merged.fullUrl = isAbsoluteUrl ? merged.route : new URL(merged.route || "/", overrides.baseUrl || projectConfig.baseUrl || "http://localhost:5100").toString();

  return merged;
}

export function loadWeightsFile(p) { return readJson(p); }
export function loadSeverityThresholds(p) { return readJson(p); }
export function defaultPaths(root = UI_JUDGE_ROOT) {
  return {
    root,
    defaultConfig: path.join(root, "config", "pages.config.json"),
    defaultWeights: path.join(root, "config", "weights.json"),
    defaultSeverity: path.join(root, "config", "severity.thresholds.json"),
    specsDir: path.join(root, "specs"),
    screenshotsDir: path.join(root, "screenshots"),
    reportsDir: path.join(root, "reports"),
    baselinesDir: path.join(root, "baselines"),
  };
}
