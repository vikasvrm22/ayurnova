import { supabaseAdmin } from "../db/supabaseClient.js";

/** Storefront requests that need to know "which customer is this" (view my
 * orders, submit a review, save an address) send their Supabase Auth
 * access token in the Authorization header. This verifies it against
 * Supabase itself (works regardless of token signing details) and attaches
 * req.customer = { id, email }. Optional: routes that also work for guests
 * (e.g. guest checkout) should NOT use this as a hard gate - check
 * req.customer only where a customer account is actually required. */
export async function attachCustomerIfPresent(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    req.customer = null;
    return next();
  }
  try {
    const { data, error } = await supabaseAdmin().auth.getUser(token);
    if (error || !data?.user) {
      req.customer = null;
    } else {
      req.customer = { id: data.user.id, email: data.user.email };
      req.customerAccessToken = token;
    }
  } catch (e) {
    req.customer = null;
  }
  next();
}

export function requireCustomer(req, res, next) {
  if (!req.customer) return res.status(401).json({ error: "Please log in to continue" });
  next();
}
