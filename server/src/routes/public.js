import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { attachCustomerIfPresent } from "../auth/customerAuth.js";
import { validateAddress, validatePhone, validateGSTIN, sanitizeText } from "../validation/validators.js";
import { computeCouponDiscount } from "./coupons.js";
import { recomputeProductRating } from "./reviews.js";
import { config } from "../config.js";
import { startPaymentAttempt } from "../services/paymentService.js";
import { getActiveEnvironment } from "../integrations/razorpay/provider.js";
import { notify } from "../notify/notificationService.js";
import { getTaxProfile, calculateOrderTax } from "../services/taxService.js";
import { generateInvoiceForOrder } from "../services/invoiceService.js";
import { GST_STATE_CODES } from "../utils/gstStateCodes.js";

const router = Router();
router.use(attachCustomerIfPresent);

function generateOrderNumber() {
  return `AV-${Date.now().toString().slice(-8)}`;
}

// ---- Public settings a storefront page might need client-side (trust
// badges, social links) - a safe subset only, never staff/customer data. ----
router.get("/settings", async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin().from("settings").select("*").in("key", ["trust_badges", "shipping", "social_links"]);
    if (error) throw error;
    res.json({ settings: Object.fromEntries(data.map((r) => [r.key, r.value])) });
  } catch (e) {
    next(e);
  }
});

// ---- Phase 8A: the fixed GST state/UT code list - static reference data,
// never sensitive, so no auth needed. Powers the checkout/address-book
// State dropdowns (structured state_code, not free-text). ----
router.get("/gst-state-codes", (req, res) => {
  res.json({ items: GST_STATE_CODES });
});

// ---- Phase 8A: exposes ONLY the pricing mode (never GSTIN/registered
// address/invoice numbering) - safe for any storefront/admin page to
// read without auth, purely so the "how does this affect the price"
// explainer (product-form.html, cart.html) can reflect the real
// admin-configured mode rather than assuming one. ----
router.get("/tax-mode", async (req, res, next) => {
  try {
    const taxProfile = await getTaxProfile();
    res.json({ pricingMode: taxProfile.pricing_mode, gstRegistered: taxProfile.gst_registered });
  } catch (e) {
    next(e);
  }
});

// ---- Coupon validation (cart page calls this before checkout) ----
router.post("/coupons/validate", async (req, res, next) => {
  try {
    const { code, subtotal } = req.body || {};
    const result = await computeCouponDiscount(code, Number(subtotal || 0));
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ discount: result.discount });
  } catch (e) {
    next(e);
  }
});

