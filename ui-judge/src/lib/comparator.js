// ============================================================
// 3. COMPARISON ENGINE
// ============================================================
// Merges the Design Specification (reference) with the collected browser
// Evidence (actual) into per-category comparison results. Two evidence
// tiers exist per category:
//   - categories that need an AUTHORED spec (components/typography/
//     spacing) degrade to evidenceLevel "none" when the spec is only
//     heuristic - scoring.js then excludes them rather than guessing.
//   - categories computable straight from pixels/DOM regardless of spec
//     authoring (layout via band-correlation + visual diff, colors,
//     assets, responsive, functional) always produce a real number.
import { dominantColors, colorDistance, closestColorDistance, rowLuminanceProfile, segmentBands, correlateProfiles, pixelDiff } from "./imageUtils.js";

/** Every CSS selector the spec references - the orchestrator feeds this to the browser analyzer so evidence.selectorMatches is populated before comparison. */
export function collectSpecSelectors(spec) {
  const sels = new Set();
  (spec.components?.expected || []).forEach((c) => c.selector && sels.add(c.selector));
  (spec.typography?.hierarchy || []).forEach((t) => t.selector && sels.add(t.selector));
  (spec.spacing?.expectations || []).forEach((s) => { if (s.selectorA) sels.add(s.selectorA); if (s.selectorB) sels.add(s.selectorB); });
  (spec.sections?.expectedOrder || []).forEach((sel) => sels.add(sel));
  return [...sels];
}

function px(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }

async function compareLayout(spec, evidence, referenceAbsPath) {
  const findings = [];
  // Structural signal: does the actual DOM's heading/landmark order match an authored expected order?
  let orderScore = null, orderConfidence = "none";
  if (Array.isArray(spec.sections?.expectedOrder) && spec.sections.expectedOrder.length) {
    const expected = spec.sections.expectedOrder;
    const actualHit = expected.filter((sel) => evidence.selectorMatches?.[sel]?.found);
    orderScore = expected.length ? actualHit.length / expected.length : null;
    orderConfidence = "high";
    if (orderScore !== null && orderScore < 1) {
      const missing = expected.filter((sel) => !evidence.selectorMatches?.[sel]?.found);
      missing.forEach((sel) => findings.push({ category: "layout", kind: "missing-section", refExpectation: sel, actual: "not found in DOM", deviation: 1 }));
    }
  }
  // Visual/structural-proxy signal: vertical luminance-band correlation - always computable.
  let bandCorrelation = null;
  try {
    const actualProfile = await rowLuminanceProfile(evidence.screenshotPng, { rows: 48 });
    const refProfile = spec.sections?.luminanceProfile?.length ? spec.sections.luminanceProfile : await rowLuminanceProfile(referenceAbsPath, { rows: 48 });
    bandCorrelation = correlateProfiles(refProfile, actualProfile);
    if (bandCorrelation < 0.5) findings.push({ category: "layout", kind: "band-mismatch", refExpectation: "reference vertical rhythm", actual: `correlation ${bandCorrelation}`, deviation: 1 - bandCorrelation });
  } catch { /* best-effort only */ }

  const signals = [orderScore, bandCorrelation].filter((v) => v !== null);
  const score = signals.length ? Math.round(100 * (signals.reduce((a, b) => a + b, 0) / signals.length)) : null;
  const evidenceLevel = orderConfidence === "high" ? "high" : (bandCorrelation !== null ? "medium" : "none");
  return { score, evidenceLevel, orderScore, bandCorrelation, findings };
}

function compareComponents(spec, evidence) {
  const expected = spec.components?.expected || [];
  if (!expected.length) return { score: null, evidenceLevel: "none", findings: [], missing: [], matched: [] };

  const findings = [], missing = [], matched = [];
  for (const comp of expected) {
    const found = evidence.selectorMatches?.[comp.selector];
    if (!found || !found.found) {
      missing.push(comp.selector);
      findings.push({ category: "components", kind: "missing-element", refExpectation: `${comp.name || comp.selector} present`, actual: "not found", deviation: 1, critical: !!comp.critical, selector: comp.selector });
      continue;
    }
    matched.push(comp.selector);
    if (comp.expectedText && !found.text.toLowerCase().includes(String(comp.expectedText).toLowerCase())) {
      findings.push({ category: "components", kind: "text-mismatch", refExpectation: comp.expectedText, actual: found.text, deviation: 0.5, critical: !!comp.critical, selector: comp.selector });
    }
    for (const [prop, expectedVal] of Object.entries(comp.expectedStyle || {})) {
      const actualVal = found.style?.[prop];
      if (actualVal == null) continue;
      let deviation = 0;
      if (prop === "backgroundColor" || prop === "color") deviation = colorDistance(expectedVal, actualVal);
      else if (prop === "fontSize") { const d = Math.abs((px(expectedVal) || 0) - (px(actualVal) || 0)); deviation = Math.min(1, d / 20); }
      else deviation = actualVal === expectedVal ? 0 : 0.3;
      if (deviation > 0.08) findings.push({ category: "components", kind: `style-mismatch:${prop}`, refExpectation: `${prop}: ${expectedVal}`, actual: `${prop}: ${actualVal}`, deviation, critical: !!comp.critical, selector: comp.selector });
    }
  }
  const score = Math.round(100 * (matched.length - findings.filter((f) => f.kind !== "missing-element").length * 0.15) / expected.length);
  return { score: Math.max(0, score), evidenceLevel: "high", findings, missing, matched };
}

