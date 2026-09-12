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