// ---- Checkout: creates an order (guest or logged-in customer) ----
router.post("/checkout", async (req, res, next) => {
  try {
    const { items, address, billing_address, gstin, payment_method, coupon_code, guest_email, guest_phone } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }
    if (!["cod", "prepaid"].includes(payment_method)) {
      return res.status(400).json({ error: "Select a valid payment method" });
    }
    // Phase 9B (P1-3): the admin "COD Available" toggle must actually gate
    // COD order creation, not just the storefront badge - otherwise a direct
    // API call could bypass an admin's decision to disable COD.
    if (payment_method === "cod") {
      const { data: trustBadgesSetting } = await supabaseAdmin().from("settings").select("value").eq("key", "trust_badges").single();
      const codEnabled = trustBadgesSetting?.value?.cod !== false;
      if (!codEnabled) {
        return res.status(400).json({ error: "Cash on Delivery is currently unavailable. Please choose an online payment method." });
      }
    }
    const { valid, errors } = validateAddress(address || {});
    if (!valid) return res.status(400).json({ error: "Invalid address", fields: errors });
    if (!req.customer && !validatePhone(guest_phone || "")) {
      return res.status(400).json({ error: "A valid phone number is required for guest checkout" });
    }
    // Phase 8A: both optional. A billing address is only meaningful if the
    // customer actually provided one (omitting it means "same as
    // shipping", the default/backward-compatible behaviour for every
    // order) - only validated as a real address when present.
    if (billing_address) {
      const billingCheck = validateAddress(billing_address);
      if (!billingCheck.valid) return res.status(400).json({ error: "Invalid billing address", fields: billingCheck.errors });
    }
    if (gstin && !validateGSTIN(gstin)) {
      return res.status(400).json({ error: "Enter a valid 15-character GSTIN, or leave it blank" });
    }
    // Fail BEFORE creating an order if prepaid checkout has nowhere to go -
    // otherwise a Razorpay outage/misconfiguration would leave a real,
    // unpayable order row behind (Phase 2 order-integrity requirement).
    if (payment_method === "prepaid" && !(await getActiveEnvironment())) {
      return res.status(503).json({ error: "Online payment is not available right now. Please choose Cash on Delivery, or try again shortly." });
    }

    // Re-price server-side from the database - never trust client-sent prices.
    let subtotal = 0;
    const pricedItems = [];
    for (const line of items) {
      const { data: variant } = await supabaseAdmin()
        .from("product_variants").select("*, products(title, status)").eq("id", line.variant_id).single();
      if (!variant || variant.products?.status !== "published") {
        return res.status(400).json({ error: `A product in your cart is no longer available` });
      }
      const qty = Math.max(1, Number(line.qty || 1));
      if (variant.stock < qty) {
        return res.status(400).json({ error: `Only ${variant.stock} left in stock for ${variant.products.title} (${variant.label})` });
      }
      const lineSubtotal = Number(variant.price) * qty;
      subtotal += lineSubtotal;
      pricedItems.push({
        product_id: variant.product_id, variant_id: variant.id,
        title_snapshot: variant.products.title, variant_label_snapshot: variant.label,
        price_snapshot: variant.price, qty, subtotal: lineSubtotal,
        // Phase 8A: carried through purely to feed calculateOrderTax()
        // below - never written to order_items directly (that uses the
        // _snapshot columns, set from the tax calculation's own output).
        hsn_code: variant.hsn_code || null, tax_rate_percent: variant.tax_rate_percent || null,
      });
    }

    const couponResult = coupon_code ? await computeCouponDiscount(coupon_code, subtotal) : { discount: 0 };
    if (couponResult.error) return res.status(400).json({ error: couponResult.error });
    const discount = couponResult.discount || 0;

    const { data: shippingSetting } = await supabaseAdmin().from("settings").select("value").eq("key", "shipping").single();
    const freeShippingThreshold = shippingSetting?.value?.free_shipping_threshold ?? config.shipping.freeShippingThreshold;
    const prepaidDiscountPercent = shippingSetting?.value?.prepaid_discount_percent ?? config.shipping.prepaidDiscountPercent;

    const shippingFee = subtotal >= freeShippingThreshold ? 0 : 60;
    const prepaidDiscount = payment_method === "prepaid" ? Math.round((subtotal * prepaidDiscountPercent) / 100) : 0;
    const totalDiscount = discount + prepaidDiscount;

    // Phase 8A: server-authoritative tax calculation. Place of supply is
    // taken from the SHIPPING/delivery address's state code - the common
    // treatment for goods shipped to the buyer - not the billing address;
    // this is an engineering default, not a confirmed legal position, and
    // should be reviewed with the business's tax advisor before the store
    // goes GST-live (see taxService.js's own doc comment).
    const taxProfile = await getTaxProfile();
    const homeStateCode = taxProfile.registered_address?.state_code || null;
    const placeOfSupplyStateCode = address?.state_code || null;
    const taxResult = calculateOrderTax({
      lines: pricedItems.map((i) => ({ lineSubtotal: i.subtotal, hsnCode: i.hsn_code, taxRatePercent: i.tax_rate_percent })),
      discountTotal: totalDiscount,
      taxMode: taxProfile.pricing_mode,
      homeStateCode, placeOfSupplyStateCode,
      gstRegistered: taxProfile.gst_registered,
    });

    // Inclusive mode: tax is already embedded in `subtotal` - the total
    // formula is UNCHANGED from before Phase 8A, so nothing is ever
    // double-added. Exclusive mode: tax is genuine additional money owed,
    // added here exactly once.
    const total = taxProfile.pricing_mode === "exclusive"
      ? subtotal + shippingFee - totalDiscount + taxResult.taxAmount
      : subtotal + shippingFee - totalDiscount;

    const orderNumber = generateOrderNumber();
    const { data: order, error: orderError } = await supabaseAdmin().from("orders").insert({
      order_number: orderNumber,
      customer_id: req.customer?.id || null,
      guest_email: req.customer ? null : sanitizeText(guest_email || ""),
      guest_phone: req.customer ? null : sanitizeText(guest_phone || ""),
      payment_method, payment_status: payment_method === "cod" ? "unpaid" : "unpaid",
      subtotal, shipping_fee: shippingFee, discount: totalDiscount, total,
      coupon_code: coupon_code || null,
      shipping_address: address,
      billing_address: billing_address || null,
      buyer_gstin: gstin ? gstin.trim().toUpperCase() : null,
      place_of_supply_state_code: placeOfSupplyStateCode,
      tax_mode: taxProfile.pricing_mode,
      taxable_value: taxResult.taxableValue,
      cgst_amount: taxResult.cgstAmount, sgst_amount: taxResult.sgstAmount, igst_amount: taxResult.igstAmount,
      tax_amount: taxResult.taxAmount,
    }).select().single();
    if (orderError) throw orderError;

    const itemsWithOrderId = pricedItems.map((i, idx) => {
      const t = taxResult.lines[idx];
      return {
        product_id: i.product_id, variant_id: i.variant_id,
        title_snapshot: i.title_snapshot, variant_label_snapshot: i.variant_label_snapshot,
        price_snapshot: i.price_snapshot, qty: i.qty, subtotal: i.subtotal,
        order_id: order.id,
        hsn_code_snapshot: t.hsnCode, tax_rate_snapshot: t.taxRatePercent, taxable_value_snapshot: t.taxableValue,
        cgst_amount_snapshot: t.cgstAmount, sgst_amount_snapshot: t.sgstAmount, igst_amount_snapshot: t.igstAmount,
      };
    });
    const { error: itemsError } = await supabaseAdmin().from("order_items").insert(itemsWithOrderId);
    if (itemsError) throw itemsError;

    if (payment_method === "cod") {
      // COD: decrement stock immediately, since there is no payment gateway
      // step that could fail/be abandoned - unchanged in spirit from before
      // Phase 2. Phase 5B replaces the old flat decrement_variant_stock RPC
      // call with atomic FEFO batch allocation (earliest-expiry-first,
      // across as many batches as needed) - one RPC call allocates every
      // line of this order inside a single DB transaction, so a shortfall
      // on any line (e.g. a race against another checkout) rolls back
      // every line's allocation, never leaving a partially-fulfilled order.
      const { error: allocError } = await supabaseAdmin().rpc("allocate_fefo_stock_for_order", {
        p_order_id: order.id, p_actor: "system(checkout)", p_reason: "sale",
      });
      if (allocError) {
        // Nothing was decremented (the allocation transaction rolled back
        // in full) - only the order/order_items rows created earlier in
        // THIS request need cleaning up.
        await supabaseAdmin().from("order_items").delete().eq("order_id", order.id);
        await supabaseAdmin().from("orders").delete().eq("id", order.id);
        return res.status(409).json({ error: "One or more items in your cart just went out of stock. Please review your cart and try again." });
      }
    }
    // Phase 2: for "prepaid", stock is intentionally NOT decremented here.
    // Decrementing at order-creation time (the pre-Phase-2 behaviour) would
    // hold/consume inventory for a payment that might fail or be abandoned
    // in the Razorpay checkout popup. Stock is decremented only once a
    // payment is verified as SUCCESS - see paymentService.markAttemptOutcome,
    // called from the /verify and /webhook/razorpay routes below.

    if (coupon_code && couponResult.coupon) {
      await supabaseAdmin().from("coupons").update({ used_count: couponResult.coupon.used_count + 1 }).eq("id", couponResult.coupon.id);
    }

    if (payment_method === "prepaid") {
      const paymentAttempt = await startPaymentAttempt(order);
      // Phase 7: NOT notified here - a prepaid order isn't a real
      // commitment until payment actually succeeds (an abandoned Razorpay
      // checkout would otherwise get a false "order placed" message).
      // See paymentService.markAttemptOutcome for the single point where
      // that success is confirmed, for both the verify-callback and
      // webhook paths.
      return res.status(201).json({ order_number: orderNumber, total, payment_required: true, ...paymentAttempt });
    }

    // COD is a real, immediate commitment (stock already decremented
    // above) - notify right away. Awaited but internally bulletproofed
    // against ever throwing (see notificationService.js).
    await notify("order_placed", { order, total });

    // Phase 8A: "generate only after the order is successfully created
    // AND order acceptance is confirmed" - for COD that's exactly this
    // point (stock already allocated above, no payment gate). Idempotent
    // and must never block the checkout response on a PDF/DB hiccup, same
    // tolerance as every other non-critical side effect here.
    try {
      await generateInvoiceForOrder(order.id, { actor: "system(cod)" });
    } catch (invoiceError) {
      await supabaseAdmin().from("activity_log").insert({
        entity_type: "order", entity_id: order.id, action: "invoice_generation_failed", actor: "system",
        note: (invoiceError.message || "generateInvoiceForOrder failed").slice(0, 500),
      });
    }

    res.status(201).json({ order_number: orderNumber, total, payment_required: false });
  } catch (e) {
    next(e);
  }
});

