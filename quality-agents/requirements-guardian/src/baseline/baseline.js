import fs from "fs";
import path from "path";

const BASELINE_DIR = (reportsRoot) => path.join(reportsRoot, "baseline");

export function saveBaseline(reportsRoot, summary) {
  const dir = BASELINE_DIR(reportsRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "baseline.json"), JSON.stringify(summary, null, 2), "utf8");
}

export function loadBaseline(reportsRoot) {
  const file = path.join(BASELINE_DIR(reportsRoot), "baseline.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Compares by (requirementId + compliance) identity - a requirement whose
 * compliance status changed since the baseline is either a regression
 * (ACTIVE went from IMPLEMENTED to something else, or severity escalated)
 * or a resolution (something else went to IMPLEMENTED/NOT_APPLICABLE). A
 * requirement whose verdict is unchanged - even if still non-IMPLEMENTED -
 * is a known, already-accepted baseline limitation, not a new regression
 * (spec section 19/23: "do not report an existing accepted baseline
 * limitation as a new regression unless evidence shows it changed"). */
export function compareToBaseline(baseline, currentVerifications) {
  if (!baseline) {
    return { hasBaseline: false, regressions: [], resolved: [], escalated: [], unchangedCount: currentVerifications.length };
  }

  const baselineById = new Map((baseline.verifications || []).map((v) => [v.requirementId, v]));
  const currentById = new Map(currentVerifications.map((v) => [v.requirementId, v]));

  const regressions = [];
  const resolved = [];
  const escalated = [];

  for (const [id, current] of currentById) {
    const prior = baselineById.get(id);
    if (!prior) continue; // new requirement added to the registry since baseline - not a regression, just new coverage
    const wasClean = prior.compliance === "IMPLEMENTED" || prior.compliance === "NOT_APPLICABLE";
    const isClean = current.compliance === "IMPLEMENTED" || current.compliance === "NOT_APPLICABLE";
    if (wasClean && !isClean) {
      regressions.push({ requirementId: id, from: prior.compliance, to: current.compliance });
    } else if (!wasClean && isClean) {
      resolved.push({ requirementId: id, from: prior.compliance, to: current.compliance });
    } else if (!wasClean && !isClean && severityRank(current.priority) < severityRank(prior.priority)) {
      escalated.push({ requirementId: id, fromPriority: prior.priority, toPriority: current.priority });
    }
  }

  return {
    hasBaseline: true,
    baselineDate: baseline.auditedAt,
    regressions,
    resolved,
    escalated,
    unchangedCount: currentVerifications.length - regressions.length - resolved.length - escalated.length,
  };
}

function severityRank(p) {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[p] ?? 4;
}
