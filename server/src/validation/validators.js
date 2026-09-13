import { PRODUCT_FIELDS } from "../config.js";
import { isValidGstStateCode } from "../utils/gstStateCodes.js";

export function sanitizeText(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

export function validateProductPayload(body) {
  const errors = {};
  for (const f of PRODUCT_FIELDS.filter((f) => !f.system)) {
    const val = body[f.key];
    if (f.required && isBlank(val)) {
      errors[f.key] = `${f.label} is required`;
      continue;
    }
    if (isBlank(val)) continue;
    if ((f.type === "text" || f.type === "textarea") && f.maxLength && String(val).length > f.maxLength) {
      errors[f.key] = `${f.label} must be ${f.maxLength} characters or fewer`;
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** A variant needs a label and a positive price. `stock` is deliberately
 * NOT validated/accepted here as of Phase 5A - it is now a maintained
 * aggregate of sellable batch quantity (see supabase/migrations/
 * 0006_phase5a_inventory_foundation.sql + routes/inventoryAdmin.js), not a
 * manually-typed number, so products.js no longer reads variant.stock from
 * the request body at all. */
export function validateVariant(variant) {
  const errors = {};
  if (isBlank(variant.label)) errors.label = "Pack/variant label is required";
  const price = Number(variant.price);
  if (!Number.isFinite(price) || price <= 0) errors.price = "Price must be a positive number";
  if (variant.mrp !== undefined && variant.mrp !== null && variant.mrp !== "") {
    const mrp = Number(variant.mrp);
    if (!Number.isFinite(mrp) || mrp < price) errors.mrp = "MRP must be a number greater than or equal to price";
  }
  // Phase 8A: HSN/tax rate are optional (nullable) - the business is not
  // GST-registered yet, so most variants legitimately have neither set
  // yet. Only validate the SHAPE of whatever is actually provided, never
  // require it.
  if (variant.tax_rate_percent !== undefined && variant.tax_rate_percent !== null && variant.tax_rate_percent !== "") {
    const rate = Number(variant.tax_rate_percent);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) errors.tax_rate_percent = "GST rate must be a number between 0 and 100";
  }
  if (variant.hsn_code !== undefined && variant.hsn_code !== null && String(variant.hsn_code).length > 20) {
    errors.hsn_code = "HSN/SAC code must be 20 characters or fewer";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** A new batch needs a non-blank batch_number and a non-negative integer
 * starting quantity; quality_status/batch_status are optional (the DB
 * defaults to 'pending'/'active' if omitted) but must be one of the
 * allowed values when provided. Mirrors validateVariant's shape/style. */
const QUALITY_STATUSES = ["pending", "passed", "failed"];
const BATCH_STATUSES = ["active", "quarantined", "expired", "recalled"];
export function validateBatch(batch) {
  const errors = {};
  if (isBlank(batch.variant_id) || !isValidUUID(batch.variant_id)) errors.variant_id = "A valid variant_id is required";
  if (isBlank(batch.batch_number)) errors.batch_number = "Batch number is required";
  const quantity = Number(batch.quantity);
  if (!Number.isInteger(quantity) || quantity < 0) errors.quantity = "Quantity must be a whole number 0 or greater";
  if (!isBlank(batch.quality_status) && !QUALITY_STATUSES.includes(batch.quality_status)) errors.quality_status = `quality_status must be one of: ${QUALITY_STATUSES.join(", ")}`;
  if (!isBlank(batch.batch_status) && !BATCH_STATUSES.includes(batch.batch_status)) errors.batch_status = `batch_status must be one of: ${BATCH_STATUSES.join(", ")}`;
  if (!isBlank(batch.mfg_date) && !isBlank(batch.expiry_date) && String(batch.expiry_date) < String(batch.mfg_date)) errors.expiry_date = "Expiry date cannot be before manufacturing date";
  return { valid: Object.keys(errors).length === 0, errors };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validateEmail(email) {
  return typeof email === "string" && EMAIL_RE.test(email.trim());
}

export function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 10) return false;
  return /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}

const PHONE_RE = /^\+?[1-9]\d{7,14}$/;
export function validatePhone(phone) {
  return typeof phone === "string" && PHONE_RE.test(phone.replace(/[\s-]/g, ""));
}

const PINCODE_RE = /^\d{6}$/;
// GSTIN: 2-digit state code + 10-char PAN + 1 entity code + 'Z' (fixed by
// the GSTIN spec) + 1 checksum char. Format-only validation - this never
// calls out to GSTN to confirm the GSTIN is real/active, same "validate
// shape, don't invent a live lookup" boundary as everything else here.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][Z][0-9A-Z]$/;
export function validateGSTIN(gstin) {
  return typeof gstin === "string" && GSTIN_RE.test(gstin.trim().toUpperCase());
}

/** Address validation, extended (Phase 8A) with two OPTIONAL fields:
 * `state_code` (the structured GST state/UT code - see gstStateCodes.js;
 * only validated when actually provided, so every existing address row
 * and API caller that never sends it stays exactly as valid as before)
 * and `gstin` (for a business/B2B buyer's saved address). Neither is
 * required - the free-text `state` field's own existing validation is
 * completely unchanged. */
export function validateAddress(addr) {
  const errors = {};
  if (isBlank(addr.full_name)) errors.full_name = "Name is required";
  if (!validatePhone(addr.phone || "")) errors.phone = "Enter a valid phone number";
  if (isBlank(addr.line1)) errors.line1 = "Address line is required";
  if (isBlank(addr.city)) errors.city = "City is required";
  if (isBlank(addr.state)) errors.state = "State is required";
  if (!PINCODE_RE.test(addr.pincode || "")) errors.pincode = "Enter a valid 6-digit pincode";
  if (!isBlank(addr.state_code) && !isValidGstStateCode(addr.state_code)) errors.state_code = "Select a valid state/UT";
  if (!isBlank(addr.gstin) && !validateGSTIN(addr.gstin)) errors.gstin = "Enter a valid 15-character GSTIN";
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Validates the admin-configured `tax_profile` settings value (Phase
 * 8A). GSTIN is only REQUIRED when gst_registered is on - the locked
 * business rule is that this store is not GST-registered yet, so the
 * default/blank state must always pass validation cleanly. */
export function validateTaxProfile(profile) {
  const errors = {};
  const p = profile || {};
  if (p.gst_registered) {
    if (!validateGSTIN(p.gstin || "")) errors.gstin = "A valid 15-character GSTIN is required while GST-registered is on";
    if (isBlank(p.legal_business_name)) errors.legal_business_name = "Legal business name is required while GST-registered is on";
  } else if (!isBlank(p.gstin) && !validateGSTIN(p.gstin)) {
    errors.gstin = "GSTIN format is invalid";
  }
  if (p.pricing_mode && !["inclusive", "exclusive"].includes(p.pricing_mode)) {
    errors.pricing_mode = "pricing_mode must be 'inclusive' or 'exclusive'";
  }
  const regState = p.registered_address?.state_code;
  if (!isBlank(regState) && !isValidGstStateCode(regState)) errors.registered_address = "Registered address has an invalid state code";
  if (p.invoice_number_padding !== undefined) {
    const padding = Number(p.invoice_number_padding);
    if (!Number.isInteger(padding) || padding < 1 || padding > 12) errors.invoice_number_padding = "Invoice number padding must be a whole number between 1 and 12";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function validateCouponCode(code) {
  return typeof code === "string" && /^[A-Z0-9]{3,20}$/i.test(code.trim());
}

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Shared pagination / sort / search-term guards - Phase 1.
// Every list endpoint (admin and public) should run query params through
// these instead of trusting `page`/`pageSize`/`sort`/`q` directly, so a
// client can never request an unbounded page size or pass an arbitrary
// string straight into a PostgREST `.order()`/`.or()` filter expression.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PAGE_SIZE = 100;

/** Clamps page/pageSize to safe positive integers. Never trust client input
 * for these directly - an unclamped pageSize is an easy unbounded-response-size
 * (and unbounded DB read) vector. */
export function parsePagination(query = {}, { defaultPageSize = 20, maxPageSize = DEFAULT_MAX_PAGE_SIZE } = {}) {
  let page = Math.trunc(Number(query.page));
  if (!Number.isFinite(page) || page < 1) page = 1;

  let pageSize = Math.trunc(Number(query.pageSize));
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = defaultPageSize;
  if (pageSize > maxPageSize) pageSize = maxPageSize;

  return { page, pageSize };
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isValidSlug(s) {
  return typeof s === "string" && s.length > 0 && s.length <= 120 && SLUG_RE.test(s);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidUUID(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

/** Resolves a client-supplied sort key against a fixed whitelist map, e.g.
 * { newest: { field: "created_at", ascending: false }, ... }. Never pass a
 * client-supplied string directly as a PostgREST order column - only values
 * present as keys in `map` can ever reach the database. Falls back to
 * `fallbackKey` (which must exist in `map`) for anything unrecognised. */
export function resolveSort(value, map, fallbackKey) {
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(map, value)) {
    return map[value];
  }
  return map[fallbackKey];
}

/** A search term safe to pass as a normal parameter to `.ilike()` (the
 * Supabase client always encodes parameter VALUES safely - this is not
 * about injection, only about ILIKE semantics). Trims, caps length, and
 * escapes the two ILIKE wildcard metacharacters so a search for "50% off"
 * or "a_b" matches literally instead of being treated as a wildcard. */
export function sanitizeSearchTerm(q, maxLen = 100) {
  if (typeof q !== "string") return "";
  return q.trim().slice(0, maxLen).replace(/[%_]/g, (c) => "\\" + c);
}

/** A value safe to embed inside a PostgREST `.or("col.ilike.%x%,...")`
 * filter-expression STRING (as opposed to passing it as a normal parameter
 * to `.ilike()`/`.eq()`, which is always safe because the client library
 * encodes it). `.or()` parses its argument as a mini filter grammar, so this
 * uses an ALLOWLIST (only characters that can legitimately appear in an
 * order number, email, or phone number survive) rather than a blocklist -
 * anything with special meaning to that grammar (`,` separates conditions,
 * `.` separates column/operator/value, `()` group conditions, `%`/`*` are
 * wildcards) is dropped by construction, not by trying to enumerate it. */
export function sanitizeOrFilterValue(q, maxLen = 100) {
  if (typeof q !== "string") return "";
  return q.trim().slice(0, maxLen).replace(/[^A-Za-z0-9@+\- ]/g, "");
}
