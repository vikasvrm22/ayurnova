/**
 * AyurNova - shared client-side utilities.
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

/** Older routes (checkout, reviews, ...) return `{error: "<string>"}`;
 * newer routes (catalogPublic.js, wellnessPublic.js, and Phase 6A's new
 * routes) return `{success:false, error:{code, message}}` - `data.error`
 * is an OBJECT there, not a string. `new Error(data.error)` on an object
 * stringifies to the useless "[object Object]" instead of the real
 * message. Handles both shapes so every existing/new call site gets a
 * real, readable error message either way. */
function extractErrorMessage(data) {
  if (data && typeof data.error === "object" && data.error !== null) return data.error.message || "Request failed";
  return (data && data.error) || "Request failed";
}

async function apiGet(path) {
  const token = await getCustomerToken();
  const resp = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(extractErrorMessage(data));
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
  if (!resp.ok) throw new Error(extractErrorMessage(data));
  return data;
}

async function apiPut(path, body) {
  const token = await getCustomerToken();
  const resp = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(extractErrorMessage(data));
  return data;
}

async function apiDelete(path) {
  const token = await getCustomerToken();
  const resp = await fetch(path, { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(extractErrorMessage(data));
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
      <button class="wishlist-toggle" data-wishlist-product-id="${p.id}" title="Add to Wishlist">♡</button>
      <div class="img">${p.image ? `<img src="${p.image}" alt="${p.title}" loading="lazy" style="width:100%;height:100%;object-fit:cover;">` : "Product Image"}</div>
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

/**
 * Phase 8C - customer wishlist (server-side, login-required, unlike the
 * guest-friendly localStorage cart/compare above). Every page that renders
 * a product card or a wishlist toggle button (product cards from
 * server/src/routes/pages.js's productCardHtml(), forYouCardHtml() above,
 * and product.html's own detail-page button) shares this one client-side
 * module so a toggle click behaves identically everywhere.
 *
 * `__wishlistIds` is loaded at most once per page view (null = not yet
 * loaded) - a guest (no Supabase session) gets an empty set without ever
 * calling the API, since GET /api/public/wishlist requireCustomer's every
 * request anyway.
 */
let __wishlistIds = null;

async function loadWishlistIds() {
  if (__wishlistIds) return __wishlistIds;
  const token = await getCustomerToken();
  if (!token) {
    __wishlistIds = new Set();
    return __wishlistIds;
  }
  try {
    const res = await apiGet("/api/public/wishlist?pageSize=100");
    __wishlistIds = new Set((res.data.items || []).map((i) => i.productId));
  } catch (e) {
    __wishlistIds = new Set();
  }
  return __wishlistIds;
}

function updateWishlistCountBadge() {
  const count = __wishlistIds ? __wishlistIds.size : 0;
  document.querySelectorAll(".wishlist-count").forEach((el) => (el.textContent = count));
}

function setWishlistButtonState(btn, active) {
  btn.classList.toggle("active", active);
  // The small circular card toggle is icon-only; the product-detail page's
  // own button (`.pd-wishlist-btn`) also carries a text label.
  const icon = active ? "♥" : "♡";
  btn.textContent = btn.classList.contains("pd-wishlist-btn") ? `${icon} ${active ? "Wishlisted" : "Wishlist"}` : icon;
  btn.title = active ? "Remove from Wishlist" : "Add to Wishlist";
  btn.setAttribute("aria-pressed", active ? "true" : "false");
}

async function toggleWishlistButton(btn, productId) {
  const token = await getCustomerToken();
  if (!token) {
    location.href = "/account";
    return;
  }
  const ids = await loadWishlistIds();
  const wasActive = ids.has(productId);
  btn.disabled = true;
  try {
    if (wasActive) {
      await apiDelete(`/api/public/wishlist/${productId}`);
      ids.delete(productId);
    } else {
      await apiPost("/api/public/wishlist", { product_id: productId });
      ids.add(productId);
    }
    setWishlistButtonState(btn, !wasActive);
    updateWishlistCountBadge();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
}

/** Binds every not-yet-bound `[data-wishlist-product-id]` button on the
 * page to the current wishlist state - safe to call more than once (e.g.
 * again after a client-rendered grid like "Recommended For You" injects
 * new cards asynchronously), since already-bound buttons are skipped via
 * `data-wishlist-bound`. Always refreshes the header count badge too,
 * even on a page with no wishlistable product on it at all (cart.html,
 * contact.html, ...), so the header icon stays accurate site-wide. */
async function initWishlistButtons() {
  const ids = await loadWishlistIds();
  updateWishlistCountBadge();
  const buttons = document.querySelectorAll("[data-wishlist-product-id]:not([data-wishlist-bound])");
  buttons.forEach((btn) => {
    const productId = btn.dataset.wishlistProductId;
    if (!productId) return; // product.html's own button starts empty until window.__PRODUCT__ fills it in
    btn.dataset.wishlistBound = "true";
    setWishlistButtonState(btn, ids.has(productId));
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      toggleWishlistButton(btn, productId);
    });
  });
}

/** Binds every not-yet-bound `[data-add-to-cart-variant-id]` button (Phase 1
 * gap closure: homepage product-grid cards previously only linked to the
 * PDP) to the same guest cart every other Add to Cart control on the site
 * already uses (product.html's own siteAddToCart -> addToCart above) -
 * no separate cart system, just another caller of it. Brief inline
 * "Added" confirmation instead of a page navigation, since these cards
 * are meant to keep the shopper browsing the grid. */
function initAddToCartButtons() {
  document.querySelectorAll("[data-add-to-cart-variant-id]:not([data-add-to-cart-bound])").forEach((btn) => {
    btn.dataset.addToCartBound = "true";
    const originalLabel = btn.textContent;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      addToCart(btn.dataset.addToCartVariantId, 1);
      btn.textContent = "Added ✓";
      btn.classList.add("added");
      setTimeout(() => {
        btn.textContent = originalLabel;
        btn.classList.remove("added");
      }, 1500);
    });
  });
}