// ---- Product review submission (logged-in customers only) ----
router.post("/reviews", async (req, res, next) => {
  try {
    if (!req.customer) return res.status(401).json({ error: "Please log in to leave a review" });
    const { product_id, rating, title, body, customer_name } = req.body || {};
    const ratingNum = Number(rating);
    if (!product_id || !Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ error: "A product and a rating from 1-5 are required" });
    }
    const { data, error } = await supabaseAdmin().from("reviews").insert({
      product_id, customer_id: req.customer.id, customer_name: sanitizeText(customer_name || req.customer.email),
      rating: ratingNum, title: sanitizeText(title || ""), body: sanitizeText(body || ""), status: "pending",
    }).select().single();
    if (error) throw error;
    res.status(201).json({ item: data, message: "Thanks! Your review will appear after moderation." });
  } catch (e) {
    next(e);
  }
});

// ---- Consult-a-Vaidya booking (public, no login required) ----
router.post("/vaidya-bookings", async (req, res, next) => {
  try {
    const { full_name, phone, email, concern, preferred_vaidya, preferred_datetime, description } = req.body || {};
    if (!full_name || !validatePhone(phone || "")) {
      return res.status(400).json({ error: "Name and a valid phone number are required" });
    }
    const { data, error } = await supabaseAdmin().from("vaidya_bookings").insert({
      full_name: sanitizeText(full_name), phone: sanitizeText(phone), email: sanitizeText(email || ""),
      concern: sanitizeText(concern || ""), preferred_vaidya: sanitizeText(preferred_vaidya || ""),
      preferred_datetime: preferred_datetime || null, description: sanitizeText(description || ""),
    }).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, booking_id: data.id });
  } catch (e) {
    next(e);
  }
});

