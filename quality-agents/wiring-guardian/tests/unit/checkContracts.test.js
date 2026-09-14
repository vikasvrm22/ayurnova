import { checkContracts } from "../../src/contract-engine/checkContracts.js";
import { resetFindingCounter } from "../../src/evidence/Finding.js";
import { assert } from "../helpers.js";

function makeEvidence({ routes, calls }) {
  return { server: { routes }, frontend: { calls } };
}

export default async function () {
  resetFindingCounter();

  const evidence = makeEvidence({
    routes: [
      { file: "server/src/routes/orders.js", line: 10, method: "GET", fullPath: "/api/admin/orders/:id", actorType: "admin" },
      { file: "server/src/routes/pages.js", line: 5, method: "GET", fullPath: "/shop", actorType: "public" },
      { file: "server/src/routes/shipmentWebhooksPublic.js", line: 3, method: "POST", fullPath: "/api/public/shipping-webhooks", actorType: "external-webhook" },
      { file: "server/src/routes/orphan.js", line: 1, method: "GET", fullPath: "/api/admin/orphan", actorType: "admin" },
    ],
    calls: [
      { file: "admin/orders.html", line: 20, method: "GET", rawPath: "/orders/${id}", fullPath: "/api/admin/orders/:param", client: "Api wrapper" },
      { file: "admin/broken.html", line: 5, method: "GET", rawPath: "/does-not-exist", fullPath: "/api/admin/does-not-exist", client: "Api wrapper" },
    ],
  });

  const { findings } = checkContracts(evidence);

  const orphanCall = findings.find((f) => f.category === "contract" && f.observed.includes("does-not-exist"));
  assert(orphanCall && orphanCall.severity === "P1", "a frontend call with no matching route is an ORPHAN_FRONTEND_CALL at P1");

  const deadEndpoint = findings.find((f) => f.route === "GET /api/admin/orphan");
  assert(deadEndpoint && deadEndpoint.severity === "P3" && deadEndpoint.confidence === "low", "an uncalled admin route is a low-confidence P3 lead, not an assertion of a bug");

  assert(!findings.some((f) => f.route === "GET /shop"), "SSR page routes (pages.js) are excluded from the dead-endpoint sweep");
  assert(!findings.some((f) => f.route === "POST /api/public/shipping-webhooks"), "external-webhook routes are excluded from the dead-endpoint sweep");
  assert(!findings.some((f) => f.route === "GET /api/admin/orders/:id"), "a route with a real matching frontend call raises no finding");

  return { findingsCount: findings.length };
}
