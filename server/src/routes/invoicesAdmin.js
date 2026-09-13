/**
 * Phase 8A - admin invoice list/detail/PDF download. Read-only: an
 * invoice is only ever created by invoiceService.generateInvoiceForOrder
 * (triggered from checkout/payment success, never from an admin action)
 * - there is deliberately no "create invoice" admin route.
 *
 * RBAC: reuses the existing `manageOrders` permission (SuperAdmin/Admin
 * only - see server/src/config.js ROLE_PERMISSIONS) rather than adding a
 * new one - an invoice is fundamentally an order document, the same
 * sensitivity tier as order management, and manageOrders already
 * excludes Editor/Viewer.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { parsePagination, sanitizeOrFilterValue, isValidUUID } from "../validation/validators.js";
import { renderInvoicePdfBuffer } from "../services/invoiceService.js";

const router = Router();
router.use(requireStaffAuth, requirePermission("manageOrders"));

router.get("/", async (req, res, next) => {
  try {
    const { q, order_id } = req.query;
    let query = supabaseAdmin()
      .from("invoices")
      .select("id, order_id, invoice_number, status, tax_mode, grand_total, created_at, orders(order_number)", { count: "exact" })
      .order("created_at", { ascending: false });

    if (order_id && isValidUUID(order_id)) query = query.eq("order_id", order_id);

    // Same-table column only (invoice_number) - PostgREST's `.or()` filter
    // grammar does not safely extend across the joined `orders` embed the
    // way it does for a same-table column (see orders.js's own use of
    // this exact helper for why the value itself is allowlisted either
    // way).
    const safeQ = sanitizeOrFilterValue(q);
    if (safeQ) query = query.ilike("invoice_number", `%${safeQ}%`);

    const { page, pageSize } = parsePagination(req.query);
    query = query.range((page - 1) * pageSize, page * pageSize - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ items: data, total: count, page, pageSize });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin()
      .from("invoices").select("*, orders(order_number, status, payment_method)").eq("id", req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Invoice not found" });
    res.json({ item: data });
  } catch (e) {
    next(e);
  }
});

router.get("/:id/pdf", async (req, res, next) => {
  try {
    const { data: invoice, error } = await supabaseAdmin().from("invoices").select("*").eq("id", req.params.id).maybeSingle();
    if (error) throw error;
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    const pdf = await renderInvoicePdfBuffer(invoice);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${invoice.invoice_number}.pdf"`);
    res.send(pdf);
  } catch (e) {
    next(e);
  }
});

export default router;