function compareTypography(spec, evidence) {
  const hierarchy = spec.typography?.hierarchy || [];
  if (!hierarchy.length) return { score: null, evidenceLevel: "none", findings: [] };
  const findings = [];
  for (const t of hierarchy) {
    const found = evidence.selectorMatches?.[t.selector];
    if (!found?.found) { findings.push({ category: "typography", kind: "missing-element", refExpectation: t.selector, actual: "not found", deviation: 1 }); continue; }
    if (t.expectedFontSizePx) {
      const actualPx = px(found.style.fontSize);
      const delta = actualPx == null ? null : Math.abs(actualPx - t.expectedFontSizePx);
      if (delta !== null && delta > 1) findings.push({ category: "typography", kind: "font-size", refExpectation: `${t.expectedFontSizePx}px`, actual: found.style.fontSize, deviation: Math.min(1, delta / 20), selector: t.selector, deltaPx: delta });
    }
    if (t.expectedFontWeight && String(found.style.fontWeight) !== String(t.expectedFontWeight)) {
      findings.push({ category: "typography", kind: "font-weight", refExpectation: t.expectedFontWeight, actual: found.style.fontWeight, deviation: 0.3, selector: t.selector });
    }
    if (t.expectedFontFamily && !found.style.fontFamily.toLowerCase().includes(String(t.expectedFontFamily).toLowerCase())) {
      findings.push({ category: "typography", kind: "font-family", refExpectation: t.expectedFontFamily, actual: found.style.fontFamily, deviation: 0.4, selector: t.selector });
    }
  }
  const score = Math.max(0, Math.round(100 * (1 - findings.reduce((s, f) => s + f.deviation, 0) / Math.max(1, hierarchy.length))));
  return { score, evidenceLevel: "high", findings };
}

function compareSpacing(spec, evidence) {
  const expectations = spec.spacing?.expectations || [];
  if (!expectations.length) return { score: null, evidenceLevel: "none", findings: [] };
  const findings = [];
  for (const s of expectations) {
    const a = evidence.selectorMatches?.[s.selectorA], b = evidence.selectorMatches?.[s.selectorB];
    if (!a?.found || !b?.found) { findings.push({ category: "spacing", kind: "missing-element", refExpectation: `${s.selectorA} / ${s.selectorB}`, actual: "one or both not found", deviation: 1 }); continue; }
    const actualGap = s.axis === "horizontal" ? Math.abs(b.bbox.x - (a.bbox.x + a.bbox.w)) : Math.abs(b.bbox.y - (a.bbox.y + a.bbox.h));
    const delta = Math.abs(actualGap - s.expectedGapPx);
    const tolerance = s.tolerancePx ?? 4;
    if (delta > tolerance) findings.push({ category: "spacing", kind: "gap-mismatch", refExpectation: `${s.expectedGapPx}px`, actual: `${actualGap}px`, deviation: Math.min(1, delta / 64), deltaPx: delta, selector: `${s.selectorA}->${s.selectorB}` });
  }
  const score = Math.max(0, Math.round(100 * (1 - findings.reduce((sum, f) => sum + f.deviation, 0) / Math.max(1, expectations.length))));
  return { score, evidenceLevel: "high", findings };
}

