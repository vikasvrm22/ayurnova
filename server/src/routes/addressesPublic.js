/**
 * Phase 6A - customer address book. The `addresses` table and its RLS
 * policy (`customers manage own addresses`, `using (auth.uid() =
 * customer_id)`) have existed since the Phase 1 schema and needed no
 * changes at all - this file is pure API work on top of an
 * already-correct data layer. validateAddress() is the exact same
 * validator checkout already uses (server/src/validation/validators.js),
 * reused unchanged rather than duplicated.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireCustomer } from "../auth/customerAuth.js";
import { AppError, sendOk, asyncRoute, catalogErrorHandler } from "../utils/apiResponse.js";
import { validateAddress, sanitizeText, isValidUUID } from "../validation/validators.js";

const router = Router();
router.use(requireCustomer);

function cleanAddressInput(body) {
  return {
    full_name: sanitizeText(String(body.full_name).trim()),
    phone: String(body.phone).trim(),
    line1: sanitizeText(String(body.line1).trim()),
    line2: body.line2 ? sanitizeText(String(body.line2).trim()) : null,
    city: sanitizeText(String(body.city).trim()),
    state: sanitizeText(String(body.state).trim()),
    pincode: String(body.pincode).trim(),
    // Phase 8A: both optional - validateAddress() (already run by every
    // caller of this function before it's invoked) only checks their
    // shape when actually present.
    state_code: body.state_code || null,
    gstin: body.gstin ? String(body.gstin).trim().toUpperCase() : null,
    is_default: !!body.is_default,
  };
}

// Only one address may be the default at a time - clearing every other
// one of this customer's addresses before a new default is set/created is
// a simple two-step (not a single atomic statement), which is an
// acceptable, low-stakes trade-off here: a race only affects which of a
// customer's OWN addresses ends up flagged default (a UI convenience),
// never money or stock, unlike the atomic guarantees Phase 5B needs.
async function unsetOtherDefaults(customerId, exceptId) {
  let q = supabaseAdmin().from("addresses").update({ is_default: false }).eq("customer_id", customerId).eq("is_default", true);
  if (exceptId) q = q.neq("id", exceptId);
  await q;
}

// ---- GET /api/public/addresses ----
router.get(
  "/",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabaseAdmin()
      .from("addresses").select("*").eq("customer_id", req.customer.id)
      .order("is_default", { ascending: false }).order("created_at", { ascending: false });
    if (error) throw error;
    sendOk(res, { items: data || [] });
  })
);

// ---- POST /api/public/addresses ----
router.post(
  "/",
  asyncRoute(async (req, res) => {
    const { valid, errors } = validateAddress(req.body || {});
    if (!valid) throw new AppError("Validation failed", 400, "VALIDATION_FAILED", errors);

    const clean = cleanAddressInput(req.body);
    if (clean.is_default) await unsetOtherDefaults(req.customer.id, null);

    const { data, error } = await supabaseAdmin()
      .from("addresses").insert({ ...clean, customer_id: req.customer.id }).select().single();
    if (error) throw error;
    sendOk(res, { item: data }, undefined, 201);
  })
);

// ---- PUT /api/public/addresses/:id ----
router.put(
  "/:id",
  asyncRoute(async (req, res) => {
    if (!isValidUUID(req.params.id)) throw new AppError("Invalid address id", 400, "INVALID_ID");
    const { valid, errors } = validateAddress(req.body || {});
    if (!valid) throw new AppError("Validation failed", 400, "VALIDATION_FAILED", errors);

    const clean = cleanAddressInput(req.body);
    if (clean.is_default) await unsetOtherDefaults(req.customer.id, req.params.id);

    const { data, error } = await supabaseAdmin()
      .from("addresses").update(clean).eq("id", req.params.id).eq("customer_id", req.customer.id).select().maybeSingle();
    if (error) throw error;
    if (!data) throw new AppError("Address not found", 404, "ADDRESS_NOT_FOUND");
    sendOk(res, { item: data });
  })
);

// ---- DELETE /api/public/addresses/:id ----
router.delete(
  "/:id",
  asyncRoute(async (req, res) => {
    if (!isValidUUID(req.params.id)) throw new AppError("Invalid address id", 400, "INVALID_ID");
    const { data, error } = await supabaseAdmin()
      .from("addresses").delete().eq("id", req.params.id).eq("customer_id", req.customer.id).select().maybeSingle();
    if (error) throw error;
    if (!data) throw new AppError("Address not found", 404, "ADDRESS_NOT_FOUND");
    sendOk(res, { success: true });
  })
);

router.use(catalogErrorHandler);

export default router;
