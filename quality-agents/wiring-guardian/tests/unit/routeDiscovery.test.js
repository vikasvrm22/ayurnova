import { parseRouteFile } from "../../src/discovery/routeDiscovery.js";
import { assert, assertEqual } from "../helpers.js";

const FIXTURE = `
import { Router } from "express";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { requireCustomer, attachCustomerIfPresent } from "../auth/customerAuth.js";

const router = Router();

// Regression check: a single router.use() call with TWO middleware where
// the second one is itself a function call with its own closing paren
// (requirePermission("x")) must not truncate at requirePermission's inner ")".
router.use(requireStaffAuth, requirePermission("manageIntegrations"));

router.get("/", async (req, res, next) => {
  res.json({ ok: true });
});

router.put("/:id/status", requireStaffAuth, requirePermission("manageOrders"), async (req, res, next) => {
  if (!req.staff) return res.status(401).json({});
  await supabaseAdmin().from("orders").update({}).eq("id", req.params.id);
  res.json({});
});

router.post("/dosha-results", async (req, res, next) => {
  const x = req.customer?.id || null;
  await supabaseAdmin().from("dosha_results").insert({ customer_id: x });
  res.json({ success: true });
});
`;

export default async function () {
  const routes = parseRouteFile(FIXTURE, "fixture.js");
  assertEqual(routes.length, 3, "parses three route declarations");

  const rootGet = routes.find((r) => r.method === "GET" && r.routePath === "/");
  assert(rootGet, "finds the GET / route");
  assert(rootGet.fileLevelMiddleware.includes("requireStaffAuth"), "file-level requireStaffAuth recovered despite nested-paren router.use()");
  assert(
    rootGet.fileLevelMiddleware.some((m) => m.startsWith("requirePermission")),
    "file-level requirePermission recovered despite nested-paren router.use() (regression for the truncation bug)"
  );

  const statusRoute = routes.find((r) => r.routePath === "/:id/status");
  assert(statusRoute.routeMiddleware.includes("requireStaffAuth"), "per-route requireStaffAuth captured");
  assert(statusRoute.routeMiddleware.some((m) => m === "requirePermission(manageOrders)"), "per-route requirePermission argument captured");
  assert(statusRoute.mutating, "PUT is mutating");

  const doshaRoute = routes.find((r) => r.routePath === "/dosha-results");
  assert(doshaRoute.hasOptionalOrGuardedCustomerAccess, "req.customer?.id is recognized as guest-optional access, not a required gate");
  assert(!doshaRoute.inlineCustomerCheck, "no `if (!req.customer)` guard present in this fixture");

  return { routesParsed: routes.length };
}
