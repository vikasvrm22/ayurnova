// ============================================================
// 1. DESIGN ANALYZER
// ============================================================
// Turns a reference image into a structured Design Specification.
//
// There are two sources for a spec, and the analyzer prefers the more
// trustworthy one:
//
//   - "authored": a hand-written (or agent-authored, e.g. a human/LLM
//     that actually looked at the mockup) JSON file at
//     specs/<page>.json with `"source": "authored"`. This is the only
//     way fields like typography, spacing and component identity reach
//     high confidence, because reading those off a flat PNG reliably
//     needs a human/vision model in the loop, not pixel math.
//   - "heuristic": generated automatically from the reference image
//     using only pixel statistics (dimensions, dominant colors, rough
//     vertical section bands via luminance segmentation). Cached to
//     specs/<page>.heuristic.json so repeat runs don't recompute it.
//
// An authored file is never overwritten by this module. Fields the
// heuristic path cannot support are explicitly marked
// `confidence: "unknown"` rather than guessed.
import fs from "node:fs";
import path from "node:path";
import { getImageMeta, dominantColors, rowLuminanceProfile, segmentBands } from "./imageUtils.js";

const UNKNOWN = { confidence: "unknown", note: "Not reliably inferable from a flat reference image without an authored spec or a vision model in the loop." };

export async function getDesignSpec(pageConfig, { specsDir }) {
  const authoredPath = path.join(specsDir, `${pageConfig.name}.json`);
  if (fs.existsSync(authoredPath)) {
    const spec = JSON.parse(fs.readFileSync(authoredPath, "utf8"));
    if (spec.source === "authored") return spec;
  }
  return buildHeuristicSpec(pageConfig, specsDir);
}

async function buildHeuristicSpec(pageConfig, specsDir) {
  const refPath = pageConfig.referenceAbsPath;
  const meta = await getImageMeta(refPath);
  const colors = await dominantColors(refPath, { count: 6 });
  const profile = await rowLuminanceProfile(refPath, { rows: 48 });
  const bands = segmentBands(profile);

  const spec = {
    page: pageConfig.name,
    source: "heuristic",
    generatedAt: new Date().toISOString(),
    reference: { path: pageConfig.reference, width: meta.width, height: meta.height, aspectRatio: Number((meta.width / meta.height).toFixed(3)) },
    sections: {
      bands: bands.map((b, i) => ({ id: `band-${i}`, ...b })),
      luminanceProfile: profile,
      confidence: "low",
      note: "Vertical bands inferred from luminance changes only - no semantic labels (header/hero/footer, etc.) are known.",
    },
    colors: { dominant: colors, confidence: "high", note: "Directly measured from reference pixels." },
    typography: { hierarchy: [], ...UNKNOWN },
    spacing: { expectations: [], ...UNKNOWN },
    components: { expected: [], ...UNKNOWN },
    assets: { images: [], ...UNKNOWN },
    borders: { ...UNKNOWN },
    responsive: { expectations: [], ...UNKNOWN },
  };

  fs.mkdirSync(specsDir, { recursive: true });
  fs.writeFileSync(path.join(specsDir, `${pageConfig.name}.heuristic.json`), JSON.stringify(spec, null, 2));
  return spec;
}

/** True when the spec carries authored, selector-level component expectations. */
export function hasAuthoredComponents(spec) {
  return spec.source === "authored" && Array.isArray(spec.components?.expected) && spec.components.expected.length > 0;
}
