import { checkRbac } from "../../src/security-engine/checkRbac.js";
import { resetFindingCounter } from "../../src/evidence/Finding.js";
import { assert } from "../helpers.js";

function route(overrides) {
  return {
    file: "server/src/routes/fixture.js",
    line: 1,
    method: "POST",
    fullPath: "/api/admin/fixture",
    fileLevelMiddleware: [],
    routeMiddleware: [],
    inlineCustomerCheck: false,
    hasOptionalOrGuardedCustomerAccess: false,
    usesReqCustomer: false,
    mutating: true,
    actorType: "admin",
    ...overrides,
  };
}

export default async function () {
  resetFindingCounter();

  const routes = [
    // 1. Admin route with no auth at all -> P0
    route({ fullPath: "/api/admin/unprotected", fileLevelMiddleware: [], routeMiddleware: [] }),
    // 2. Admin route with staff auth but no permission check -> P1
    route({ fullPath: "/api/admin/no-permission", routeMiddleware: ["requireStaffAuth"] }),
    // 3. Admin route fully protected -> no finding
    route({ fullPath: "/api/admin/fully-protected", routeMiddleware: ["requireStaffAuth", "requirePermission(manageOrders)"] }),
    // 4. Known bootstrap route -> exempt even with zero middleware
    route({ fullPath: "/api/admin/auth/login", routeMiddleware: [] }),
    // 5. Known self-service route -> exempt from the missing-permission check
    route({ fullPath: "/api/admin/auth/change-password", routeMiddleware: ["requireStaffAuth"] }),
    // 6. Customer route touching customer data with no gate at all -> P0
    route({ actorType: "customer-or-guest", fullPath: "/api/public/my-thing", usesReqCustomer: true }),
    // 7. Customer route using req.customer?.x (guest-optional) with no hard gate -> no finding
    route({ actorType: "customer-or-guest", fullPath: "/api/public/optional-thing", usesReqCustomer: true, hasOptionalOrGuardedCustomerAccess: true }),
    // 8. Customer route with requireCustomer -> no finding
    route({ actorType: "customer", fullPath: "/api/public/owned-thing", usesReqCustomer: true, fileLevelMiddleware: ["requireCustomer"] }),
  ];

  const { findings } = checkRbac({ server: { routes } });
  const byRoute = (path) => findings.filter((f) => f.route?.endsWith(path));

  assert(byRoute("/unprotected").some((f) => f.severity === "P0"), "admin route with zero auth middleware is P0");
  assert(byRoute("/no-permission").some((f) => f.severity === "P1"), "mutating admin route missing requirePermission is P1");
  assert(byRoute("/fully-protected").length === 0, "fully protected admin route raises nothing");
  assert(byRoute("/auth/login").length === 0, "the login bootstrap route is exempt from the admin-auth check");
  assert(byRoute("/auth/change-password").length === 0, "the self-service change-password route is exempt from the missing-permission check");
  assert(byRoute("/my-thing").some((f) => f.severity === "P0"), "customer-data route with no gate at all is P0");
  assert(byRoute("/optional-thing").length === 0, "req.customer?.x guest-optional access is not flagged as a missing gate");
  assert(byRoute("/owned-thing").length === 0, "requireCustomer-gated route raises nothing");

  return { findingsCount: findings.length };
}
