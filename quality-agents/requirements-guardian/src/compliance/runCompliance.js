import * as realCheckers from "./checkers/index.js";
import { makeFinding } from "../evidence/Finding.js";

/** Applies lifecycle-aware compliance rules to one requirement (spec
 * sections 7-8): a FUTURE requirement is never reported as "missing" - it
 * is only checked for PREMATURE (unapproved) implementation. A DEPRECATED
 * requirement is only checked for residual old behavior. HISTORICAL and
 * CONFLICTED never run a normal compliance check. NEEDS_REVIEW lifecycle
 * requirements are always reported NEEDS_REVIEW regardless of checker.
 * `checkers` is injectable (defaults to the real ./checkers/index.js) so
 * the Guardian's own unit tests can exercise this lifecycle logic against
 * small synthetic fixtures instead of the live repository. */
function runOneRequirement(req, repoRoot, checkers) {
  if (req.lifecycle === "HISTORICAL") {
    return { requirementId: req.id, lifecycle: req.lifecycle, compliance: "NOT_APPLICABLE", confidence: "HIGH", expected: null, observed: "Historical reference only - not evaluated against current implementation.", evidence: [] };
  }
  if (req.lifecycle === "CONFLICTED") {
    return { requirementId: req.id, lifecycle: req.lifecycle, compliance: "NEEDS_REVIEW", confidence: "HIGH", expected: null, observed: "Authoritative sources conflict - see requirement's sourceReference for both sides. Not auto-resolved.", evidence: [] };
  }
  if (req.lifecycle === "NEEDS_REVIEW") {
    // The requirement's own lifecycle is already uncertain (e.g. an open
    // business decision) - still run its checker if one exists, so a
    // NEEDS_REVIEW item can surface concrete supporting evidence, but the
    // compliance verdict is never allowed to read as a clean PASS.
    const verdict = req.checkerId && checkers[req.checkerId] ? checkers[req.checkerId](repoRoot) : null;
    return {
      requirementId: req.id,
      lifecycle: req.lifecycle,
      compliance: "NEEDS_REVIEW",
      confidence: verdict?.confidence || "LOW",
      expected: verdict?.expected || null,
      observed: verdict?.observed || "This requirement's lifecycle itself is NEEDS_REVIEW (an open business/ops decision) - see sourceReference.",
      evidence: verdict?.evidence || [],
      recommendation: verdict?.recommendation || null,
    };
  }

  if (!req.checkerId || !checkers[req.checkerId]) {
    return {
      requirementId: req.id,
      lifecycle: req.lifecycle,
      compliance: req.lifecycle === "FUTURE" ? "NOT_APPLICABLE" : "NEEDS_REVIEW",
      confidence: "LOW",
      expected: null,
      observed: req.lifecycle === "FUTURE"
        ? "Explicitly deferred/future requirement with no automated premature-implementation check - absence is correctly NOT a defect."
        : "No automated checker implemented for this requirement - requires manual verification.",
      evidence: [],
    };
  }

  const verdict = checkers[req.checkerId](repoRoot);

  if (req.lifecycle === "FUTURE") {
    // A FUTURE requirement's checker (when present) exists ONLY to detect
    // premature/unapproved implementation, never to report "missing" as a
    // defect (spec section 11/17). `...verdict` is spread FIRST so the
    // explicit `compliance:` override below always wins.
    const prematurelyImplemented = verdict.compliance === "IMPLEMENTED" || verdict.compliance === "UNAPPROVED";
    return {
      requirementId: req.id,
      lifecycle: req.lifecycle,
      ...verdict,
      compliance: prematurelyImplemented ? "UNAPPROVED" : "NOT_APPLICABLE",
    };
  }

  if (req.lifecycle === "DEPRECATED") {
    // Only residual-old-behavior detection matters; a deprecated
    // requirement's checker reports ACCIDENTALLY_CHANGED for regression,
    // otherwise NOT_APPLICABLE (deprecation intact).
    return {
      requirementId: req.id,
      lifecycle: req.lifecycle,
      ...verdict,
      compliance: verdict.compliance === "ACCIDENTALLY_CHANGED" ? "ACCIDENTALLY_CHANGED" : "NOT_APPLICABLE",
    };
  }

  // ACTIVE: the checker's verdict stands as-is.
  const result = { requirementId: req.id, lifecycle: req.lifecycle, ...verdict };

  // Confidence discipline (spec "Confidence"): a LOW-confidence verdict must
  // never stand as a hard violation classification - it is downgraded to
  // NEEDS_REVIEW so it can never silently inflate a P0/P1 count.
  if (result.confidence === "LOW" && !["IMPLEMENTED", "NOT_APPLICABLE", "NEEDS_REVIEW"].includes(result.compliance)) {
    result.compliance = "NEEDS_REVIEW";
  }
  return result;
}

/** Runs every ACTIVE/FUTURE/DEPRECATED/CONFLICTED/NEEDS_REVIEW requirement's
 * compliance check against the current repository. Returns
 * { verifications, findings } - verifications is one record per requirement
 * (including clean IMPLEMENTED/NOT_APPLICABLE passes, for coverage
 * reporting); findings is the subset that represents an actual defect,
 * conflict, or open question, with severity/confidence attached for the
 * reporter/baseline/fix-planner. */
export function runCompliance(registry, repoRoot, checkers = realCheckers) {
  const verifications = registry.requirements.map((req) => {
    const result = runOneRequirement(req, repoRoot, checkers);
    return { ...result, title: req.title, priority: req.priority, scope: req.scope };
  });

  const findings = [];
  for (const v of verifications) {
    if (v.compliance === "IMPLEMENTED" || v.compliance === "NOT_APPLICABLE") continue;
    findings.push(
      makeFinding({
        requirementId: v.requirementId,
        title: v.title,
        compliance: v.compliance,
        severity: v.priority || "P2",
        confidence: v.confidence,
        affectedArea: (v.scope || [])[0] || null,
        expected: v.expected,
        observed: v.observed,
        evidence: v.evidence || [],
        recommendation: v.recommendation || null,
      })
    );
  }

  return { verifications, findings };
}
