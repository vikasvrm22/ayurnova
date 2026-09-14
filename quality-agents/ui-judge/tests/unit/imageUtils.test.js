import sharp from "sharp";
import { colorDistance, parseColor, dominantColors, pixelDiff, correlateProfiles, segmentBands } from "../../src/lib/imageUtils.js";
import { assert } from "../helpers.js";

async function solid(width, height, rgb) {
  return sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
}

export default async function run() {
  assert(colorDistance("#000000", "#000000") === 0, "identical hex colors must have zero distance");
  assert(colorDistance("#000000", "#ffffff") === 1, "black vs white must be maximum distance (1)");
  assert(Math.abs(colorDistance("rgb(47, 125, 79)", "#2f7d4f") - 0) < 0.01, "colorDistance must treat equivalent rgb()/hex forms as (near) identical");
  assert(parseColor("rgba(10, 20, 30, 0.5)")?.join(",") === "10,20,30", "parseColor must handle rgba()");
  assert(parseColor("transparent") === null, "parseColor must return null for unparseable keywords, not throw");

  const red = await solid(40, 40, [220, 20, 60]);
  const colors = await dominantColors(red, { count: 3 });
  assert(colors.length >= 1, "dominantColors must find at least one bucket on a solid image");
  assert(colorDistance(colors[0].hex, "#dc143c") < 0.1, `dominant color of a solid crimson square should be close to crimson, got ${colors[0].hex}`);

  const a = await solid(50, 50, [255, 255, 255]);
  const bIdentical = await solid(50, 50, [255, 255, 255]);
  const bDifferent = await solid(50, 50, [0, 0, 0]);
  const diffSame = await pixelDiff(a, bIdentical);
  const diffOpposite = await pixelDiff(a, bDifferent);
  assert(diffSame.diffRatio === 0, `identical images must diff to 0, got ${diffSame.diffRatio}`);
  assert(diffOpposite.diffRatio > 0.9, `black vs white must diff close to 1, got ${diffOpposite.diffRatio}`);

  assert(correlateProfiles([1, 1, 1, 1], [1, 1, 1, 1]) === 1, "identical profiles must correlate to 1");
  assert(correlateProfiles([1, 1, 1, 1], [1, 1, 1, 1]) >= correlateProfiles([0, 1, 0, 1], [1, 0, 1, 0]), "correlation should be higher for matching profiles than for inverted ones");

  const bands = segmentBands([0, 0, 0, 1, 1, 1], { threshold: 0.5 });
  assert(bands.length === 2, `expected a single sharp jump to produce 2 bands, got ${bands.length}`);

  return { name: "imageUtils" };
}