/** Hero carousel (Phase 1 gap closure) - cycles `.hero-slide`/`.hero-dot`
 * active state. 0 or 1 slide (no active "home_hero" media asset beyond
 * the static fallback - see pages.js's renderHeroSlides) means there's
 * nothing to cycle through, so the arrows/dots are hidden entirely
 * (`.single`) rather than shipped as dead controls. */
function initHeroCarousel() {
  const root = document.getElementById("hero-carousel");
  if (!root) return;
  const slides = Array.from(root.querySelectorAll(".hero-slide"));
  const dots = Array.from(root.querySelectorAll(".hero-dot"));
  if (slides.length <= 1) { root.classList.add("single"); return; }

  let index = Math.max(0, slides.findIndex((s) => s.classList.contains("active")));
  function show(i) {
    index = (i + slides.length) % slides.length;
    slides.forEach((s, n) => s.classList.toggle("active", n === index));
    dots.forEach((d, n) => d.classList.toggle("active", n === index));
  }
  root.querySelectorAll("[data-hero-nav]").forEach((btn) => {
    btn.addEventListener("click", () => { show(index + Number(btn.dataset.heroNav)); resetAutoplay(); });
  });
  dots.forEach((d, n) => d.addEventListener("click", () => { show(n); resetAutoplay(); }));

  let timer;
  function resetAutoplay() {
    clearInterval(timer);
    timer = setInterval(() => show(index + 1), 6000);
  }
  resetAutoplay();
}

document.addEventListener("DOMContentLoaded", () => {
  updateCartBadge();
  initWishlistButtons();
  initAddToCartButtons();
  initHeroCarousel();
  // Only pages that actually have this markup (index.html, product.html)
  // get anything rendered here - every other page's call is a no-op via
  // loadForYouSection's own auth/session guard returning early.
  if (document.getElementById("for-you-section")) loadForYouSection("for-you-grid", "for-you-section").then(initWishlistButtons);
});
