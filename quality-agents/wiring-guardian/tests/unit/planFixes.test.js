import { classifyFix, fixerIdFor, planFixes } from "../../src/fix-planner/planFixes.js";
import { assert, assertEqual } from "../helpers.js";

export default async function () {
  assertEqual(
    classifyFix({ severity: "P0", category: "rbac", file: "server/src/auth/adminAuth.js" }),
    "NEVER_AUTO_FIX",
    "an auth-architecture finding is never eligible for auto-fix"
  );
  assertEqual(
    classifyFix({ severity: "P0", category: "feature-flag", file: "server/src/routes/public.js" }),
    "REVIEW_REQUIRED",
    "a P0 payment/checkout-adjacent finding defaults to review even without an explicit NEVER pattern match"
  );
  assertEqual(
    classifyFix({ severity: "P2", category: "feature-flag", file: "public-site/cart.html" }),
    "SAFE_AUTO_FIX",
    "the whitelisted COD-radio-gating finding is safe to auto-fix"
  );
  assertEqual(fixerIdFor({ category: "feature-flag", file: "public-site/cart.html" }), "codRadioGate", "resolves the correct fixer id");
  assertEqual(
    classifyFix({ severity: "P1", category: "contract", file: "admin/users.html" }),
    "SAFE_AUTO_FIX",
    "the whitelisted admin-staff-path finding is safe to auto-fix even at P1"
  );
  assertEqual(
    classifyFix({ severity: "P3", category: "contract", file: "admin/some-other-page.html" }),
    "REVIEW_REQUIRED",
    "an unrelated contract finding is not swept into the whitelist just by category"
  );
  assertEqual(
    classifyFix({ severity: "P1", category: "state", file: "supabase/migrations/0002_x.sql" }),
    "NEVER_AUTO_FIX",
    "a schema/migration finding is never eligible for auto-fix"
  );

  const planned = planFixes([{ severity: "P0", category: "rbac", file: "server/src/auth/x.js" }]);
  assert(planned[0].fixPolicy === "NEVER_AUTO_FIX", "planFixes() annotates findings with fixPolicy without mutating other fields incorrectly");

  return { checks: 8 };
}
