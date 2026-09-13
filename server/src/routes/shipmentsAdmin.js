/**
 * Phase 8B - admin shipment management. Same legacy {item}/{items}/{error}
 * shape as orders.js/returnsAdmin.js (not the newer {success,data}
 * envelope) - this is an admin route, which have consistently stayed on
 * the original shape since Phase 1.
 *
 * Reads open to any staff role (requireStaffAuth only, same convention as
 * orders.js/returnsAdmin.js); every write requires `manageOrders` - a
 * shipment IS the order's fulfilment state now, the same sensitivity tier
 * as the order-status changes it replaces.
 */
import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { requireStaffAuth } from "../auth/adminAuth.js";
import { requirePermission } from "../auth/rbac.js";
import { isValidUUID } from "../validation/validators.js";
import { listShippingProviders, SHIPPING_ENVIRONMENTS } from "../integrations/shipping/registry.js";
import * as shipmentService from "../services/shipmentService.js";
import { SHIPMENT_TRANSITIONS } from "../services/shipmentService.js";

const router = Router();
router.use(requireStaffAuth);

// ---- Available providers for the "Create Shipment" dropdown ----
router.get("/providers", (req, res) => {
  res.json({ items: listShippingProviders(), environments: SHIPPING_ENVIRONMENTS });
});

router.get("/", async (req, res, next) => {
  try {
    const { order_id } = req.query;
    let query = supabaseAdmin().from("shipments").select("*").order("created_at", { ascending: false });
    if (order_id) {
      if (!isValidUUID(order_id)) return res.status(400).json({ error: "Invalid order_id" });
      query = query.eq("order_id", order_id);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { data: shipment, error } = await supabaseAdmin().from("shipments").select("*").eq("id", req.params.id).maybeSingle();
    if (error) throw error;
    if (!shipment) return res.status(404).json({ error: "Shipment not found" });

    const { data: events } = await supabaseAdmin()
      .from("shipment_events").select("*").eq("shipment_id", shipment.id).order("created_at", { ascending: false });
    const { data: rtoReceipt } = await supabaseAdmin()
      .from("shipment_rto_receipts").select("*, shipment_rto_receipt_items(*)").eq("shipment_id", shipment.id).maybeSingle();

    res.json({
      item: shipment,
      events: events || [],
      allowedTransitions: SHIPMENT_TRANSITIONS[shipment.status] || [],
      rtoReceipt: rtoReceipt || null,
    });
  } catch (e) {
    next(e);
  }
});

router.post("/", requirePermission("manageOrders"), async (req, res, next) => {
  try {
    const { order_id, provider, environment } = req.body || {};
    if (!order_id || !isValidUUID(order_id)) return res.status(400).json({ error: "A valid order_id is required" });
    if (!provider) return res.status(400).json({ error: "provider is required" });
    const shipment = await shipmentService.createShipment({ orderId: order_id, provider, environment: environment || "test", actor: req.staff.email });
    res.status(201).json({ item: shipment });
  } catch (e) {
    next(e);
  }
});

router.put("/:id", requirePermission("manageOrders"), async (req, res, next) => {
  try {
    const { awb_number, courier_name, label_url, tracking_url, eta } = req.body || {};
    const updated = await shipmentService.updateShipmentDetails({
      shipmentId: req.params.id, awbNumber: awb_number, courierName: courier_name, labelUrl: label_url, trackingUrl: tracking_url, eta,
      actor: req.staff.email,
    });
    res.json({ item: updated });
  } catch (e) {
    next(e);
  }
});

router.put("/:id/status", requirePermission("manageOrders"), async (req, res, next) => {
  try {
    const { status, note } = req.body || {};
    if (!status) return res.status(400).json({ error: "status is required" });
    const result = await shipmentService.updateShipmentStatus({
      shipmentId: req.params.id, newStatus: status, actor: req.staff.email, source: "admin", note: note || null,
    });
    res.json({ item: result.shipment, changed: result.changed });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/cancel", requirePermission("manageOrders"), async (req, res, next) => {
  try {
    const updated = await shipmentService.cancelShipment({ shipmentId: req.params.id, actor: req.staff.email });
    res.json({ item: updated });
  } catch (e) {
    next(e);
  }
});

router.post("/:id/rto-receive", requirePermission("manageOrders"), async (req, res, next) => {
  try {
    const receipt = await shipmentService.receiveRtoShipment({ shipmentId: req.params.id, actor: req.staff.email });
    res.json({ item: receipt });
  } catch (e) {
    next(e);
  }
});

export default router;
