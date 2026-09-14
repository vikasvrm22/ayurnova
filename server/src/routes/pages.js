import { Router } from "express";
import { config } from "../config.js";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { getTemplate } from "../seo/templates.js";
import {
  escapeHtml, truncate, renderHeadMeta, renderProductJsonLd, renderBreadcrumbJsonLd, parseListLines,
} from "../seo/seoHelpers.js";
import { trackPageView } from "../analytics/tracker.js";
import { sanitizeRichText } from "../utils/richTextSanitizer.js";
import {
  listPublishedProducts, getPublishedProductBySlug, listCategories, listRelatedEntities, searchCatalog,
  getCategoryBySlug, getIngredientBySlug,
  PRODUCT_SORT_MAP, DEFAULT_PRODUCT_SORT,
} from "../services/catalogService.js";

const router = Router();

// ---- Tiny in-memory page cache (short TTL - never stale for a shopper) ----
const pageCache = new Map();
function cached(key, renderFn) {
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.at < config.ssrCacheTtlMs) return Promise.resolve(hit.html);
  return renderFn().then((html) => {
    pageCache.set(key, { html, at: Date.now() });
    return html;
  });
}

// Phase 9F (P1-7): the 5-min TTL above means a newly published/edited
// product or category could be invisible on Home/Shop for up to 5
// minutes - self-heals, but a confusing "did my publish actually work?"
// moment for staff. Admin product/category write routes (products.js,
// categories.js) call this on every successful mutation so a publish
// takes effect on the very next storefront request, same immediacy
// legal-pages.js already gets via its own updated_at-keyed cache key
// (a different technique, not applicable here since these two pages
// aggregate many rows rather than rendering one). Deliberately narrow:
// only the catalog-derived entries (home/shop/sitemap/faq) are cleared -
// the legal-page cache is untouched since it uses its own content-derived
// key (page.updated_at) instead and self-invalidates by construction.
// "faq" added alongside faqs.js's own write routes (Wiring Guardian
// finding WG-0036): the global FAQ page was cached under a static "faq"
// key that nothing ever cleared, so a published/edited FAQ could stay
// stale on the public page for up to the cache TTL.
export function invalidateCatalogCache() {
  for (const key of pageCache.keys()) {
    if (key === "home" || key === "sitemap" || key === "faq" || key.startsWith("shop:")) pageCache.delete(key);
  }
}

function fmtPrice(n) {
  return `₹${Number(n).toLocaleString("en-IN")}`;
}

// ============================= PHASE 3: DISCOVERY NAV HELPERS =============================
// Real categories.type='concern'/'benefit'/'goal'/'product_type' rows,
// rendered wherever the pre-Phase-3 markup had hardcoded, dead-end
// `<a href="/shop">Some Fake Category</a>` links (Phase 0 §10/§13's
// flagged gap) - genuinely empty state ("Coming soon") when no categories
// of that type exist yet, never invented placeholder content.

/** Builds a /shop URL that toggles ONE filter key on/off while preserving
 * every other currently-active query param (so picking a Benefit doesn't
 * lose an already-picked Concern) and always resets pagination. */
function shopFilterUrl(currentQuery, key, slug) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(currentQuery || {})) {
    if (typeof v === "string" && k !== "page") params.set(k, v);
  }
  if (params.get(key) === slug) params.delete(key);
  else params.set(key, slug);
  const qs = params.toString();
  return `/shop${qs ? `?${qs}` : ""}`;
}

/** The shop sidebar's filter blocks: clickable list of real category names
 * for one dimension, toggling that dimension's query param in place. */
function renderFilterBlock(categories, key, currentQuery) {
  if (!categories.length) return `<span style="font-size:12px; color:#888;">Coming soon.</span>`;
  const active = currentQuery?.[key];
  return categories.map((c) => {
    const isActive = c.slug === active;
    return `<a href="${shopFilterUrl(currentQuery, key, c.slug)}" style="display:block; padding:3px 0; font-size:13px;${isActive ? " font-weight:700; color:var(--green);" : ""}">${isActive ? "✓ " : ""}${escapeHtml(c.name)}</a>`;
  }).join("");
}

/** The header mega-menu's dropdown items: link to that concern/benefit's
 * own dedicated landing page (SEO-indexable, per the Phase 0 §13 gap) -
 * not a /shop filter link, which is what the sidebar is for. */
function renderMegaMenu(categories, pathPrefix) {
  if (!categories.length) return `<span style="padding:8px 16px; color:#888; font-size:12.5px; display:block;">Coming soon</span>`;
  return categories.map((c) => `<a href="/${pathPrefix}/${escapeHtml(c.slug)}">${escapeHtml(c.name)}</a>`).join("");
}

/** Footer "Top Categories" - same landing-page links as the mega-menu,
 * mixing concern+benefit so the footer isn't empty when only one type has
 * real content yet. */
/** Real prev/next/numbered pagination for /shop and search results -
 * preserves every current query param except `page`. Previously the shop
 * page just had two decorative, unwired buttons (Category B gap). */
function renderPagination(currentQuery, page, totalPages) {
  if (totalPages <= 1) return "";
  const urlFor = (p) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(currentQuery || {})) if (typeof v === "string" && v) params.set(k, v);
    params.set("page", String(p));
    return `/shop?${params.toString()}`;
  };
  const windowStart = Math.max(1, page - 2);
  const windowEnd = Math.min(totalPages, page + 2);
  let html = `<a href="${page > 1 ? urlFor(page - 1) : "#"}" class="${page <= 1 ? "disabled" : ""}" ${page <= 1 ? "aria-disabled=\"true\" onclick=\"return false;\"" : ""}>&lsaquo;</a>`;
  if (windowStart > 1) html += `<a href="${urlFor(1)}">1</a>${windowStart > 2 ? "<span>…</span>" : ""}`;
  for (let p = windowStart; p <= windowEnd; p++) html += `<a href="${urlFor(p)}" class="${p === page ? "active" : ""}">${p}</a>`;
  if (windowEnd < totalPages) html += `${windowEnd < totalPages - 1 ? "<span>…</span>" : ""}<a href="${urlFor(totalPages)}">${totalPages}</a>`;
  html += `<a href="${page < totalPages ? urlFor(page + 1) : "#"}" class="${page >= totalPages ? "disabled" : ""}" ${page >= totalPages ? "aria-disabled=\"true\" onclick=\"return false;\"" : ""}>&rsaquo;</a>`;
  return html;
}

