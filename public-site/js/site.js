/**
 * AyurVeda Store - shared client-side utilities.
 * Cart lives in localStorage (guest-friendly, no login required to shop);
 * checkout re-prices everything server-side from the database, so nothing
 * here needs to be trusted for money/stock accuracy.
 */
const CART_KEY = "ayur_cart"; // [{variant_id, qty}]

function getCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) || "[]");
  } catch (e) {
    return [];
  }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartBadge();
}

function addToCart(variantId, qty = 1) {
  const cart = getCart();
  const existing = cart.find((i) => i.variant_id === variantId);
  if (existing) existing.qty += qty;
  else cart.push({ variant_id: variantId, qty });
  saveCart(cart);
}

function removeFromCart(variantId) {
  saveCart(getCart().filter((i) => i.variant_id !== variantId));
}

function setCartQty(variantId, qty) {
  const cart = getCart();
  const item = cart.find((i) => i.variant_id === variantId);
  if (item) item.qty = Math.max(1, qty);
  saveCart(cart);
}

function cartCount() {
  return getCart().reduce((sum, i) => sum + i.qty, 0);
}

function updateCartBadge() {
  document.querySelectorAll(".cart-count").forEach((el) => (el.textContent = cartCount()));
}

/** Returns the customer's Supabase access token if logged in, else null. */
async function getCustomerToken() {
  if (!window.supabaseClient) return null;
  const { data } = await window.supabaseClient.auth.getSession();
  return data?.session?.access_token || null;
}

async function apiGet(path) {
  const token = await getCustomerToken();
  const resp = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function apiPost(path, body) {
  const token = await getCustomerToken();
  const resp = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || "Request failed");
  return data;
}

/**
 * Phase 3: product comparison list - same localStorage/guest-friendly
 * pattern as the cart above (no login required, nothing here needs to be
 * trusted since /api/public/products/compare re-fetches everything
 * server-side from real product ids). Capped at
 * catalogService.js's MAX_COMPARE_PRODUCTS (4) to match the API's own
 * limit - kept in sync manually since this is plain static JS, not built
 * from the same source as the server.
 */
const COMPARE_KEY = "ayur_compare"; // [product_id, ...]
const MAX_COMPARE = 4;

function getCompareList() {
  try {
    return JSON.parse(localStorage.getItem(COMPARE_KEY) || "[]");
  } catch (e) {
    return [];
  }
}

function isInCompare(productId) {
  return getCompareList().includes(productId);
}

/** Returns { added, list } - `added` is false if the list was already at
 * MAX_COMPARE and this id wasn't already in it. */
function toggleCompare(productId) {
  let list = getCompareList();
  if (list.includes(productId)) {
    list = list.filter((id) => id !== productId);
  } else {
    if (list.length >= MAX_COMPARE) return { added: false, list };
    list.push(productId);
  }
  localStorage.setItem(COMPARE_KEY, JSON.stringify(list));
  return { added: true, list };
}

document.addEventListener("DOMContentLoaded", updateCartBadge);
