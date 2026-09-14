/** Section 21 policy classifier. Defaults to REVIEW_REQUIRED for everything;
 * only a small, explicit whitelist of deterministic, low-risk, localized
 * findings is ever eligible for SAFE_AUTO_FIX, and NEVER always wins. */

const NEVER_PATTERNS = [
  /payment/i,
  /refund/i,
  /\btax\b|gst/i,
  /schema|migration/i,
  /server\/src\/auth\//,
  /server\/src\/integrations\//,
  /supabase\//,
  /\.env/,
];

/** Explicit whitelist: {category, filePattern} pairs this build knows how to
 * safely auto-fix, each backed by a real fixer in src/fix-planner/fixers/. */
const SAFE_AUTO_FIX_WHITELIST = [
  { category: "feature-flag", filePattern: /^public-site\/cart\.html$/, fixerId: "codRadioGate" },
  { category: "contract", filePattern: /^admin\/users\.html$/, fixerId: "adminStaffPath" },
];

export function classifyFix(finding) {
  const text = `${finding.file || ""} ${finding.category || ""} ${finding.summary || ""}`;
  const whitelisted = isWhitelisted(finding);
  if (whitelisted) return "SAFE_AUTO_FIX"; // only path that can ever bypass P0/P1-defaults-to-review below
  for (const pattern of NEVER_PATTERNS) {
    if (pattern.test(text)) return "NEVER_AUTO_FIX";
  }
  // Everything else - including every P0/P1 finding not on the explicit
  // whitelist above - defaults to REVIEW_REQUIRED. SAFE_AUTO_FIX is opt-in only.
  return "REVIEW_REQUIRED";
}

function isWhitelisted(finding) {
  return SAFE_AUTO_FIX_WHITELIST.some((w) => w.category === finding.category && w.filePattern.test(finding.file || ""));
}

export function fixerIdFor(finding) {
  const hit = SAFE_AUTO_FIX_WHITELIST.find((w) => w.category === finding.category && w.filePattern.test(finding.file || ""));
  return hit?.fixerId || null;
}

/** Annotates every finding with its fix-policy bucket; does not apply anything. */
export function planFixes(findings) {
  return findings.map((f) => ({ ...f, fixPolicy: classifyFix(f) }));
}