function renderFooterCategories(concerns, benefits) {
  const links = [
    ...concerns.slice(0, 4).map((c) => `<a href="/concern/${escapeHtml(c.slug)}">${escapeHtml(c.name)}</a>`),
    ...benefits.slice(0, 4).map((c) => `<a href="/benefit/${escapeHtml(c.slug)}">${escapeHtml(c.name)}</a>`),
  ];
  return links.length ? links.join("") : `<a href="/shop">Shop All</a>`;
}

/** Homepage "Shop by Category" tiles - real product_type categories,
 * linking to the same /shop?category= filter the shop sidebar already
 * uses. Empty state instead of inventing placeholder categories. */
function renderCategoryTiles(categories) {
  if (!categories.length) return `<p style="color:#888; font-size:13px;">Categories coming soon.</p>`;
  return categories.slice(0, 8).map((c) => `
    <a class="category-tile" href="/shop?category=${escapeHtml(c.slug)}">
      <span class="category-tile-icon">${LEAF_ICON}</span>
      <span class="category-tile-name">${escapeHtml(c.name)}</span>
    </a>`).join("");
}
const LEAF_ICON = `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 6C16 12 12 19 12 26c0 6 4 11 12 15 8-4 12-9 12-15 0-7-4-14-12-20z" fill="currentColor"/></svg>`;

function injectHead(html, headMeta) {
  return html.replace("<!--SSR_HEAD-->", headMeta).replace(/<!--SSR_HEAD-->/g, "");
}

function injectSupabaseConfig(html) {
  const script = `
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script>
  window.SUPABASE_URL=${JSON.stringify(config.supabase.url || "")};
  window.SUPABASE_ANON_KEY=${JSON.stringify(config.supabase.anonKey || "")};
  window.supabaseClient = (window.SUPABASE_URL && window.SUPABASE_ANON_KEY)
    ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
    : null;
</script>
<script src="/js/site.js"></script>`;
  return html.replace("</head>", `${script}\n</head>`);
}

