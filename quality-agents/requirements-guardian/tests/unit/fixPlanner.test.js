import { classifyFixPolicy, planFixes, buildFixPlan } from "../../src/fix-planner/planFixes.js";
import { assertEqual, assert } from "../helpers.js";

export default async function run() {
  // Anything touching payment/tax/order/inventory/auth/schema/secrets must
  // NEVER be auto-fixable, regardless of severity (spec section 21/22).
  assertEqual(classifyFixPolicy({ affectedArea: "payments", requirementId: "REQ-PAYMENT-RETRY-001", title: "x" }), "NEVER_AUTO_FIX", "payment-related finding must be NEVER_AUTO_FIX");
  assertEqual(classifyFixPolicy({ affectedArea: "orders", requirementId: "REQ-ORDERS-STATE-001", title: "x" }), "NEVER_AUTO_FIX", "order-related finding must be NEVER_AUTO_FIX");
  assertEqual(classifyFixPolicy({ affectedArea: "security", requirementId: "REQ-RBAC-001", title: "x" }), "NEVER_AUTO_FIX", "auth/rbac finding must be NEVER_AUTO_FIX");
  assertEqual(classifyFixPolicy({ affectedArea: "legal", requirementId: "REQ-LEGAL-002", title: "closed set" }), "REVIEW_REQUIRED", "an unrelated area must fall through to REVIEW_REQUIRED");

  // There is no SAFE_AUTO_FIX bucket at all - Requirements Guardian never
  // modifies application behavior.
  const allPolicies = new Set(
    [
      { affectedArea: "payments" },
      { affectedArea: "legal" },
      { affectedArea: "notifications" },
      { affectedArea: "wellness" },
    ].map((f) => classifyFixPolicy(f))
  );
  assert(!allPolicies.has("SAFE_AUTO_FIX"), "SAFE_AUTO_FIX must never be produced by this planner");

  const findings = [
    { id: "RG-0001", affectedArea: "payments", requirementId: "REQ-PAYMENT-RETRY-001", title: "payment retry gap", expected: "e", observed: "o", recommendation: "r" },
  ];
  const planned = planFixes(findings);
  assertEqual(planned[0].fixPolicy, "NEVER_AUTO_FIX", "planFixes must annotate fixPolicy onto the finding");

  const plan = buildFixPlan(planned);
  assertEqual(plan.length, 1, "one fix plan entry per actionable finding");
  assertEqual(plan[0].findingId, "RG-0001", "fix plan entry must reference the originating finding id");
  assertEqual(plan[0].humanApprovalRequired, true, "every fix plan entry must require human approval - nothing is ever auto-applied");
  assert(!("patch" in plan[0]) && !("diff" in plan[0]), "a fix plan entry must never include an actual code patch/diff");

  return { assertions: 9 };
}
