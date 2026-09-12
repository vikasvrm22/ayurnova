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

/**
 * Phase 4: "Recommended For You" product cards - shared by index.html,
 * product.html and for-you.html rather than each having its own copy.
 * Deterministic/explainable, not a model: `p` is exactly what
 * GET /api/public/wellness/recommendations returned for this customer's
 * stored Dosha/Goals/Concerns.
 */
function forYouCardHtml(p) {
  function fmtPrice(n) { return "₹" + Math.round(n).toLocaleString("en-IN"); }
  const stars = "★".repeat(Math.round(p.avgRating || 0)) + "☆".repeat(5 - Math.round(p.avgRating || 0));
  return `
    <div class="product-card">
      <div class="img">${p.image ? `<img src="${p.image}" alt="${p.title}" style="width:100%;height:100%;object-fit:cover;">` : "Product Image"}</div>
      <div class="body">
        <div class="title">${p.title}</div>
        <div class="stars">${stars} <span class="reviews">(${p.reviewCount || 0})</span></div>
        <div class="price-row">${p.price ? `<span class="price">${fmtPrice(p.price)}</span>` : ""}${p.mrp && p.mrp > p.price ? `<span class="mrp">${fmtPrice(p.mrp)}</span>` : ""}</div>
        <button class="add-btn" onclick="location.href='/product/${p.slug}'">View Product</button>
      </div>
    </div>`;
}

/**
 * Reveals and fills a "Recommended For You" section if (a) a customer is
 * logged in and (b) they have at least one recommendation - otherwise
 * the section stays hidden (its default `display:none` in the markup),
 * so a guest or a customer with no Wellness Profile yet sees the exact
 * same page as before Phase 4, not an empty/broken section.
 */
async function loadForYouSection(gridId, sectionId, pageSize = 6) {
  if (!window.supabaseClient) return;
  const { data } = await window.supabaseClient.auth.getSession();
  if (!data?.session) return;
  try {
    const res = await apiGet(`/api/public/wellness/recommendations?pageSize=${pageSize}`);
    const items = res.data.items || [];
    if (!items.length) return;
    document.getElementById(gridId).innerHTML = items.map(forYouCardHtml).join("");
    document.getElementById(sectionId).style.display = "block";
  } catch (e) {
    // Never let a personalization failure break the rest of the page -
    // the section simply stays hidden, same as "no recommendations yet".
  }
}

document.addEventListener("DOMContentLoaded", () => {
  updateCartBadge();
  // Only pages that actually have this markup (index.html, product.html)
  // get anything rendered here - every other page's call is a no-op via
  // loadForYouSection's own auth/session guard returning early.
  if (document.getElementById("for-you-section")) loadForYouSection("for-you-grid", "for-you-section");
});