async function compareAssets(spec, evidence) {
  const findings = [];
  const visibleImages = evidence.images.filter((i) => i.visible);
  const broken = visibleImages.filter((i) => i.broken);
  broken.forEach((i) => findings.push({ category: "assets", kind: "broken-image", refExpectation: "image loads", actual: i.src || "(no src)", deviation: 1 }));
  const missingAlt = visibleImages.filter((i) => !i.alt);
  missingAlt.forEach((i) => findings.push({ category: "assets", kind: "missing-alt", refExpectation: "alt text present", actual: i.src || "(no src)", deviation: 0.2 }));

  let countDeviation = 0, evidenceLevel = "medium";
  if (Array.isArray(spec.assets?.images) && spec.assets.images.length) {
    evidenceLevel = "high";
    const delta = Math.abs(spec.assets.images.length - visibleImages.length);
    countDeviation = Math.min(1, delta / Math.max(1, spec.assets.images.length));
    if (delta > 0) findings.push({ category: "assets", kind: "image-count", refExpectation: `${spec.assets.images.length} images`, actual: `${visibleImages.length} images`, deviation: countDeviation });
  }
  const penalty = (broken.length * 0.4 + missingAlt.length * 0.05 + countDeviation) / Math.max(1, visibleImages.length || 1);
  const score = Math.max(0, Math.round(100 * (1 - Math.min(1, penalty))));
  return { score, evidenceLevel, findings, brokenCount: broken.length, missingAltCount: missingAlt.length };
}

async function compareColors(spec, evidence) {
  const refColors = spec.colors?.dominant || [];
  if (!refColors.length) return { score: null, evidenceLevel: "none", findings: [] };
  const actualColors = await dominantColors(evidence.screenshotPng, { count: 6 });
  const findings = [];
  const top = refColors.slice(0, 4);
  const distances = top.map((c) => closestColorDistance(c.hex, actualColors));
  distances.forEach((d, i) => { if (d > 0.18) findings.push({ category: "colors", kind: "palette-mismatch", refExpectation: top[i].hex, actual: `closest match ${actualColors[0]?.hex || "n/a"}`, deviation: d }); });
  const avgDistance = distances.reduce((a, b) => a + b, 0) / distances.length;
  const score = Math.max(0, Math.round(100 * (1 - avgDistance)));
  return { score, evidenceLevel: "medium", findings, actualColors, avgDistance };
}

function compareResponsive(spec, evidenceByViewport) {
  const findings = [];
  const viewportNames = Object.keys(evidenceByViewport);
  let totalOverflow = 0;
  for (const name of viewportNames) {
    const ev = evidenceByViewport[name];
    (ev.overflow || []).forEach((o) => {
      totalOverflow++;
      findings.push({ category: "responsive", kind: "overflow", refExpectation: "no horizontal overflow", actual: `${o.selector} overflows by ${o.deltaPx}px at ${name}`, deviation: Math.min(1, o.deltaPx / 100), deltaPx: o.deltaPx, viewport: name });
    });
  }
  const score = Math.max(0, 100 - totalOverflow * 20);
  return { score, evidenceLevel: viewportNames.length > 1 ? "high" : "medium", findings };
}

/**
 * Runs every comparison. `evidenceByViewport` maps viewport name ("primary",
 * "mobile", ...) to a browserAnalyzer evidence object; `functionalResult`
 * is the functionalChecker output for the primary viewport.
 */
export async function compare({ spec, evidenceByViewport, functionalResult, referenceAbsPath, ignoreRegions = [] }) {
  const primary = evidenceByViewport.primary;

  const [layout, colors, assets, visual] = await Promise.all([
    compareLayout(spec, primary, referenceAbsPath),
    compareColors(spec, primary),
    compareAssets(spec, primary),
    pixelDiff(referenceAbsPath, primary.screenshotPng, { ignoreRegions }).catch(() => null),
  ]);

  // Visual similarity folds into layout: both are "computable without an authored spec".
  if (visual) {
    const visualScore = Math.round(100 * (1 - Math.min(1, visual.diffRatio / 0.5)));
    layout.visualDiffRatio = visual.diffRatio;
    layout.score = layout.score === null ? visualScore : Math.round((layout.score + visualScore) / 2);
    layout.evidenceLevel = layout.evidenceLevel === "none" ? "medium" : layout.evidenceLevel;
  }

  const components = compareComponents(spec, primary);
  const typography = compareTypography(spec, primary);
  const spacing = compareSpacing(spec, primary);
  const responsive = compareResponsive(spec, evidenceByViewport);

  const functional = {
    score: functionalResult.score,
    evidenceLevel: functionalResult.confidence === "high" ? "high" : "medium",
    findings: functionalResult.issues.map((i) => ({ category: "functional", kind: i.type, refExpectation: "control is wired up correctly", actual: i.detail, deviation: i.severity === "P0" ? 1 : i.severity === "P1" ? 0.6 : 0.3, presetSeverity: i.severity })),
  };

  return { layout, components, typography, spacing, assets, colors, responsive, functional, visual };
}
