import { pathsMatch } from "./matchPath.js";
import { makeFinding } from "../evidence/Finding.js";

/** Layer 1 (UI -> API) contract checker: cross-references every discovered
 * frontend API call against the discovered backend route table.
 *  - ORPHAN_FRONTEND_CALL: the frontend calls a method+path with no matching
 *    backend route at all -> the button/page is wired to nothing.
 *  - DEAD_ENDPOINT: a backend route with zero frontend callers. Reported at
 *    low severity/confidence since legitimate reasons are common here
 *    (webhooks called by an external provider, endpoints driven by a second,
 *    not-yet-crawled admin surface, admin-only bulk/report endpoints, etc.) -
 *    this is a lead for a human to check, not a claim the endpoint is unused. */
export function checkContracts(evidence) {
  const { routes } = evidence.server;
  const { calls } = evidence.frontend;
  const findings = [];

  const routeMatchCounts = new Map(routes.map((r) => [r, 0]));

  for (const call of calls) {
    const matches = routes.filter((r) => r.method === call.method && pathsMatch(r.fullPath, call.fullPath));
    if (matches.length === 0) {
      findings.push(
        makeFinding({
          layer: "L1-ui-to-api",
          category: "contract",
          file: call.file,
          line: call.line,
          route: `${call.method} ${call.fullPath}`,
          observed: `Frontend calls ${call.method} ${call.rawPath} via ${call.client}, but no backend route matches ${call.method} ${call.fullPath}.`,
          expected: "Every frontend API call should resolve to a real, mounted backend route.",
          evidence: `${call.file}:${call.line} calls ${call.method} '${call.rawPath}'; no route among ${routes.length} discovered backend routes matches after path-parameter normalization.`,
          severity: "P1",
          confidence: "medium",
          recommendedFix:
            "Verify the intended endpoint manually - this may be a real dead link, or a path-construction pattern (string concatenation, computed variable) this regex-based scanner cannot fully resolve.",
        })
      );
    } else {
      for (const r of matches) routeMatchCounts.set(r, (routeMatchCounts.get(r) || 0) + 1);
    }
  }

  for (const r of routes) {
    if (r.actorType === "external-webhook") continue; // called by the payment/shipping provider, not our frontend
    if (r.file === "server/src/routes/pages.js") continue; // SSR page routes are browser-navigated, never fetch()-called
    if ((routeMatchCounts.get(r) || 0) > 0) continue;
    findings.push(
      makeFinding({
        layer: "L1-ui-to-api",
        category: "contract",
        file: r.file,
        line: r.line,
        route: `${r.method} ${r.fullPath}`,
        observed: `No discovered frontend call (admin/ or public-site/) targets ${r.method} ${r.fullPath}.`,
        expected: "Every customer/admin-facing backend route should have at least one frontend caller, unless intentionally external/internal-only.",
        evidence: `Static scan of admin/**/*.{html,js} and public-site/**/*.{html,js} found zero call sites matching ${r.method} ${r.fullPath}.`,
        severity: "P3",
        confidence: "low",
        recommendedFix:
          "Confirm this route is intentionally unused by this frontend (e.g. reserved for a future admin surface, an internal script, or called with a path pattern this scanner can't statically resolve) before treating it as dead code.",
      })
    );
  }

  return { findings, totalRoutes: routes.length, totalCalls: calls.length };
}
