import { makeFinding } from "../evidence/Finding.js";

// Legitimately unauthenticated by design: you cannot require a staff
// session to obtain your first staff session. /login checks
// email+password; /complete-setup checks a one-time setup_token in the
// request body (server/src/routes/adminAuthRoutes.js) - both are gated by
// an alternate credential, not by requireStaffAuth.
const ADMIN_AUTH_BOOTSTRAP_ROUTES = new Set(["POST /api/admin/auth/login", "POST /api/admin/auth/complete-setup"]);

// Legitimately staff-auth-only, no role permission required: these mutate
// only the CALLER's own account (self-service), not another entity a role
// permission would meaningfully scope - see server/src/routes/adminAuthRoutes.js.
const SELF_SERVICE_ROUTES = new Set(["POST /api/admin/auth/change-password"]);

/** Layer 5 (Security/RBAC) checker. Evidence-based rules calibrated to this
 * repo's actual, consistent auth conventions (see server/src/auth/adminAuth.js,
 * customerAuth.js, rbac.js):
 *  - Every /api/admin/* route must be reachable only behind requireStaffAuth
 *    (file-level router.use or per-route arg). Missing it is a P0: an
 *    unauthenticated caller could hit an admin endpoint directly.
 *  - Every mutating (non-GET) admin route should additionally go through
 *    requirePermission(action) - a mutating admin route with auth but no
 *    permission check lets ANY staff role perform it, bypassing RBAC. P1.
 *  - Customer-owned data routes (actorType customer / customer-or-guest)
 *    must be gated by requireCustomer OR an inline `if (!req.customer)`
 *    check in the handler body (this repo's established alternative
 *    pattern - see server/src/routes/public.js). A route that reads/writes
 *    req.customer-scoped data with neither is a P0.
 *  - A softly-gated route (attachCustomerIfPresent only) that never
 *    references req.customer at all is fine (guest-usable by design). */
export function checkRbac(evidence) {
  const findings = [];
  const { routes } = evidence.server;

  for (const r of routes) {
    if (r.actorType === "admin") {
      if (ADMIN_AUTH_BOOTSTRAP_ROUTES.has(`${r.method} ${r.fullPath}`)) continue;
      const hasStaffAuth = r.fileLevelMiddleware.includes("requireStaffAuth") || r.routeMiddleware.includes("requireStaffAuth");
      if (!hasStaffAuth) {
        findings.push(
          makeFinding({
            layer: "L5-security-rbac",
            category: "rbac",
            file: r.file,
            line: r.line,
            route: `${r.method} ${r.fullPath}`,
            observed: `Route is mounted under /api/admin but no requireStaffAuth middleware was found (file-level or per-route).`,
            expected: "Every /api/admin/* route must require staff authentication.",
            evidence: `${r.file}:${r.line} - fileLevelMiddleware=${JSON.stringify(r.fileLevelMiddleware)}, routeMiddleware=${JSON.stringify(r.routeMiddleware)}.`,
            severity: "P0",
            confidence: "high",
            recommendedFix: "Add requireStaffAuth to this route (or via router.use at the top of the file).",
          })
        );
        continue;
      }
      const hasPermission =
        r.fileLevelMiddleware.some((m) => m.startsWith("requirePermission")) || r.routeMiddleware.some((m) => m.startsWith("requirePermission"));
      if (r.mutating && !hasPermission && !SELF_SERVICE_ROUTES.has(`${r.method} ${r.fullPath}`)) {
        findings.push(
          makeFinding({
            layer: "L5-security-rbac",
            category: "rbac",
            file: r.file,
            line: r.line,
            route: `${r.method} ${r.fullPath}`,
            observed: "Mutating admin route has requireStaffAuth but no requirePermission(...) check.",
            expected: "Mutating admin routes should scope by role via requirePermission, not just 'is some staff member'.",
            evidence: `${r.file}:${r.line} - routeMiddleware=${JSON.stringify(r.routeMiddleware)}.`,
            severity: "P1",
            confidence: "medium",
            recommendedFix: "Add requirePermission('<action>') matching this route's domain, consistent with sibling routes in the same file.",
          })
        );
      }
      continue;
    }

    if (r.actorType === "customer" || r.actorType === "customer-or-guest") {
      const touchesCustomerData = r.usesReqCustomer;
      if (!touchesCustomerData) continue; // guest-usable by design (e.g. product browsing under a soft-auth router)
      const hardGate = r.fileLevelMiddleware.includes("requireCustomer") || r.routeMiddleware.includes("requireCustomer");
      const inlineGate = r.inlineCustomerCheck;
      // req.customer?.x / a truthy-`req.customer` guard is this repo's
      // established "works for guests too" pattern (verified against
      // paymentsPublic.js verify/retry, public.js dosha-results,
      // wellnessPublic.js assessment/submit) - not a missing gate.
      if (r.hasOptionalOrGuardedCustomerAccess && !hardGate && !inlineGate) continue;
      if (!hardGate && !inlineGate) {
        findings.push(
          makeFinding({
            layer: "L5-security-rbac",
            category: "rbac",
            file: r.file,
            line: r.line,
            route: `${r.method} ${r.fullPath}`,
            observed: "Route reads/writes req.customer-scoped data but has neither requireCustomer middleware nor an inline `if (!req.customer)` guard.",
            expected: "Any route that branches on req.customer identity must reject unauthenticated callers before touching customer data.",
            evidence: `${r.file}:${r.line} - usesReqCustomer=true, hardGate=false, inlineGate=false.`,
            severity: "P0",
            confidence: "medium",
            recommendedFix: "Add requireCustomer (preferred, matches sibling files) or an explicit `if (!req.customer) return res.status(401)...` guard.",
          })
        );
      } else if (!hardGate && inlineGate) {
        findings.push(
          makeFinding({
            layer: "L5-security-rbac",
            category: "rbac-consistency",
            file: r.file,
            line: r.line,
            route: `${r.method} ${r.fullPath}`,
            observed: "Route gates customer identity with an inline `if (!req.customer)` check instead of the shared requireCustomer middleware used by sibling route files.",
            expected: "Consistent use of the shared requireCustomer middleware across all customer-owned-data routes.",
            evidence: `${r.file}:${r.line} - inlineCustomerCheck=true, requireCustomer middleware not applied.`,
            severity: "P3",
            confidence: "high",
            recommendedFix: "Non-blocking style consistency note; functionally equivalent to requireCustomer today.",
          })
        );
      }
    }
  }

  return { findings };
}
