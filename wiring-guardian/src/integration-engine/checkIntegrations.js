import path from "path";
import { readText } from "../discovery/fsWalk.js";
import { makeFinding } from "../evidence/Finding.js";

const IMPORT_STAR_RE = /import\s+\*\s+as\s+(\w+)\s+from\s+["'`]\.\.\/integrations\/([\w./-]+)\.js["'`]/g;
const NAMED_IMPORT_RE = /import\s+\{\s*(\w+)\s*\}\s+from\s+["'`]\.\.\/integrations\/([\w./-]+)\.js["'`]/g;
const REQUIRED_METHOD_RE = /(?:PROVIDERS\[[^\]]+\]|provider)\.(\w+)\(/g;
// A method the route itself guards with `typeof x.method !== "function"`
// before calling it is deliberately OPTIONAL per-provider (a documented,
// gracefully-handled capability, not something every provider must
// implement) - e.g. runDiagnostics in integrationsAdmin.js, which 404s
// honestly for a provider that doesn't support it rather than assuming one.
const OPTIONAL_GUARD_RE = /typeof\s+(?:provider|PROVIDERS\[[^\]]+\])\.(\w+)\s*!==?\s*["'`]function["'`]/g;
const EXPORT_RE = (name) => new RegExp(`export\\s+(?:async\\s+)?(?:function\\s+${name}\\b|const\\s+${name}\\s*=)`);

/** Section 19 (external integration wiring) checker. integrationsAdmin.js
 * dispatches every provider action (test-connection, diagnostics) through a
 * generic PROVIDERS[provider].method(...) call - so every registered
 * provider module MUST export every method that route file calls on it, or
 * that admin action throws at runtime for that provider. This discovers the
 * required method set and the registered provider set directly from
 * integrationsAdmin.js + shipping/registry.js (not a hardcoded provider
 * list), then verifies each provider module's exports. */
export function checkIntegrations(repoRoot) {
  const findings = [];
  const adminRoutePath = "server/src/routes/integrationsAdmin.js";
  const adminSrc = safeRead(path.join(repoRoot, adminRoutePath));
  if (!adminSrc) return { findings };

  const varToPath = new Map();
  for (const m of adminSrc.matchAll(IMPORT_STAR_RE)) varToPath.set(m[1], m[2]);
  for (const m of adminSrc.matchAll(NAMED_IMPORT_RE)) varToPath.set(m[1], m[2]);

  const providerBlockMatch = adminSrc.match(/const\s+PROVIDERS\s*=\s*\{([\s\S]*?)\n?\};/);
  const providers = new Map(); // providerKey -> relative module path (relative to server/src/integrations)
  if (providerBlockMatch) {
    const body = providerBlockMatch[1];
    for (const m of body.matchAll(/(\w+)\s*:\s*(\w+)/g)) {
      const [, key, varName] = m;
      if (varToPath.has(varName)) providers.set(key, varToPath.get(varName));
    }
    if (/\.\.\.SHIPPING_PROVIDERS/.test(body)) {
      const registryPath = path.join(repoRoot, "server/src/integrations/shipping/registry.js");
      const registrySrc = safeRead(registryPath);
      if (registrySrc) {
        const regVarToPath = new Map();
        for (const m of registrySrc.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+["'`]\.\/([\w./-]+)\.js["'`]/g)) {
          regVarToPath.set(m[1], `shipping/${m[2]}`);
        }
        const mapMatch = registrySrc.match(/export\s+const\s+SHIPPING_PROVIDERS\s*=\s*\{([\s\S]*?)\n?\};/);
        if (mapMatch) {
          for (const m of mapMatch[1].matchAll(/(\w+)\s*:\s*(\w+)/g)) {
            const [, key, varName] = m;
            if (regVarToPath.has(varName)) providers.set(key, regVarToPath.get(varName));
          }
        }
      }
    }
  }

  const allCalledMethods = new Set([...adminSrc.matchAll(REQUIRED_METHOD_RE)].map((m) => m[1]));
  const optionalMethods = new Set([...adminSrc.matchAll(OPTIONAL_GUARD_RE)].map((m) => m[1]));
  const requiredMethods = new Set([...allCalledMethods].filter((m) => !optionalMethods.has(m)));

  if (providers.size === 0 || requiredMethods.size === 0) {
    findings.push(
      makeFinding({
        layer: "L-integrations",
        category: "integration",
        file: adminRoutePath,
        route: null,
        observed: `Discovered ${providers.size} provider(s) and ${requiredMethods.size} required method(s) - expected both to be non-zero.`,
        expected: "The generic PROVIDERS registry and its dispatched methods should be discoverable from integrationsAdmin.js.",
        evidence: `Regex scan of ${adminRoutePath} for 'const PROVIDERS = {...}' and 'PROVIDERS[...].method(' / 'provider.method(' patterns.`,
        severity: "P2",
        confidence: "low",
        recommendedFix: "integrationsAdmin.js may have been refactored - update this checker's parsing patterns to match.",
      })
    );
    return { findings };
  }

  for (const [providerKey, relPath] of providers) {
    const providerFile = `server/src/integrations/${relPath}.js`;
    const providerSrc = safeRead(path.join(repoRoot, providerFile));
    if (!providerSrc) {
      findings.push(
        makeFinding({
          layer: "L-integrations",
          category: "integration",
          file: providerFile,
          route: `POST /api/admin/integrations/${providerKey}/:environment/test-connection`,
          observed: `Provider '${providerKey}' is registered in PROVIDERS but its module file could not be read at ${providerFile}.`,
          expected: "Every registered provider must have a real, readable module file.",
          evidence: `File not found or unreadable: ${providerFile}.`,
          severity: "P1",
          confidence: "medium",
          recommendedFix: "Confirm the import path in integrationsAdmin.js still matches the real file location.",
        })
      );
      continue;
    }
    for (const method of requiredMethods) {
      if (!EXPORT_RE(method).test(providerSrc)) {
        findings.push(
          makeFinding({
            layer: "L-integrations",
            category: "integration",
            file: providerFile,
            route: `POST /api/admin/integrations/${providerKey}/:environment/(test-connection|diagnostics)`,
            observed: `Provider '${providerKey}' (${providerFile}) does not export '${method}', but integrationsAdmin.js calls PROVIDERS['${providerKey}'].${method}(...) generically for every provider.`,
            expected: `Every provider module reachable through the generic PROVIDERS dispatch must export every method that dispatch calls (${[...requiredMethods].join(", ")}).`,
            evidence: `${adminRoutePath} calls '.${method}(' on the PROVIDERS-dispatched value; ${providerFile} has no 'export function ${method}' or 'export const ${method}'.`,
            severity: "P1",
            confidence: "high",
            recommendedFix: `Add an exported '${method}' function to ${providerFile}, matching the shape of the other registered providers.`,
          })
        );
      }
    }
  }

  return { findings };
}

function safeRead(p) {
  try {
    return readText(p);
  } catch {
    return null;
  }
}
