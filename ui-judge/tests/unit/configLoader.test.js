import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectConfig, resolvePage, defaultPaths } from "../../src/lib/configLoader.js";
import { assert } from "../helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export default async function run() {
  const paths = defaultPaths(ROOT);
  const config = loadProjectConfig(paths.defaultConfig);
  assert(config.pages.length >= 1, "the live project config must define at least one page");
  assert(config.baseUrl, "the live project config must define a baseUrl");

  const page = resolvePage(config, config.pages[0].name);
  assert(/^https?:\/\//.test(page.fullUrl), `resolved page must produce an absolute URL, got ${page.fullUrl}`);
  assert(path.isAbsolute(page.referenceAbsPath), "reference path must be resolved to an absolute path");

  let threw = false;
  try { resolvePage(config, "definitely-not-a-configured-page"); } catch { threw = true; }
  assert(threw, "resolvePage must throw for an unknown page with no --url override");

  const withOverrides = resolvePage(config, config.pages[0].name, { width: 800, height: 600 });
  assert(withOverrides.viewport.width === 800 && withOverrides.viewport.height === 600, "CLI viewport overrides must take effect");

  return { name: "configLoader" };
}