function productCardHtml(product) {
  const variant = product.product_variants?.[0];
  const image = product.product_images?.[0]?.url;
  const stars = "★".repeat(Math.round(product.avg_rating)) + "☆".repeat(5 - Math.round(product.avg_rating));
  const bullets = parseListLines(product.short_description).slice(0, 1)[0] || "";
  const inStock = variant ? Number(variant.stock) > 0 : false;
  const off = variant?.mrp && variant.mrp > variant.price ? Math.round((1 - variant.price / variant.mrp) * 100) : 0;
  return `
    <div class="product-card">
      ${off > 0 ? `<span class="pill-badge danger card-badge">${off}% OFF</span>` : ""}
      <button class="wishlist-toggle" data-wishlist-product-id="${product.id}" title="Add to Wishlist">♡</button>
      <div class="img">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(product.title)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;">` : "Product Image"}</div>
      <div class="body">
        <div class="title">${escapeHtml(product.title)}</div>
        <div class="stars">${stars} <span class="reviews">(${product.review_count})</span></div>
        ${bullets ? `<div class="benefits">${escapeHtml(bullets)}</div>` : ""}
        <div class="price-row">
          ${variant ? `<span class="price">${fmtPrice(variant.price)}</span>${variant.mrp && variant.mrp > variant.price ? `<span class="mrp">${fmtPrice(variant.mrp)}</span>` : ""}` : ""}
        </div>
        <div class="stock-row"><span class="stock-dot ${inStock ? "in" : "out"}"></span>${inStock ? "In Stock" : "Out of Stock"}</div>
        <button class="add-btn" onclick="location.href='/product/${escapeHtml(product.slug)}'" ${inStock ? "" : "disabled"}>${inStock ? "View Product" : "Out of Stock"}</button>
      </div>
    </div>`;
}

/** Homepage "From Our Knowledge Hub" teaser - reuses the same
 * published-posts query /blog itself runs, just capped at 3. Real
 * cover images where set, honest "no articles yet" empty state. */
function knowledgeHubCardHtml(post) {
  const img = post.cover_image
    ? `<img src="${escapeHtml(post.cover_image)}" alt="${escapeHtml(post.title)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;">`
    : "";
  return `
    <a class="hub-card" href="/blog/${escapeHtml(post.slug)}">
      <div class="hub-card-img">${img}</div>
      <div class="hub-card-body">
        <h4>${escapeHtml(post.title)}</h4>
        <p>${escapeHtml(truncate(post.excerpt || "", 90))}</p>
        <span class="hub-card-link">Read More →</span>
      </div>
    </a>`;
}

// ============================= HOMEPAGE =============================
router.get("/", trackPageView, async (req, res, next) => {
  try {
    const html = await cached("home", async () => {
      let template = getTemplate("index.html");
      const { items: highlights } = await listPublishedProducts({ page: 1, pageSize: 4, sort: "newest" });
      const { items: bestSellers } = await listPublishedProducts({ page: 1, pageSize: 4, sort: "bestselling" });

      // Phase UI-1: admin-managed hero image (Banners & Media), falling
      // back to the static extracted-asset image when no "home_hero"
      // placement is active - never a broken/blank hero.
      let heroImageUrl = "/img/hero-home-bottles.webp";
      try {
        const { data: heroAsset } = await supabaseAdmin()
          .from("media_assets").select("url").eq("placement", "home_hero").eq("active", true)
          .order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (heroAsset?.url) heroImageUrl = heroAsset.url;
      } catch (e) { /* media_assets migration not applied yet - static fallback stays */ }
      template = template.replace('src="/img/hero-home-bottles.webp"', `src="${escapeHtml(heroImageUrl)}"`);

      const { data: recentPosts } = await supabaseAdmin()
        .from("blog_posts")
        .select("title, slug, excerpt, cover_image, published_at")
        .eq("status", "published")
        .order("published_at", { ascending: false })
        .limit(3);
      template = template.replace(
        "<!--KNOWLEDGE_HUB-->",
        (recentPosts || []).length ? recentPosts.map(knowledgeHubCardHtml).join("") : `<p style="color:#888;">No articles published yet - check back soon.</p>`
      );

      // Phase 0 §3.1 CONFIRMED LIVE BUG: this used to regex-match
      // `<div class="product-grid">[\s\S]*?<\/div>` (non-greedy), which
      // stops at the FIRST `</div>` it finds - but the old placeholder
      // markup inside that grid had nested `<div>`s, so the match closed on
      // a nested child's closing tag instead of the grid's own, leaving the
      // rest of the hardcoded demo cards dangling as broken HTML right
      // after it (reproduced live against the actual DB in Phase 0).
      // Fixed by injecting at dedicated, unambiguous HTML comment markers
      // (public-site/index.html) instead of pattern-matching nested HTML -
      // a marker can never be ambiguous about where it ends.
      template = template.replace("<!--PRODUCT_HIGHLIGHTS-->", highlights.map(productCardHtml).join(""));
      template = template.replace("<!--BEST_SELLERS-->", bestSellers.map(productCardHtml).join(""));

      const [concerns, benefits, productTypes] = await Promise.all([
        listCategories({ type: "concern" }), listCategories({ type: "benefit" }), listCategories({ type: "product_type" }),
      ]);
      template = template.replace("<!--SHOP_CATEGORIES-->", renderCategoryTiles(productTypes));
      template = template.replace("<!--MEGA_CONCERN-->", renderMegaMenu(concerns, "concern"));
      template = template.replace("<!--MEGA_BENEFIT-->", renderMegaMenu(benefits, "benefit"));
      template = template.replace("<!--FOOTER_CATEGORIES-->", renderFooterCategories(concerns, benefits));

      const headMeta = renderHeadMeta({
        title: "AyurNova — Authentic Ayurvedic Supplements Online",
        description: "Scientifically researched, clinically tested Ayurvedic products for immunity, digestion, sleep, skin and overall wellness. Consult a Vaidya, discover your Dosha.",
        url: "/",
      });
      return injectSupabaseConfig(injectHead(template, headMeta));
    });
    res.send(html);
  } catch (e) {
    next(e);
  }
});

// ============================= SHOP LISTING =============================
router.get("/shop", trackPageView, async (req, res, next) => {
  try {
    const { concern, benefit, goal, category } = req.query;
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : undefined;
    // Phase 0 §13: `sort` used to be taken straight from the query string
    // and passed to `.order()` with no validation - a public, unauthenticated
    // endpoint accepting an arbitrary column name. Whitelisted here (falls
    // back to the default silently rather than erroring - this is a public
    // page, not an API, so an unrecognised value should just render
    // sensibly rather than showing an error page).
    const sort = Object.prototype.hasOwnProperty.call(PRODUCT_SORT_MAP, req.query.sort) ? req.query.sort : DEFAULT_PRODUCT_SORT;
    let page = Math.trunc(Number(req.query.page));
    if (!Number.isFinite(page) || page < 1) page = 1;

    // Phase 3: filters/search are genuinely per-request now (previously
    // only concern/benefit varied) - not cached under the shared "home"-style
    // key, since the sidebar/mega-menu content itself (real categories) can
    // also change over time independently of any one visitor's filter choice.
    const cacheKey = `shop:${concern || ""}:${benefit || ""}:${goal || ""}:${category || ""}:${q || ""}:${sort}:${page}`;
    const html = await cached(cacheKey, async () => {
      let template = getTemplate("shop.html");
      const pageSize = 12;
      const { items, total } = q
        ? await searchCatalog({ q, page, pageSize, sort })
        : await listPublishedProducts({ page, pageSize, concern, benefit, goal, categorySlug: category, sort });

      // Same confirmed SSR bug as the homepage (Phase 0 §3.1) - fixed the
      // same way, with a dedicated marker instead of nested-HTML regex.
      const grid = items.length
        ? items.map(productCardHtml).join("")
        : `<p style="grid-column:1/-1; text-align:center; color:#888;">No products found${q ? ` for "${escapeHtml(q)}"` : ""}.</p>`;
      template = template.replace("<!--SHOP_PRODUCTS-->", grid);
      template = template.replace(
        /Showing 1–12 of 86 products/,
        `Showing ${total === 0 ? 0 : (page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total} products${q ? ` for "${escapeHtml(q)}"` : ""}`
      );
      template = template.replace("<!--SHOP_PAGINATION-->", renderPagination({ concern, benefit, goal, category, q, sort }, page, Math.max(1, Math.ceil(total / pageSize))));

      const [concerns, benefits, goals, productTypes] = await Promise.all([
        listCategories({ type: "concern" }), listCategories({ type: "benefit" }),
        listCategories({ type: "goal" }), listCategories({ type: "product_type" }),
      ]);

      // Banner headline: the real matched category/concern/benefit/goal name
      // when one filter is active, a search-results headline for `q`,
      // otherwise the generic "Shop All Products" banner - never an invented
      // category name.
      const activeSlug = category || concern || benefit || goal;
      const activeName = activeSlug
        ? [...productTypes, ...concerns, ...benefits, ...goals].find((c) => c.slug === activeSlug)?.name
        : null;
      const bannerTitle = q ? `Search Results for "${escapeHtml(q)}"` : activeName ? escapeHtml(activeName) : "Shop All Products";
      const bannerSub = q ? "" : activeName ? "Curated Ayurvedic solutions for this category." : "Browse our full range of authentic Ayurvedic wellness products.";
      const crumbLabel = q ? "Search" : activeName ? escapeHtml(activeName) : "Shop All";
      template = template.replace("<!--SHOP_BANNER_TITLE-->", bannerTitle);
      template = template.replace("<!--SHOP_BANNER_SUB-->", bannerSub);
      template = template.replace("<!--SHOP_CRUMB-->", crumbLabel);

      const currentQuery = { concern, benefit, goal, category, q };
      template = template.replace("<!--FILTER_CONCERN-->", renderFilterBlock(concerns, "concern", currentQuery));
      template = template.replace("<!--FILTER_BENEFIT-->", renderFilterBlock(benefits, "benefit", currentQuery));
      template = template.replace("<!--FILTER_GOAL-->", renderFilterBlock(goals, "goal", currentQuery));
      template = template.replace("<!--FILTER_PRODUCT_TYPE-->", renderFilterBlock(productTypes, "category", currentQuery));
      template = template.replace("<!--MEGA_CONCERN-->", renderMegaMenu(concerns, "concern"));
      template = template.replace("<!--MEGA_BENEFIT-->", renderMegaMenu(benefits, "benefit"));
      template = template.replace("<!--FOOTER_CATEGORIES-->", renderFooterCategories(concerns, benefits));

      // Phase 9F (P2-8): previously only reflected the FIRST matching
      // filter in an if/else-if chain that never even checked `category`
      // at all - a category-filtered URL (or any combination of two+
      // filters at once, e.g. ?category=X&concern=Y) canonicalized down
      // to the bare unfiltered /shop, telling crawlers to ignore the
      // filtered page's own distinct content (duplicate-content risk).
      // Now reflects every active filter actually present in the request.
      const canonicalParams = new URLSearchParams();
      if (category) canonicalParams.set("category", category);
      if (concern) canonicalParams.set("concern", concern);
      if (benefit) canonicalParams.set("benefit", benefit);
      if (goal) canonicalParams.set("goal", goal);
      if (q) canonicalParams.set("q", q);
      const canonicalQuery = canonicalParams.toString();
      const headMeta = renderHeadMeta({
        title: q ? `Search: ${q} — AyurNova` : "Shop Ayurvedic Products — AyurNova",
        description: "Browse our full range of Ayurvedic supplements, oils and wellness products by health concern, benefit, goal, and product type.",
        url: `/shop${canonicalQuery ? `?${canonicalQuery}` : ""}`,
        noindex: Boolean(q), // search-results URLs aren't useful landing pages for a crawler
      });
      return injectSupabaseConfig(injectHead(template, headMeta));
    });
    res.send(html);
  } catch (e) {
    next(e);
  }
});

// ============================= PRODUCT DETAIL =============================
router.get("/product/:slug", trackPageView, async (req, res, next) => {
  try {
    const { data: product } = await supabaseAdmin()
      .from("products")
      .select("*, product_variants(*), product_images(*)")
      .eq("slug", req.params.slug)
      .eq("status", "published")
      .maybeSingle();

    if (!product) return res.status(404).send(render404Page());

    const { data: reviews } = await supabaseAdmin()
      .from("reviews").select("*").eq("product_id", product.id).eq("status", "approved").order("created_at", { ascending: false }).limit(10);

    // "You May Also Like" - real products from the same category (never
    // hardcoded demo products). Empty when this item has no category or no
    // other published product shares it - an honest empty section, not a
    // fabricated one.
    let related = [];
    if (product.category_id) {
      const { data: relatedData } = await supabaseAdmin()
        .from("products")
        .select("id, title, slug, avg_rating, review_count, short_description, product_variants(id, label, sku, price, mrp, stock, sort_order), product_images(url, sort_order)")
        .eq("status", "published")
        .eq("category_id", product.category_id)
        .neq("id", product.id)
        .limit(4);
      related = relatedData || [];
    }

    let category = null;
    if (product.category_id) {
      const { data: categoryData } = await supabaseAdmin().from("categories").select("id, name, slug").eq("id", product.category_id).maybeSingle();
      category = categoryData || null;
    }

    let template = getTemplate("product.html");
    const images = (product.product_images || []).sort((a, b) => a.sort_order - b.sort_order);
    const variants = (product.product_variants || []).sort((a, b) => a.sort_order - b.sort_order);
    const mainImage = images[0]?.url;
    const stars = "★".repeat(Math.round(product.avg_rating)) + "☆".repeat(5 - Math.round(product.avg_rating));
    template = template.replace(
      '<nav class="breadcrumbs"><a href="/">Home</a><span class="sep">&rsaquo;</span><a href="/shop">Shop</a><span class="sep">&rsaquo;</span><span class="current pd-crumb-title">Product</span></nav>',
      `<nav class="breadcrumbs"><a href="/">Home</a><span class="sep">&rsaquo;</span><a href="/shop">Shop</a><span class="sep">&rsaquo;</span>${category ? `<a href="/shop?category=${escapeHtml(category.slug)}">${escapeHtml(category.name)}</a><span class="sep">&rsaquo;</span>` : ""}<span class="current pd-crumb-title">${escapeHtml(product.title)}</span></nav>`
    );

    template = template.replace(
      /<div class="gallery-main">[\s\S]*?<\/div>/,
      `<div class="gallery-main">${mainImage ? `<img src="${escapeHtml(mainImage)}" alt="${escapeHtml(product.title)}" style="width:100%;height:100%;object-fit:cover;border-radius:10px;">` : "Main Product Image"}</div>`
    );
    template = template.replace(/<h2 class="pd-title">[\s\S]*?<\/h2>/, `<h2 class="pd-title">${escapeHtml(product.title)}</h2>`);
    template = template.replace(
      /<div class="stars">★★★★★ <span class="reviews">313 reviews<\/span><\/div>/,
      `<div class="stars">${stars} <span class="reviews">${product.review_count} reviews</span></div>`
    );
    template = template.replace(
      /<ul class="pd-benefits">[\s\S]*?<\/ul>/,
      `<ul class="pd-benefits">${parseListLines(product.short_description).map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`
    );
    template = template.replace(
      /<div class="pd-packs">[\s\S]*?<\/div>/,
      `<div class="pd-packs">${variants.map((v, i) => `<span class="pack-pill${i === 0 ? " sel" : ""}" data-variant-id="${v.id}" data-price="${v.price}" data-mrp="${v.mrp || ""}" data-stock="${v.stock}">${escapeHtml(v.label)} — ₹${v.price}</span>`).join("")}</div>`
    );
    template = template.replace(
      /<div class="pd-price-row">[\s\S]*?<\/div>/,
      `<div class="pd-price-row" id="pd-price-row"><span class="pd-price">${variants[0] ? fmtPrice(variants[0].price) : ""}</span></div>`
    );
    template = template.replace(/id="tab-desc"[^>]*>[\s\S]*?<\/div>/, `id="tab-desc" class="pd-tab-content">${escapeHtml(product.description || "")}</div>`);
    template = template.replace(/id="tab-ingredients"[^>]*>[\s\S]*?<\/div>/, `id="tab-ingredients" class="pd-tab-content" style="display:none;">${escapeHtml(product.ingredients || "Not specified.")}</div>`);
    template = template.replace(/id="tab-howto"[^>]*>[\s\S]*?<\/div>/, `id="tab-howto" class="pd-tab-content" style="display:none;">${escapeHtml(product.how_to_use || "As directed by your physician.")}</div>`);

    const reviewsHtml = (reviews || []).length
      ? reviews.map((r) => `<div class="review-item"><div class="stars">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</div><b>${escapeHtml(r.customer_name)}</b> — ${escapeHtml(r.body || "")}</div>`).join("")
      : `<p style="color:#888;">No reviews yet - be the first to review this product.</p>`;
    template = template.replace("<!--PD_REVIEWS-->", reviewsHtml);
    template = template.replace(/Reviews \(313\)/, `Reviews (${product.review_count})`);

    // Phase 3: discovery tags + this product's own FAQs.
    const [relatedIngredients, concerns, benefits, goals] = await Promise.all([
      listRelatedEntities("product_ingredients", "ingredient_id", "ingredients", product.id),
      listRelatedEntities("product_concerns", "concern_id", "categories", product.id),
      listRelatedEntities("product_benefits", "benefit_id", "categories", product.id),
      listRelatedEntities("product_goals", "goal_id", "categories", product.id),
    ]);
    const { data: faqs } = await supabaseAdmin()
      .from("faqs").select("question, answer").eq("product_id", product.id).eq("status", "published").order("sort_order");

    const tagPill = (label, href, name) =>
      `<a href="${href}" style="display:inline-block; background:#f2f5ee; color:#2F5233; border-radius:12px; padding:3px 10px; font-size:11.5px; text-decoration:none;">${escapeHtml(label)}: ${escapeHtml(name)}</a>`;
    const tagsHtml = [
      ...concerns.map((c) => tagPill("Concern", `/concern/${c.slug}`, c.name)),
      ...benefits.map((c) => tagPill("Benefit", `/benefit/${c.slug}`, c.name)),
      ...goals.map((c) => tagPill("Goal", `/goal/${c.slug}`, c.name)),
      ...relatedIngredients.map((i) => tagPill("Ingredient", `/ingredient/${i.slug}`, i.name)),
    ].join(" ");
    template = template.replace('<div id="pd-tags" style="display:flex; flex-wrap:wrap; gap:6px; margin:10px 0;"></div>', `<div id="pd-tags" style="display:flex; flex-wrap:wrap; gap:6px; margin:10px 0;">${tagsHtml}</div>`);

    const faqsHtml = (faqs || []).length
      ? faqs.map((f) => `<div style="margin-bottom:12px;"><b>${escapeHtml(f.question)}</b><p style="margin:4px 0 0; color:#666; font-size:13px;">${escapeHtml(f.answer)}</p></div>`).join("")
      : `<p style="color:#888;">No FAQs for this product yet.</p>`;
    template = template.replace("<!--PD_FAQS-->", faqsHtml);

    template = template.replace(
      "<!--PD_RELATED-->",
      related.length ? related.map(productCardHtml).join("") : `<p style="color:#888;">No related products yet.</p>`
    );

    const [footerConcerns, footerBenefits] = await Promise.all([listCategories({ type: "concern" }), listCategories({ type: "benefit" })]);
    template = template.replace("<!--FOOTER_CATEGORIES-->", renderFooterCategories(footerConcerns, footerBenefits));

    // Bake product+variants JSON in for the client-side pack-selector/add-to-cart script.
    const productJson = JSON.stringify({
      id: product.id, title: product.title, slug: product.slug,
      variants: variants.map((v) => ({ id: v.id, label: v.label, price: v.price, mrp: v.mrp, stock: v.stock })),
    });
    template = template.replace("</head>", `<script>window.__PRODUCT__ = ${productJson};</script>\n</head>`);

    const url = `/product/${product.slug}`;
    const headMeta = renderHeadMeta({
      title: product.seo_title || `${product.title} — AyurNova`,
      description: product.seo_description || product.short_description || product.title,
      url, image: mainImage,
    }) + "\n" + renderProductJsonLd(product, variants[0], url) + "\n" + renderBreadcrumbJsonLd([
      { name: "Home", url: "/" }, { name: "Shop", url: "/shop" }, { name: product.title, url },
    ]);

    res.send(injectSupabaseConfig(injectHead(template, headMeta)));
  } catch (e) {
    next(e);
  }
});

// ============================= PHASE 3: DISCOVERY LANDING PAGES =============================
// /concern/:slug, /benefit/:slug, /goal/:slug all share the same shape (a
// categories row + the published products tagged with it) - one handler
// covers all three. /ingredient/:slug is structurally identical but reads
// from the separate `ingredients` table, so it gets its own thin wrapper
// around the same rendering logic.
async function renderDiscoverPage(res, { entity, products, total, page, pageSize, breadcrumbLabel, urlPath }) {
  let template = getTemplate("discover.html");
  const grid = products.length
    ? products.map(productCardHtml).join("")
    : `<p style="grid-column:1/-1; text-align:center; color:#888;">No products tagged with this yet.</p>`;
  template = template.replace("<!--DISCOVER_LABEL-->", escapeHtml(breadcrumbLabel));
  template = template.replace("<!--DISCOVER_TITLE-->", escapeHtml(entity.name));
  template = template.replace("<!--DISCOVER_DESCRIPTION-->", escapeHtml(entity.description || ""));
  template = template.replace("<!--DISCOVER_PRODUCTS-->", grid);

  const [concerns, benefits] = await Promise.all([listCategories({ type: "concern" }), listCategories({ type: "benefit" })]);
  template = template.replace("<!--FOOTER_CATEGORIES-->", renderFooterCategories(concerns, benefits));

  const headMeta = renderHeadMeta({
    title: entity.seo_title || `${entity.name} — AyurNova`,
    description: entity.seo_description || entity.description || `Shop Ayurvedic products for ${entity.name}.`,
    url: urlPath, image: entity.hero_image || undefined,
  }) + "\n" + renderBreadcrumbJsonLd([
    { name: "Home", url: "/" }, { name: "Shop", url: "/shop" }, { name: entity.name, url: urlPath },
  ]);
  res.send(injectSupabaseConfig(injectHead(template, headMeta)));
}

const DISCOVER_TYPES = [
  { prefix: "concern", label: "Concern", filterKey: "concern" },
  { prefix: "benefit", label: "Benefit", filterKey: "benefit" },
  { prefix: "goal", label: "Goal", filterKey: "goal" },
];
for (const { prefix, filterKey } of DISCOVER_TYPES) {
  router.get(`/${prefix}/:slug`, trackPageView, async (req, res, next) => {
    try {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.slug)) return res.status(404).send(render404Page());
      const category = await getCategoryBySlug(req.params.slug);
      if (!category || category.type !== prefix) return res.status(404).send(render404Page());

      const { items, total } = await listPublishedProducts({ page: 1, pageSize: 24, [filterKey]: category.slug });
      await renderDiscoverPage(res, {
        entity: category, products: items, total, page: 1, pageSize: 24,
        breadcrumbLabel: category.name, urlPath: `/${prefix}/${category.slug}`,
      });
    } catch (e) {
      next(e);
    }
  });
}

router.get("/ingredient/:slug", trackPageView, async (req, res, next) => {
  try {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.slug)) return res.status(404).send(render404Page());
    const ingredient = await getIngredientBySlug(req.params.slug);
    if (!ingredient) return res.status(404).send(render404Page());

    const { items, total } = await listPublishedProducts({ page: 1, pageSize: 24, ingredient: ingredient.slug });
    await renderDiscoverPage(res, {
      entity: ingredient, products: items, total, page: 1, pageSize: 24,
      breadcrumbLabel: ingredient.name, urlPath: `/ingredient/${ingredient.slug}`,
    });
  } catch (e) {
    next(e);
  }
});

// ============================= PHASE 3: AYURVEDA KNOWLEDGE HUB (BLOG) =============================
router.get("/blog", trackPageView, async (req, res, next) => {
  try {
    let page = Math.trunc(Number(req.query.page));
    if (!Number.isFinite(page) || page < 1) page = 1;
    const pageSize = 10;
    const { data: posts, count } = await supabaseAdmin()
      .from("blog_posts")
      .select("id, title, slug, excerpt, cover_image, published_at", { count: "exact" })
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);

    let template = getTemplate("blog.html");
    const cardsHtml = (posts || []).length
      ? posts.map((p) => `
        <div class="testimonial-card">
          <div class="name"><a href="/blog/${escapeHtml(p.slug)}">${escapeHtml(p.title)}</a></div>
          <p>${escapeHtml(truncate(p.excerpt || "", 160))}</p>
          <p style="color:#888; font-size:11.5px;">${p.published_at ? new Date(p.published_at).toLocaleDateString("en-IN") : ""}</p>
        </div>`).join("")
      : `<p style="color:#888;">No articles published yet - check back soon.</p>`;
    template = template.replace("<!--BLOG_POSTS-->", cardsHtml);

    const headMeta = renderHeadMeta({
      title: "Ayurveda Knowledge Hub — AyurNova",
      description: "Articles on Ayurvedic ingredients, wellness routines and healthy living.",
      url: "/blog",
    });
    res.send(injectSupabaseConfig(injectHead(template, headMeta)));
  } catch (e) {
    next(e);
  }
});

router.get("/blog/:slug", trackPageView, async (req, res, next) => {
  try {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.slug)) return res.status(404).send(render404Page());
    const { data: post } = await supabaseAdmin()
      .from("blog_posts").select("*").eq("slug", req.params.slug).eq("status", "published").maybeSingle();
    if (!post) return res.status(404).send(render404Page());

    let template = getTemplate("blog-post.html");
    template = template.replace("<!--POST_BREADCRUMB-->", escapeHtml(post.title));
    template = template.replace("<!--POST_TITLE-->", escapeHtml(post.title));
    template = template.replace("<!--POST_DATE-->", post.published_at ? new Date(post.published_at).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" }) : "");
    // `body` is admin-authored plain text (server/src/routes/blog.js sanitizes
    // it on save, same as every other admin text field) - escaped then
    // newline-to-<br> so paragraph breaks the author typed survive, same
    // spirit as parseListLines elsewhere in this file for bullet lists.
    const bodyHtml = escapeHtml(post.body || "").split("\n\n").map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
    template = template.replace("<!--POST_BODY-->", bodyHtml);

    const url = `/blog/${post.slug}`;
    const headMeta = renderHeadMeta({
      title: post.seo_title || `${post.title} — AyurNova`,
      description: post.seo_description || post.excerpt || post.title,
      url, image: post.cover_image || undefined,
    });
    res.send(injectSupabaseConfig(injectHead(template, headMeta)));
  } catch (e) {
    next(e);
  }
});

// ============================= PHASE 3: GLOBAL FAQ PAGE =============================
router.get("/faq", trackPageView, async (req, res, next) => {
  try {
    const html = await cached("faq", async () => {
      const { data: faqs } = await supabaseAdmin()
        .from("faqs").select("question, answer").is("product_id", null).eq("status", "published").order("sort_order");
      let template = getTemplate("faq.html");
      const listHtml = (faqs || []).length
        ? faqs.map((f) => `<div style="margin-bottom:18px; border-bottom:1px solid var(--hairline); padding-bottom:14px;"><h4 style="margin:0 0 6px;">${escapeHtml(f.question)}</h4><p style="margin:0; color:#555;">${escapeHtml(f.answer)}</p></div>`).join("")
        : `<p style="color:#888;">No FAQs published yet.</p>`;
      template = template.replace("<!--FAQ_LIST-->", listHtml);
      const headMeta = renderHeadMeta({
        title: "Frequently Asked Questions — AyurNova",
        description: "Answers to common questions about our Ayurvedic products, orders, shipping and returns.",
        url: "/faq",
      });
      return injectSupabaseConfig(injectHead(template, headMeta));
    });
    res.send(html);
  } catch (e) {
    next(e);
  }
});

// ============================= PHASE 7: LEGAL CMS PAGES =============================
// Exactly four fixed slugs (legal_pages' own check constraint - see
// 0009_phase7_notifications_and_legal_cms.sql), each rendered only when
// status='published' - a draft (including the auto-seeded "DRAFT —
// BUSINESS CONTENT REQUIRED" placeholder rows) 404s exactly like a
// product/blog post that doesn't exist, never leaking draft content to a
// public visitor. content_html is admin-authored rich text, sanitized
// again here (not just trusted from legalAdmin.js's own save-time
// sanitization) before ever reaching a public response.
const LEGAL_SLUGS = ["terms-and-conditions", "privacy-policy", "return-refund-policy", "shipping-policy"];
for (const slug of LEGAL_SLUGS) {
  router.get(`/${slug}`, trackPageView, async (req, res, next) => {
    try {
      // Existence/publish-status is checked OUTSIDE the render cache (not
      // itself cached) specifically so publishing a page takes effect
      // immediately rather than potentially serving a cached 404 for up
      // to ssrCacheTtlMs - the actual rendered HTML is still cached below,
      // same short-TTL convenience every other SSR content page here has.
      const { data: page } = await supabaseAdmin()
        .from("legal_pages").select("title, content_html, updated_at").eq("slug", slug).eq("status", "published").maybeSingle();
      if (!page) return res.status(404).send(render404Page());

      const html = await cached(`legal:${slug}:${page.updated_at}`, async () => {
        let template = getTemplate("legal-page.html");
        template = template.replace(/<!--LEGAL_TITLE-->/g, escapeHtml(page.title));
        template = template.replace("<!--LEGAL_CONTENT-->", sanitizeRichText(page.content_html));
        const headMeta = renderHeadMeta({
          title: `${page.title} — AyurNova`,
          description: page.title,
          url: `/${slug}`,
        });
        return injectSupabaseConfig(injectHead(template, headMeta));
      });
      res.send(html);
    } catch (e) {
      next(e);
    }
  });
}

// ============================= PHASE 4: ROUTINES =============================
router.get("/routines", trackPageView, async (req, res, next) => {
  try {
    const { data: routines } = await supabaseAdmin()
      .from("routine_templates").select("name, slug, description, dosha").eq("status", "published").order("sort_order");
    let template = getTemplate("routines.html");
    const listHtml = (routines || []).length
      ? routines.map((r) => `
        <div class="testimonial-card">
          <div class="name"><a href="/routines/${escapeHtml(r.slug)}">${escapeHtml(r.name)}</a>${r.dosha ? ` <span style="font-size:11px; color:#888; text-transform:capitalize;">(${escapeHtml(r.dosha)})</span>` : ""}</div>
          <p>${escapeHtml(truncate(r.description || "", 140))}</p>
        </div>`).join("")
      : `<p style="color:#888;">No routines published yet - check back soon.</p>`;
    template = template.replace("<!--ROUTINE_LIST-->", listHtml);
    const headMeta = renderHeadMeta({
      title: "Ayurvedic Routines — AyurNova",
      description: "Admin-curated daily Ayurvedic routines for each Dosha.",
      url: "/routines",
    });
    res.send(injectSupabaseConfig(injectHead(template, headMeta)));
  } catch (e) {
    next(e);
  }
});

router.get("/routines/:slug", trackPageView, async (req, res, next) => {
  try {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.slug)) return res.status(404).send(render404Page());
    const { data: routine } = await supabaseAdmin()
      .from("routine_templates")
      .select("id, name, slug, description, dosha, routine_steps(id, step_order, time_of_day, title, instructions)")
      .eq("slug", req.params.slug).eq("status", "published").maybeSingle();
    if (!routine) return res.status(404).send(render404Page());

    let template = getTemplate("routine-detail.html");
    template = template.replace("<!--ROUTINE_BREADCRUMB-->", escapeHtml(routine.name));
    template = template.replace("<!--ROUTINE_NAME-->", escapeHtml(routine.name));
    template = template.replace("<!--ROUTINE_DOSHA-->", routine.dosha ? `For ${escapeHtml(routine.dosha)} Dosha` : "Suits every Dosha");
    template = template.replace("<!--ROUTINE_DESCRIPTION-->", escapeHtml(routine.description || ""));

    const steps = [...(routine.routine_steps || [])].sort((a, b) => a.step_order - b.step_order);
    const stepsHtml = steps.length
      ? steps.map((s) => `
        <div style="border-bottom:1px solid var(--hairline); padding:12px 0;">
          ${s.time_of_day ? `<span style="font-size:11px; text-transform:uppercase; color:#888;">${escapeHtml(s.time_of_day)}</span><br>` : ""}
          <b>${escapeHtml(s.title)}</b>
          ${s.instructions ? `<p style="margin:4px 0 0; color:#666; font-size:13px;">${escapeHtml(s.instructions)}</p>` : ""}
        </div>`).join("")
      : `<p style="color:#888;">No steps added yet.</p>`;
    template = template.replace("<!--ROUTINE_STEPS-->", stepsHtml);

    const url = `/routines/${routine.slug}`;
    const headMeta = renderHeadMeta({
      title: `${routine.name} — AyurNova`,
      description: routine.description || `An Ayurvedic routine${routine.dosha ? ` for ${routine.dosha} Dosha` : ""}.`,
      url,
    });
    res.send(injectSupabaseConfig(injectHead(template, headMeta)));
  } catch (e) {
    next(e);
  }
});

// ============================= STATIC-ISH PAGES =============================
const STATIC_PAGES = {
  "/about": { file: "about.html", title: "About Us — AyurNova", description: "Learn about AyurNova's mission and commitment to authentic Ayurvedic wellness." },
  "/contact": { file: "contact.html", title: "Contact Us — AyurNova", description: "Get in touch with the AyurNova team." },
  "/consult-vaidya": { file: "consult-vaidya.html", title: "Consult a Vaidya — AyurNova", description: "Book a personalised consultation with our expert Ayurvedic Vaidyas." },
  "/dosha-test": { file: "dosha-test.html", title: "Wellness Assessment — AyurNova", description: "Take our free Wellness Assessment to discover your Dosha and get personalized Ayurvedic product recommendations." },
  "/cart": { file: "cart.html", title: "Your Cart — AyurNova", description: "Review your cart and checkout.", noindex: true },
  "/account": { file: "account.html", title: "My Account — AyurNova", description: "Log in or view your orders.", noindex: true },
  "/order-detail": { file: "order-detail.html", title: "Order Detail — AyurNova", description: "View your order details.", noindex: true },
  "/compare": { file: "compare.html", title: "Compare Products — AyurNova", description: "Compare Ayurvedic products side by side.", noindex: true },
  "/for-you": { file: "for-you.html", title: "For You — AyurNova", description: "Personalized Ayurvedic product and routine recommendations based on your Wellness Profile.", noindex: true },
};
for (const [url, meta] of Object.entries(STATIC_PAGES)) {
  router.get(url, trackPageView, async (req, res, next) => {
    try {
      let template = getTemplate(meta.file);
      const headMeta = renderHeadMeta({ title: meta.title, description: meta.description, url, noindex: meta.noindex });
      res.send(injectSupabaseConfig(injectHead(template, headMeta)));
    } catch (e) {
      next(e);
    }
  });
}

// ============================= SITEMAP + ROBOTS =============================
router.get("/sitemap.xml", async (req, res, next) => {
  try {
    const xml = await cached("sitemap", async () => {
      const urls = [
        { loc: "/", priority: "1.0" }, { loc: "/shop", priority: "0.9" },
        { loc: "/about", priority: "0.3" }, { loc: "/contact", priority: "0.3" },
        { loc: "/consult-vaidya", priority: "0.6" }, { loc: "/dosha-test", priority: "0.6" },
        { loc: "/blog", priority: "0.5" }, { loc: "/faq", priority: "0.3" },
      ];
      const { data: products } = await supabaseAdmin().from("products").select("slug, updated_at").eq("status", "published");
      for (const p of products || []) urls.push({ loc: `/product/${p.slug}`, lastmod: p.updated_at, priority: "0.8" });

      // Phase 3: discovery landing pages + Knowledge Hub posts - the whole
      // point of these existing (Phase 0 §13's flagged gap) is that they be
      // real, indexable pages, so they belong in the sitemap same as products.
      const [concerns, benefits, goals] = await Promise.all([
        listCategories({ type: "concern" }), listCategories({ type: "benefit" }), listCategories({ type: "goal" }),
      ]);
      for (const c of concerns) urls.push({ loc: `/concern/${c.slug}`, priority: "0.6" });
      for (const b of benefits) urls.push({ loc: `/benefit/${b.slug}`, priority: "0.6" });
      for (const g of goals) urls.push({ loc: `/goal/${g.slug}`, priority: "0.6" });
      const { data: ingredients } = await supabaseAdmin().from("ingredients").select("slug");
      for (const i of ingredients || []) urls.push({ loc: `/ingredient/${i.slug}`, priority: "0.5" });
      const { data: posts } = await supabaseAdmin().from("blog_posts").select("slug, published_at").eq("status", "published");
      for (const p of posts || []) urls.push({ loc: `/blog/${p.slug}`, lastmod: p.published_at, priority: "0.5" });

      // Phase 4: routine templates - same reasoning as Phase 3's landing
      // pages above, these need to be real indexable pages.
      urls.push({ loc: "/routines", priority: "0.5" });
      const { data: routines } = await supabaseAdmin().from("routine_templates").select("slug").eq("status", "published");
      for (const r of routines || []) urls.push({ loc: `/routines/${r.slug}`, priority: "0.5" });

      const body = urls.map((u) => `
  <url><loc>${config.site.baseUrl}${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ""}<priority>${u.priority}</priority></url>`).join("");
      return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}\n</urlset>`;
    });
    res.type("application/xml").send(xml);
  } catch (e) {
    next(e);
  }
});

router.get("/robots.txt", (req, res) => {
  // Phase 9F (P2-9): /admin was never listed - defense-in-depth only
  // (the admin panel isn't linked from any public page and requires
  // auth regardless), but a stray inbound link or crawler guess should
  // still be told not to index it, same as the other private surfaces.
  res.type("text/plain").send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /cart\nDisallow: /account\nDisallow: /compare\nDisallow: /for-you\nSitemap: ${config.site.baseUrl}/sitemap.xml\n`);
});

// ============================= 404 =============================
export function render404Page() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Page Not Found — AyurNova</title><meta name="robots" content="noindex">
<link rel="stylesheet" href="/css/style.css"></head><body>
<div class="container" style="padding:60px 20px; text-align:center;">
<h1>404 — Page Not Found</h1><p>This product or page may have been removed.</p>
<a href="/" class="pill">Back to Home</a>
</div></body></html>`;
}

export default router;
