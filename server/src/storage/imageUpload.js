import { v4 as uuid } from "uuid";
import sharp from "sharp";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { config } from "../config.js";
import { ALLOWED_IMAGE_TYPES } from "../validation/validators.js";
import { AppError } from "../utils/apiResponse.js";

const MAX_WIDTH = 1600; // no product photo needs to be wider than this on screen
const DEFAULT_TARGET_KB = 200;
const MIN_QUALITY = 40; // don't degrade quality below this even if still over target

/** Compresses an image buffer to WebP, resizing if wider than MAX_WIDTH and
 * stepping quality down until it's under the target size (or MIN_QUALITY is
 * hit, whichever comes first - a very busy/detailed photo may not compress
 * to the target without looking bad, so this stops rather than ruining it). */
async function compressToWebp(buffer, targetBytes) {
  let pipeline = sharp(buffer).rotate(); // .rotate() auto-orients using EXIF, then strips it
  const metadata = await sharp(buffer).metadata();
  if (metadata.width && metadata.width > MAX_WIDTH) {
    pipeline = pipeline.resize({ width: MAX_WIDTH });
  }

  let quality = 80;
  let output = await pipeline.webp({ quality }).toBuffer();
  while (output.length > targetBytes && quality > MIN_QUALITY) {
    quality -= 10;
    output = await sharp(buffer).rotate()
      .resize(metadata.width > MAX_WIDTH ? { width: MAX_WIDTH } : undefined)
      .webp({ quality })
      .toBuffer();
  }
  return output;
}

/** Uploads one image buffer (from multer's memoryStorage) to the configured
 * Supabase Storage bucket. The image is ALWAYS compressed to WebP and
 * resized/quality-reduced to fit the target size (Admin -> Settings ->
 * Uploads) before it's stored - this is what actually keeps Storage usage
 * and page-load bandwidth down, not just rejecting large uploads. */
export async function uploadProductImage(file, productId) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    throw new AppError(`Unsupported image type: ${file.mimetype}. Use JPEG, PNG or WEBP.`, 400, "UNSUPPORTED_IMAGE_TYPE");
  }

  const { data: setting } = await supabaseAdmin().from("settings").select("value").eq("key", "uploads").maybeSingle();
  const maxInputMb = setting?.value?.max_image_mb || 5; // guard against absurd uploads before we even try to compress
  const targetKb = setting?.value?.target_kb || DEFAULT_TARGET_KB;
  if (file.size > maxInputMb * 1024 * 1024) {
    throw new AppError(`Image too large (max ${maxInputMb}MB before compression - configurable in Admin -> Settings).`, 400, "IMAGE_TOO_LARGE");
  }

  let compressed;
  try {
    compressed = await compressToWebp(file.buffer, targetKb * 1024);
  } catch (e) {
    // e.message here is from `sharp` (e.g. "unsupported image format") - safe
    // to show, it describes the uploaded file, not our internals.
    throw new AppError(`Could not process this image: ${e.message}`, 400, "IMAGE_PROCESSING_FAILED");
  }

  const path = `${productId}/${uuid()}.webp`;
  const { error } = await supabaseAdmin()
    .storage.from(config.supabase.storageBucket)
    .upload(path, compressed, { contentType: "image/webp", upsert: false });
  if (error) {
    // error.message here is a raw Supabase Storage error - log the detail
    // server-side only, don't relay it to the client (Phase 0 §7.2).
    console.error("Supabase Storage upload failed:", error);
    throw new Error("Image upload failed. Please try again.");
  }

  const { data } = supabaseAdmin().storage.from(config.supabase.storageBucket).getPublicUrl(path);
  return { url: data.publicUrl, sizeBytes: compressed.length };
}

export async function deleteProductImage(path) {
  await supabaseAdmin().storage.from(config.supabase.storageBucket).remove([path]);
}

/** Same compress-to-WebP pipeline as uploadProductImage, generalized for
 * the admin Banners & Media library (Phase UI-1) - stored under `media/`
 * instead of a product id, and returns the final pixel dimensions since
 * the media library displays them (a product image card never needed to). */
export async function uploadMediaAsset(file) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    throw new AppError(`Unsupported image type: ${file.mimetype}. Use JPEG, PNG or WEBP.`, 400, "UNSUPPORTED_IMAGE_TYPE");
  }

  const { data: setting } = await supabaseAdmin().from("settings").select("value").eq("key", "uploads").maybeSingle();
  const maxInputMb = setting?.value?.max_image_mb || 5;
  const targetKb = setting?.value?.target_kb || DEFAULT_TARGET_KB;
  if (file.size > maxInputMb * 1024 * 1024) {
    throw new AppError(`Image too large (max ${maxInputMb}MB before compression - configurable in Admin -> Settings).`, 400, "IMAGE_TOO_LARGE");
  }

  let compressed;
  try {
    compressed = await compressToWebp(file.buffer, targetKb * 1024);
  } catch (e) {
    throw new AppError(`Could not process this image: ${e.message}`, 400, "IMAGE_PROCESSING_FAILED");
  }
  const { width, height } = await sharp(compressed).metadata();

  const path = `media/${uuid()}.webp`;
  const { error } = await supabaseAdmin()
    .storage.from(config.supabase.storageBucket)
    .upload(path, compressed, { contentType: "image/webp", upsert: false });
  if (error) {
    console.error("Supabase Storage upload failed:", error);
    throw new Error("Image upload failed. Please try again.");
  }

  const { data } = supabaseAdmin().storage.from(config.supabase.storageBucket).getPublicUrl(path);
  return { url: data.publicUrl, path, width, height, sizeBytes: compressed.length, format: "webp" };
}

export async function deleteMediaAsset(path) {
  await supabaseAdmin().storage.from(config.supabase.storageBucket).remove([path]);
}
