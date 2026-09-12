import { Router } from "express";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { attachCustomerIfPresent } from "../auth/customerAuth.js";
import { validateAddress, validatePhone, sanitizeText } from "../validation/validators.js";
import { computeCouponDiscount } from "./coupons.js";
import { recomputeProductRating } from "./reviews.js";
import { config } from "../config.js";

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
    const { items, address, payment_method, coupon_code, guest_email, guest_phone } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }
    if (!["cod", "prepaid"].includes(payment_method)) {
      return res.status(400).json({ error: "Select a valid payment method" });
    }
    const { valid, errors } = validateAddress(address || {});
    if (!valid) return res.status(400).json({ error: "Invalid address", fields: errors });
    if (!req.customer && !validatePhone(guest_phone || "")) {
      return res.status(400).json({ error: "A valid phone number is required for guest checkout" });
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
    const total = subtotal + shippingFee - discount - prepaidDiscount;

    const orderNumber = generateOrderNumber();
    const { data: order, error: orderError } = await supabaseAdmin().from("orders").insert({
      order_number: orderNumber,
      customer_id: req.customer?.id || null,
      guest_email: req.customer ? null : sanitizeText(guest_email || ""),
      guest_phone: req.customer ? null : sanitizeText(guest_phone || ""),
      payment_method, payment_status: payment_method === "cod" ? "unpaid" : "unpaid",
      subtotal, shipping_fee: shippingFee, discount: discount + prepaidDiscount, total,
      coupon_code: coupon_code || null,
      shipping_address: address,
    }).select().single();
    if (orderError) throw orderError;

    const itemsWithOrderId = pricedItems.map((i) => ({ ...i, order_id: order.id }));
    const { error: itemsError } = await supabaseAdmin().from("order_items").insert(itemsWithOrderId);
    if (itemsError) throw itemsError;

    // Decrement stock for each variant purchased.
    for (const item of pricedItems) {
      await supabaseAdmin().rpc("decrement_variant_stock", { variant_id: item.variant_id, qty: item.qty }).catch(async () => {
        // Fallback if the RPC function isn't installed (see SETUP.md) - a
        // plain read-then-write (fine at this traffic scale; a race here
        // would only ever slightly oversell, not corrupt data).
        const { data: v } = await supabaseAdmin().from("product_variants").select("stock").eq("id", item.variant_id).single();
        if (v) await supabaseAdmin().from("product_variants").update({ stock: Math.max(0, v.stock - item.qty) }).eq("id", item.variant_id);
      });
    }

    if (coupon_code && couponResult.coupon) {
      await supabaseAdmin().from("coupons").update({ used_count: couponResult.coupon.used_count + 1 }).eq("id", couponResult.coupon.id);
    }

    // NOTE: order confirmation email/SMS is not wired up - plug your own
    // SMTP/SMS provider call in here (see SETUP.md "Order notifications").

    res.status(201).json({ order_number: orderNumber, total });
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
