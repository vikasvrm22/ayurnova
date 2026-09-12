import { Router } from "express";
import { config } from "../config.js";
import { supabaseAdmin } from "../db/supabaseClient.js";
import { getTemplate } from "../seo/templates.js";
import {
  escapeHtml, truncate, renderHeadMeta, renderProductJsonLd, renderBreadcrumbJsonLd, parseListLines,
} from "../seo/seoHelpers.js";
import { trackPageView } from "../analytics/tracker.js";
import { listPublishedProducts, getPublishedProductBySlug, PRODUCT_SORT_MAP, DEFAULT_PRODUCT_SORT } from "../services/catalogService.js";

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

function fmtPrice(n) {
  return `₹${Number(n).toLocaleString("en-IN")}`;
}

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
  return `
    <div class="product-card">
      <div class="img">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(product.title)}" style="width:100%;height:100%;object-fit:cover;">` : "Product Image"}</div>
      <div class="body">
        <div class="title">${escapeHtml(product.title)}</div>
        <div class="stars">${stars} <span class="reviews">(${product.review_count})</span></div>
        ${bullets ? `<div class="benefits">${escapeHtml(bullets)}</div>` : ""}
        <div class="price-row">
          ${variant ? `<span class="price">${fmtPrice(variant.price)}</span>${variant.mrp && variant.mrp > variant.price ? `<span class="mrp">${fmtPrice(variant.mrp)}</span>` : ""}` : ""}
        </div>
        <button class="add-btn" onclick="location.href='/product/${escapeHtml(product.slug)}'">View Product</button>
      </div>
    </div>`;
}

// ============================= HOMEPAGE =============================
router.get("/", trackPageView, async (req, res, next) => {
  try {
    const html = await cached("home", async () => {
      let template = getTemplate("index.html");
      const { items: highlights } = await listPublishedProducts({ page: 1, pageSize: 4, sort: "newest" });
      const { items: bestSellers } = await listPublishedProducts({ page: 1, pageSize: 6, sort: "bestselling" });

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

      const headMeta = renderHeadMeta({
        title: "AyurVeda Store — Authentic Ayurvedic Supplements Online",
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
    const { concern, benefit } = req.query;
    // Phase 0 §13: `sort` used to be taken straight from the query string
    // and passed to `.order()` with no validation - a public, unauthenticated
    // endpoint accepting an arbitrary column name. Whitelisted here (falls
    // back to the default silently rather than erroring - this is a public
    // page, not an API, so an unrecognised value should just render
    // sensibly rather than showing an error page).
    const sort = Object.prototype.hasOwnProperty.call(PRODUCT_SORT_MAP, req.query.sort) ? req.query.sort : DEFAULT_PRODUCT_SORT;
    let page = Math.trunc(Number(req.query.page));
    if (!Number.isFinite(page) || page < 1) page = 1;

    const cacheKey = `shop:${concern || ""}:${benefit || ""}:${sort}:${page}`;
    const html = await cached(cacheKey, async () => {
      let template = getTemplate("shop.html");
      const pageSize = 12;
      const { items, total } = await listPublishedProducts({ page, pageSize, concern, benefit, sort });

      // Same confirmed SSR bug as the homepage (Phase 0 §3.1) - fixed the
      // same way, with a dedicated marker instead of nested-HTML regex.
      const grid = items.length
        ? items.map(productCardHtml).join("")
        : `<p style="grid-column:1/-1; text-align:center; color:#888;">No products found.</p>`;
      template = template.replace("<!--SHOP_PRODUCTS-->", grid);
      template = template.replace(
        /Showing 1–12 of 86 products/,
        `Showing ${total === 0 ? 0 : (page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total} products`
      );

      const headMeta = renderHeadMeta({
        title: "Shop Ayurvedic Products — AyurVeda Store",
        description: "Browse our full range of Ayurvedic supplements, oils and wellness products by health concern, benefit, and product type.",
        url: `/shop${concern ? `?concern=${concern}` : benefit ? `?benefit=${benefit}` : ""}`,
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

    let template = getTemplate("product.html");
    const images = (product.product_images || []).sort((a, b) => a.sort_order - b.sort_order);
    const variants = (product.product_variants || []).sort((a, b) => a.sort_order - b.sort_order);
    const mainImage = images[0]?.url;
    const stars = "★".repeat(Math.round(product.avg_rating)) + "☆".repeat(5 - Math.round(product.avg_rating));

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
    template = template.replace(/id="tab-reviews"[^>]*>[\s\S]*?<\/div>\s*<\/div>/, `id="tab-reviews" class="pd-tab-content" style="display:none;">${reviewsHtml}</div></div>`);
    template = template.replace(/Reviews \(313\)/, `Reviews (${product.review_count})`);

    // Bake product+variants JSON in for the client-side pack-selector/add-to-cart script.
    const productJson = JSON.stringify({
      id: product.id, title: product.title, slug: product.slug,
      variants: variants.map((v) => ({ id: v.id, label: v.label, price: v.price, mrp: v.mrp, stock: v.stock })),
    });
    template = template.replace("</head>", `<script>window.__PRODUCT__ = ${productJson};</script>\n</head>`);

    const url = `/product/${product.slug}`;
    const headMeta = renderHeadMeta({
      title: product.seo_title || `${product.title} — AyurVeda Store`,
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

// ============================= STATIC-ISH PAGES =============================
const STATIC_PAGES = {
  "/about": { file: "about.html", title: "About Us — AyurVeda Store", description: "Learn about AyurVeda Store's mission and commitment to authentic Ayurvedic wellness." },
  "/contact": { file: "contact.html", title: "Contact Us — AyurVeda Store", description: "Get in touch with the AyurVeda Store team." },
  "/consult-vaidya": { file: "consult-vaidya.html", title: "Consult a Vaidya — AyurVeda Store", description: "Book a personalised consultation with our expert Ayurvedic Vaidyas." },
  "/dosha-test": { file: "dosha-test.html", title: "Discover Your Dosha — AyurVeda Store", description: "Take our free Dosha quiz to find your Ayurvedic body type: Vata, Pitta or Kapha." },
  "/cart": { file: "cart.html", title: "Your Cart — AyurVeda Store", description: "Review your cart and checkout.", noindex: true },
  "/account": { file: "account.html", title: "My Account — AyurVeda Store", description: "Log in or view your orders.", noindex: true },
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
      ];
      const { data: products } = await supabaseAdmin().from("products").select("slug, updated_at").eq("status", "published");
      for (const p of products || []) urls.push({ loc: `/product/${p.slug}`, lastmod: p.updated_at, priority: "0.8" });
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
  res.type("text/plain").send(`User-agent: *\nAllow: /\nDisallow: /cart\nDisallow: /account\nSitemap: ${config.site.baseUrl}/sitemap.xml\n`);
});

// ============================= 404 =============================
export function render404Page() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Page Not Found — AyurVeda Store</title><meta name="robots" content="noindex">
<link rel="stylesheet" href="/css/style.css"></head><body>
<div class="container" style="padding:60px 20px; text-align:center;">
<h1>404 — Page Not Found</h1><p>This product or page may have been removed.</p>
<a href="/" class="pill">Back to Home</a>
</div></body></html>`;
}

export default router;
