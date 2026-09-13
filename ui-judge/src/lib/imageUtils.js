// Small, dependency-light image-analysis primitives shared by the Design
// Analyzer (reads the reference PNG) and the Comparator (reads the actual
// screenshot). Everything here is a *heuristic* over raw pixels - there is
// no OCR/vision model in this pipeline, so results are deliberately coarse
// and always paired with a confidence label by the caller.
import sharp from "sharp";
import pixelmatch from "pixelmatch";

/** Decodes any image input to a flat RGBA buffer + dimensions. */
export async function toRawRGBA(input, { resizeTo } = {}) {
  let pipeline = sharp(input).ensureAlpha();
  if (resizeTo) pipeline = pipeline.resize(resizeTo.width, resizeTo.height, { fit: "fill" });
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function getImageMeta(input) {
  const meta = await sharp(input).metadata();
  return { width: meta.width, height: meta.height, format: meta.format };
}

function toHex(r, g, b) {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/**
 * Dominant colors via coarse channel quantization (16 levels/channel) +
 * bucket sort. Cheap, deterministic, good enough for "is the palette in
 * the right ballpark" - not a substitute for a real design-token diff.
 */
export async function dominantColors(input, { count = 6, sampleSize = 48 } = {}) {
  const { data, width, height } = await toRawRGBA(input, { resizeTo: { width: sampleSize, height: sampleSize } });
  const buckets = new Map();
  const pixelCount = width * height;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 16) continue; // transparent - not part of the visible palette
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = [r, g, b].map((v) => Math.round(v / 16) * 16).join(",");
    const entry = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    entry.r += r; entry.g += g; entry.b += b; entry.n += 1;
    buckets.set(key, entry);
  }
  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, count);
  return sorted.map((e) => ({
    hex: toHex(e.r / e.n, e.g / e.n, e.b / e.n),
    pct: Number((e.n / pixelCount).toFixed(4)),
  }));
}

/** Parses "#rgb", "#rrggbb" or "rgb(a)(...)" (as returned by getComputedStyle) into [r,g,b], or null if unrecognized. */
export function parseColor(input) {
  if (typeof input !== "string") return null;
  const hex = input.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const rgb = input.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/**
 * Normalized (0..1) Euclidean distance between two colors, each in hex
 * ("#rrggbb") or CSS rgb()/rgba() form (as getComputedStyle returns).
 * Colors that can't be parsed (e.g. "transparent") fall back to exact
 * string equality (distance 0 or 1) rather than being silently skipped.
 */
export function colorDistance(colorA, colorB) {
  const a = parseColor(colorA), b = parseColor(colorB);
  if (!a || !b) return colorA === colorB ? 0 : 1;
  const dist = Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
  return Number((dist / 441.673).toFixed(4)); // max possible distance = sqrt(255^2*3)
}

/** Closest match distance for `hex` against a palette; 1.0 if palette is empty. */
export function closestColorDistance(hex, palette) {
  if (!palette || palette.length === 0) return 1;
  return Math.min(...palette.map((p) => colorDistance(hex, p.hex || p)));
}

/**
 * Row-wise average-luminance profile, resampled to `rows` buckets.
 * Used as a cheap proxy for "vertical layout rhythm" when no authored
 * section map exists - two pages with a similar profile likely have
 * sections in a similar order/size, even though we don't know their names.
 */
export async function rowLuminanceProfile(input, { rows = 40 } = {}) {
  const width = 32; // narrow columns are enough - we only care about vertical structure
  const { data, height } = await toRawRGBA(input, { resizeTo: { width, height: rows } });
  const profile = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    profile[y] = sum / width / 255;
  }
  return profile;
}

/** Boundaries where luminance jumps sharply - candidate section edges. */
export function segmentBands(profile, { threshold = 0.12 } = {}) {
  const bounds = [0];
  for (let i = 1; i < profile.length; i++) {
    if (Math.abs(profile[i] - profile[i - 1]) >= threshold) bounds.push(i);
  }
  bounds.push(profile.length);
  const bands = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i], end = bounds[i + 1];
    if (end === start) continue;
    const slice = profile.slice(start, end);
    bands.push({
      startPct: Number((start / profile.length).toFixed(3)),
      endPct: Number((end / profile.length).toFixed(3)),
      avgLuminance: Number((slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(3)),
    });
  }
  return bands;
}

/** Pearson correlation between two equal-length numeric arrays. */
function pearson(a, b) {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db; denA += da * da; denB += db * db;
  }
  if (denA === 0 || denB === 0) return denA === denB ? 1 : 0;
  return num / Math.sqrt(denA * denB);
}

/** Resamples `arr` to `len` buckets by simple averaging, then correlates. */
export function correlateProfiles(a, b) {
  const resample = (arr, len) => {
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
      const start = Math.floor((i / len) * arr.length);
      const end = Math.max(start + 1, Math.floor(((i + 1) / len) * arr.length));
      out[i] = arr.slice(start, end).reduce((s, v) => s + v, 0) / (end - start);
    }
    return out;
  };
  const len = Math.min(a.length, b.length, 40);
  const ra = resample(a, len), rb = resample(b, len);
  const r = pearson(ra, rb);
  return Number((Math.max(0, r) || 0).toFixed(3)); // clamp negative correlation to 0 ("no structural relationship"), not a penalty score
}

/**
 * Pixel diff between two images, resized to a shared size for comparison.
 * `ignoreRegions` are {xPct,yPct,wPct,hPct} boxes (fraction of image size)
 * blacked out on both sides before diffing - e.g. a live timestamp.
 */
export async function pixelDiff(referenceInput, actualInput, { ignoreRegions = [], maxDim = 1200 } = {}) {
  const refMeta = await getImageMeta(referenceInput);
  const width = Math.min(maxDim, refMeta.width);
  const height = Math.round(width * (refMeta.height / refMeta.width));

  const ref = await toRawRGBA(referenceInput, { resizeTo: { width, height } });
  const act = await toRawRGBA(actualInput, { resizeTo: { width, height } });

  const mask = (buf) => {
    for (const r of ignoreRegions) {
      const x0 = Math.round(r.xPct * width), y0 = Math.round(r.yPct * height);
      const x1 = Math.round((r.xPct + r.wPct) * width), y1 = Math.round((r.yPct + r.hPct) * height);
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          const i = (y * width + x) * 4;
          buf[i] = buf[i + 1] = buf[i + 2] = 0; buf[i + 3] = 255;
        }
      }
    }
  };
  mask(ref.data); mask(act.data);

  const diff = Buffer.alloc(width * height * 4);
  const diffPixels = pixelmatch(ref.data, act.data, diff, width, height, { threshold: 0.1 });
  const diffRatio = Number((diffPixels / (width * height)).toFixed(4));
  const diffPng = await sharp(diff, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { diffRatio, diffPixels, width, height, diffPng };
}
