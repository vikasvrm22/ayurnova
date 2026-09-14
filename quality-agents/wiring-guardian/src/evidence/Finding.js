let counter = 0;

/** One evidence-driven finding. Every field the spec requires (section 25):
 * workflow/module, affected file(s), route, observed vs expected, evidence,
 * severity, confidence, recommended fix, auto-fix status, verification. */
export function makeFinding({
  layer,
  module = null,
  workflow = null,
  file,
  line = null,
  route = null,
  observed,
  expected,
  evidence,
  severity,
  confidence = "high",
  recommendedFix = null,
  category,
}) {
  counter += 1;
  return {
    id: `WG-${String(counter).padStart(4, "0")}`,
    layer,
    module,
    workflow,
    file,
    line,
    route,
    observed,
    expected,
    evidence,
    severity, // P0 | P1 | P2 | P3
    confidence, // high | medium | low
    category, // e.g. "rbac", "contract", "state", "feature-flag", "notification"
    recommendedFix,
    autoFixed: false,
    verification: "NOT_EXECUTED",
  };
}

export function resetFindingCounter() {
  counter = 0;
}
