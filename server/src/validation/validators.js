import { PRODUCT_FIELDS } from "../config.js";

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

/** A variant needs a label, a positive price, and a non-negative stock. */
export function validateVariant(variant) {
  const errors = {};
  if (isBlank(variant.label)) errors.label = "Pack/variant label is required";
  const price = Number(variant.price);
  if (!Number.isFinite(price) || price <= 0) errors.price = "Price must be a positive number";
  if (variant.mrp !== undefined && variant.mrp !== null && variant.mrp !== "") {
    const mrp = Number(variant.mrp);
    if (!Number.isFinite(mrp) || mrp < price) errors.mrp = "MRP must be a number greater than or equal to price";
  }
  const stock = Number(variant.stock);
  if (!Number.isInteger(stock) || stock < 0) errors.stock = "Stock must be a whole number 0 or greater";
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
export function validateAddress(addr) {
  const errors = {};
  if (isBlank(addr.full_name)) errors.full_name = "Name is required";
  if (!validatePhone(addr.phone || "")) errors.phone = "Enter a valid phone number";
  if (isBlank(addr.line1)) errors.line1 = "Address line is required";
  if (isBlank(addr.city)) errors.city = "City is required";
  if (isBlank(addr.state)) errors.state = "State is required";
  if (!PINCODE_RE.test(addr.pincode || "")) errors.pincode = "Enter a valid 6-digit pincode";
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
