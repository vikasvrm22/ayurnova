import fs from "fs";
import path from "path";
import os from "os";
import { checkIntegrations } from "../../src/integration-engine/checkIntegrations.js";
import { resetFindingCounter } from "../../src/evidence/Finding.js";
import { assert } from "../helpers.js";

const ADMIN_ROUTE_JS = `
import * as goodProvider from "../integrations/good/provider.js";
import * as badProvider from "../integrations/bad/provider.js";

const PROVIDERS = {
  good: goodProvider,
  bad: badProvider,
};

router.post("/:provider/:environment/test-connection", async (req, res) => {
  const result = await PROVIDERS[req.params.provider].testConnection(req.params.environment);
  res.json(result);
});

router.post("/:provider/:environment/diagnostics", async (req, res) => {
  const provider = PROVIDERS[req.params.provider];
  if (typeof provider.runDiagnostics !== "function") {
    return res.status(404).json({});
  }
  const steps = await provider.runDiagnostics(req.params.environment);
  res.json({ steps });
});
`;

export default async function () {
  resetFindingCounter();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wg-integrations-test-"));
  const routesDir = path.join(tmpRoot, "server", "src", "routes");
  const goodDir = path.join(tmpRoot, "server", "src", "integrations", "good");
  const badDir = path.join(tmpRoot, "server", "src", "integrations", "bad");
  fs.mkdirSync(routesDir, { recursive: true });
  fs.mkdirSync(goodDir, { recursive: true });
  fs.mkdirSync(badDir, { recursive: true });

  fs.writeFileSync(path.join(routesDir, "integrationsAdmin.js"), ADMIN_ROUTE_JS, "utf8");
  fs.writeFileSync(
    path.join(goodDir, "provider.js"),
    `export async function testConnection(env) { return { ok: true }; }\nexport async function runDiagnostics(env) { return []; }`,
    "utf8"
  );
  // "bad" provider is missing testConnection entirely - a real wiring break for every call to it.
  fs.writeFileSync(path.join(badDir, "provider.js"), `export const LABEL = "Bad Provider";`, "utf8");

  const { findings } = checkIntegrations(tmpRoot);

  assert(
    findings.some((f) => f.file.includes("bad/provider.js") && f.observed.includes("testConnection")),
    "a provider missing the unconditionally-called testConnection is flagged"
  );
  assert(
    !findings.some((f) => f.observed.includes("runDiagnostics")),
    "runDiagnostics is guarded by a typeof check in the route, so its absence on any provider is never flagged (it's documented as optional-per-provider)"
  );
  assert(!findings.some((f) => f.file.includes("good/provider.js")), "a fully-compliant provider raises nothing");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  return { findingsCount: findings.length };
}