// ---- Dosha test result (optional save, works for guests too) ----
router.post("/dosha-results", async (req, res, next) => {
  try {
    const { answers, result_dosha } = req.body || {};
    if (!answers || !result_dosha) return res.status(400).json({ error: "answers and result_dosha required" });
    const { error } = await supabaseAdmin().from("dosha_results").insert({
      customer_id: req.customer?.id || null, answers, result_dosha,
    });
    if (error) throw error;
    res.status(201).json({ success: true });
  } catch (e) {
    next(e);
  }
});

// ---- Cart item lookup: cart contents live in the browser (localStorage);
// this returns authoritative current price/stock/title for a set of variant
// ids so the cart page always shows accurate, up-to-date data. ----
router.get("/cart-items", async (req, res, next) => {
  try {
    const ids = String(req.query.ids || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return res.json({ items: [] });
    const { data, error } = await supabaseAdmin()
      .from("product_variants")
      .select("id, label, price, mrp, stock, product_id, products(title, slug, status, product_images(url, sort_order))")
      .in("id", ids);
    if (error) throw error;
    res.json({ items: (data || []).filter((v) => v.products?.status === "published") });
  } catch (e) {
    next(e);
  }
});

// ---- Customer's own order history (account page) ----
router.get("/my-orders", async (req, res, next) => {
  try {
    if (!req.customer) return res.status(401).json({ error: "Please log in" });
    const { data, error } = await supabaseAdmin()
      .from("orders").select("*").eq("customer_id", req.customer.id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ items: data });
  } catch (e) {
    next(e);
  }
});

export default router;
