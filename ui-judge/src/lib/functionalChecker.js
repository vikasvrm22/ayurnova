// ============================================================
// 4. FUNCTIONAL UI CHECKER
// ============================================================
// Verifies observable UI functionality from the evidence already
// collected by the Actual UI Analyzer - deliberately non-interactive
// (no clicking/submitting) so an audit run can never trigger a real
// checkout, delete, or navigation side effect. That's a scope boundary,
// not a shortcut: "functional" here means "wired up correctly", not
// "the business logic behind it is correct" (see section 13/safety).
export function checkFunctional(evidence) {
  const issues = [];

  const isWired = (b) => b.hasOnclickAttr || (b.insideForm && (b.type === "submit" || b.type === "reset"));
  const visibleButtons = evidence.buttons.filter((b) => b.visible);
  const deadButtons = visibleButtons.filter((b) => b.disabled === false && !isWired(b) && b.text);
  deadButtons.forEach((b) => issues.push({ type: "dead-button", detail: `Button "${b.text}" has no click handler and is not a submit control`, severity: "P1" }));

  const visibleLinks = evidence.links.filter((l) => l.visible);
  const brokenLinks = visibleLinks.filter((l) => !l.href || l.href.trim() === "" || l.href.trim() === "#");
  brokenLinks.forEach((l) => issues.push({ type: "empty-href", detail: `Link "${l.text || "(no text)"}" has an empty/placeholder href`, severity: "P2" }));

  evidence.forms.forEach((f, i) => {
    const unnamed = f.fields.filter((fld) => !fld.name);
    unnamed.forEach(() => issues.push({ type: "unnamed-field", detail: `Form #${i + 1} has an input with no name/id (will not submit correctly)`, severity: "P1" }));
  });

  const brokenImages = evidence.images.filter((img) => img.broken && img.visible);
  brokenImages.forEach((img) => issues.push({ type: "broken-image", detail: `Image failed to load: ${img.src || "(no src)"}`, severity: "P0" }));

  (evidence.consoleErrors || []).forEach((msg) => issues.push({ type: "console-error", detail: msg.slice(0, 200), severity: "P1" }));

  if (evidence.navError) issues.push({ type: "navigation-error", detail: evidence.navError, severity: "P0" });
  if (evidence.httpStatus && evidence.httpStatus >= 400) issues.push({ type: "http-error", detail: `Page responded with HTTP ${evidence.httpStatus}`, severity: "P0" });

  const totalChecks = visibleButtons.length + visibleLinks.length + evidence.forms.length + evidence.images.filter((i) => i.visible).length + 1; // +1 for navigation itself
  const failedWeight = issues.reduce((s, i) => s + (i.severity === "P0" ? 3 : i.severity === "P1" ? 2 : 1), 0);
  const score = totalChecks === 0 ? 100 : Math.max(0, Math.round(100 * (1 - failedWeight / (totalChecks * 2))));

  return {
    score,
    confidence: evidence.navError ? "high" : "medium", // "medium": we verify wiring, not real interaction outcomes
    issues,
    counts: { buttons: visibleButtons.length, links: visibleLinks.length, forms: evidence.forms.length, images: evidence.images.length, deadButtons: deadButtons.length, brokenLinks: brokenLinks.length, brokenImages: brokenImages.length },
  };
}
