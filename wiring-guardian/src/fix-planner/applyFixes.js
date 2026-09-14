import fs from "fs";
import path from "path";
import { fixerIdFor } from "./planFixes.js";
import { applyCodRadioGate } from "./fixers/codRadioGate.js";
import { applyAdminStaffPath } from "./fixers/adminStaffPath.js";

const FIXERS = {
  codRadioGate: { file: "public-site/cart.html", transform: applyCodRadioGate },
  adminStaffPath: { file: "admin/users.html", transform: applyAdminStaffPath },
};

/** Applies every SAFE_AUTO_FIX-classified finding whose fixer is in the
 * registry above. Each fix is minimal, localized to one file, and the
 * finding is only marked autoFixed=true if the file actually changed. Never
 * touches anything outside the FIXERS whitelist, regardless of policy
 * classification - an unmapped "SAFE_AUTO_FIX" finding is left untouched
 * and reported as such.
 *
 * Multiple findings can share one fixerId+file (e.g. four separate "wrong
 * path" findings all fixed by one edit to admin/users.html) - the fixer
 * runs once per (fixerId, file) pair, and every finding in that group is
 * marked from the single outcome, so a finding is never reported as
 * "produced no change" just because an earlier finding in the same group
 * already applied the shared edit. */
export function applySafeFixes(findings, repoRoot, { dryRun = false } = {}) {
  const applied = [];
  const groups = new Map(); // "fixerId|file" -> finding[]

  for (const finding of findings) {
    if (finding.fixPolicy !== "SAFE_AUTO_FIX") continue;
    const fixerId = fixerIdFor(finding);
    const fixer = fixerId && FIXERS[fixerId];
    if (!fixer) {
      finding.verification = "SAFE_AUTO_FIX classified but no registered fixer - left unchanged.";
      continue;
    }
    const key = `${fixerId}|${fixer.file}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }

  for (const [key, groupFindings] of groups) {
    const [fixerId] = key.split("|");
    const fixer = FIXERS[fixerId];
    const filePath = path.join(repoRoot, fixer.file);
    const before = fs.readFileSync(filePath, "utf8");
    let after;
    try {
      after = fixer.transform(before);
    } catch (e) {
      for (const f of groupFindings) f.verification = `Fixer '${fixerId}' declined to apply: ${e.message}`;
      continue;
    }
    if (after === before) {
      for (const f of groupFindings) f.verification = `Fixer '${fixerId}' ran but produced no change (already fixed?).`;
      continue;
    }
    if (!dryRun) fs.writeFileSync(filePath, after, "utf8");
    for (const f of groupFindings) {
      f.autoFixed = true;
      f.verification = dryRun ? "DRY_RUN: fix computed but not written." : "APPLIED - pending re-audit confirmation.";
    }
    applied.push({ findingIds: groupFindings.map((f) => f.id), fixerId, file: fixer.file });
  }
  return applied;
}
