/**
 * Admin API for the Phase 5A Inventory foundation (batches + ledger).
 * Batch quantity is the source of truth for sellable stock - every quantity
 * or sellability change MUST go through the adjust_batch_quantity()/
 * set_batch_status() Postgres functions (supabase/migrations/
 * 0006_phase5a_inventory_foundation.sql), never a plain UPDATE, so a batch
 * row, its ledger trail, and product_variants.stock always stay consistent
 * with each other inside one atomic transaction.
 *
 * Same auth/RBAC/sanitize conventions as products.js/wellnessAdmin.js,
 * gated on the dedicated `manageInventory` permission for every write;
 * reads only require staff auth (no special permission), matching the
 * existing GET-routes-are-unrestricted-to-any-staff-role convention.
 *
 * Deliberately NOT here yet (Phase 5A is foundation-only): FEFO allocation
 * at sale time, cancellation-restock, and any admin HTML UI.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { validateBatch, sanitizeText, isValidUUID, parsePagination, sanitizeSearchTerm } from "../validation/validators.js";

const router = Router();
const QUALITY_STATUSES = ["pending", "passed", "failed"];
const BATCH_STATUSES = ["active", "quarantined", "expired", "recalled"];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ---- OVERVIEW (Phase 5C) - summary counts for the Inventory dashboard.
// Read-only, no new business logic - every number here is derived from the
// same batches/product_variants columns the rest of Phase 5A/5B already
// treats as authoritative; nothing is computed or stored anywhere else. ----
router.get("/summary", requireStaffAuth, async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const today = todayISO();
    const horizon = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const { data: batches } = await supabaseAdmin().from("batches").select("quantity, batch_status, quality_status, expiry_date");
    const rows = batches || [];
    const isSellable = (b) => b.batch_status === "active" && b.quality_status === "passed" && (!b.expiry_date || b.expiry_date >= today);
    const sellable = rows.filter(isSellable);
    const expiringSoonCount = sellable.filter((b) => b.expiry_date && b.expiry_date <= horizon).length;
    // "Needs attention": a batch that still physically holds stock but is
    // excluded from the sellable aggregate (quarantined/recalled/expired/
    // failed QC) - the same exclusion rule as is_batch_sellable(), just
    // surfaced for a human to act on rather than silently ignored.
    const needsAttentionCount = rows.filter((b) => b.quantity > 0 && !isSellable(b)).length;

    const { data: lowStockVariants } = await supabaseAdmin().from("product_variants").select("id").lte("stock", 10).gt("stock", 0);
    const { data: outOfStockVariants } = await supabaseAdmin().from("product_variants").select("id").eq("stock", 0);

    res.json({
      totalBatches: rows.length,
      sellableBatchCount: sellable.length,
      expiringSoonCount,
      needsAttentionCount,
      lowStockCount: (lowStockVariants || []).length,
      outOfStockCount: (outOfStockVariants || []).length,
      horizonDays: days,
    });
  } catch (e) {
    next(e);
  }
});

// ---- BATCHES ----
router.get("/batches", requireStaffAuth, async (req, res, next) => {
  try {
    const { q, batch_status, quality_status, expiring_within_days } = req.query;
    let query = supabaseAdmin()
      .from("batches")
      .select("*, product_variants(id, label, product_id, products(title))", { count: "exact" })
      .order("created_at", { ascending: false });

    if (req.query.variant_id) {
      if (!isValidUUID(req.query.variant_id)) return res.status(400).json({ error: "Invalid variant_id" });
      query = query.eq("variant_id", req.query.variant_id);
    }
    if (batch_status && BATCH_STATUSES.includes(batch_status)) query = query.eq("batch_status", batch_status);
    if (quality_status && QUALITY_STATUSES.includes(quality_status)) query = query.eq("quality_status", quality_status);
    if (q) query = query.ilike("batch_number", `%${sanitizeSearchTerm(q)}%`);
    if (expiring_within_days) {
      const days = Math.max(1, Math.min(365, Number(expiring_within_days) || 30));
      const horizon = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      query = query.not("expiry_date", "is", null).lte("expiry_date", horizon);
    }

    const { page: p, pageSize: ps } = parsePagination(req.query, { defaultPageSize: 25, maxPageSize: 100 });
    query = query.range((p - 1) * ps, p * ps - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ items: data, total: count, page: p, pageSize: ps });
  } catch (e) {
    next(e);
  }
});

router.get("/batches/:id", requireStaffAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin().from("batches").select("*").eq("id", req.params.id).single();
    if (error) throw error;
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.get("/batches/:id/ledger", requireStaffAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("inventory_ledger").select("*").eq("batch_id", req.params.id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    next(e);
  }
});

router.post("/batches", requireStaffAuth, requirePermission("manageInventory"), async (req, res, next) => {
  try {
    const { valid, errors } = validateBatch(req.body || {});
    if (!valid) return res.status(400).json({ error: "Validation failed", fields: errors });

    const { variant_id, batch_number, mfg_date, expiry_date, quality_status, batch_status } = req.body;
    const { data: variant } = await supabaseAdmin().from("product_variants").select("id").eq("id", variant_id).single();
    if (!variant) return res.status(400).json({ error: "Validation failed", fields: { variant_id: "Variant not found" } });

    // Always insert at quantity 0, then route the initial quantity through
    // adjust_batch_quantity() below - one single place that both writes the
    // first ledger row and (if the new batch is sellable) applies the
    // initial quantity to product_variants.stock, rather than duplicating
    // that logic here for the "create" case.
    const { data: batch, error: insertError } = await supabaseAdmin().from("batches").insert({
      variant_id, batch_number: sanitizeText(String(batch_number).trim()),
      mfg_date: mfg_date || null, expiry_date: expiry_date || null,
      quality_status: quality_status || "pending", batch_status: batch_status || "active",
      created_by: req.staff.email,
    }).select().single();
    if (insertError) throw insertError;

    const initialQty = Number(req.body.quantity) || 0;
    let finalBatch = batch;
    if (initialQty > 0) {
      const { data: adjusted, error: adjustError } = await supabaseAdmin().rpc("adjust_batch_quantity", {
        p_batch_id: batch.id, p_delta: initialQty, p_reason: "received", p_actor: req.staff.email,
      });
      if (adjustError) throw adjustError;
      finalBatch = adjusted;
    }

    res.status(201).json({ item: finalBatch });
  } catch (e) {
    next(e);
  }
});

router.post("/batches/:id/adjust", requireStaffAuth, requirePermission("manageInventory"), async (req, res, next) => {
  try {
    const delta = Number(req.body?.delta);
    const reason = req.body?.reason;
    if (!Number.isInteger(delta) || delta === 0) return res.status(400).json({ error: "Validation failed", fields: { delta: "delta must be a non-zero whole number" } });
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: "Validation failed", fields: { reason: "A reason is required for every inventory adjustment" } });

    const { data, error } = await supabaseAdmin().rpc("adjust_batch_quantity", {
      p_batch_id: req.params.id, p_delta: delta, p_reason: sanitizeText(String(reason).trim()), p_actor: req.staff.email,
    });
    if (error) {
      // Postgres RAISE EXCEPTION surfaces here as a generic error - map the
      // two cases our function can raise to clean 400s instead of a 500,
      // without leaking raw DB error text to the client.
      if (/not found/i.test(error.message)) return res.status(404).json({ error: "Batch not found" });
      if (/cannot be negative/i.test(error.message)) return res.status(400).json({ error: "Validation failed", fields: { delta: "This adjustment would make the batch quantity negative" } });
      throw error;
    }
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.put("/batches/:id/status", requireStaffAuth, requirePermission("manageInventory"), async (req, res, next) => {
  try {
    const { batch_status, quality_status, reason } = req.body || {};
    if (batch_status === undefined && quality_status === undefined) {
      return res.status(400).json({ error: "Validation failed", fields: { batch_status: "Provide batch_status and/or quality_status" } });
    }
    if (batch_status !== undefined && !BATCH_STATUSES.includes(batch_status)) {
      return res.status(400).json({ error: "Validation failed", fields: { batch_status: `Must be one of: ${BATCH_STATUSES.join(", ")}` } });
    }
    if (quality_status !== undefined && !QUALITY_STATUSES.includes(quality_status)) {
      return res.status(400).json({ error: "Validation failed", fields: { quality_status: `Must be one of: ${QUALITY_STATUSES.join(", ")}` } });
    }

    const { data, error } = await supabaseAdmin().rpc("set_batch_status", {
      p_batch_id: req.params.id, p_batch_status: batch_status || null, p_quality_status: quality_status || null,
      p_actor: req.staff.email, p_reason: reason ? sanitizeText(String(reason).trim()) : null,
    });
    if (error) {
      if (/not found/i.test(error.message)) return res.status(404).json({ error: "Batch not found" });
      throw error;
    }
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

// ---- LEDGER (consolidated, cross-batch view for one variant) ----
router.get("/ledger", requireStaffAuth, async (req, res, next) => {
  try {
    let query = supabaseAdmin().from("inventory_ledger").select("*").order("created_at", { ascending: false }).limit(200);
    if (req.query.variant_id) {
      if (!isValidUUID(req.query.variant_id)) return res.status(400).json({ error: "Invalid variant_id" });
      query = query.eq("variant_id", req.query.variant_id);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    next(e);
  }
});

export default router;
