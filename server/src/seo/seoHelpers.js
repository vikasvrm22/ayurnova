import { config } from "../config.js";

export function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

export function truncate(str, n) {
  str = str || "";
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

export function parseListLines(text) {
  if (!text) return [];
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function renderHeadMeta({ title, description, url, image, noindex = false }) {
  const fullTitle = escapeHtml(title);
  const desc = escapeHtml(truncate(description || "", 160));
  const canonical = `${config.site.baseUrl}${url}`;
  const img = image || `${config.site.baseUrl}/og-default.png`;

  return `
<title>${fullTitle}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${canonical}">
${noindex ? '<meta name="robots" content="noindex, nofollow">' : '<meta name="robots" content="index, follow">'}
<meta property="og:type" content="website">
<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${escapeHtml(img)}">
<meta property="og:site_name" content="${escapeHtml(config.site.name)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${fullTitle}">
<meta name="twitter:description" content="${desc}">`.trim();
}

/** schema.org Product structured data - the main SEO win for an ecommerce
 * catalog (Google Shopping / rich product results: price, availability,
 * rating stars in search results). */
export function renderProductJsonLd(product, variant, url) {
  const images = (product.product_images || []).map((i) => i.url);
  const json = {
    "@context": "https://schema.org/",
    "@type": "Product",
    name: product.title,
    description: product.short_description || product.description || product.title,
    brand: product.brand ? { "@type": "Brand", name: product.brand } : undefined,
    image: images.length ? images : undefined,
    sku: variant?.sku || undefined,
    offers: variant
      ? {
          "@type": "Offer",
          url: `${config.site.baseUrl}${url}`,
          priceCurrency: "INR",
          price: variant.price,
          availability: variant.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        }
      : undefined,
    aggregateRating: product.review_count > 0
      ? { "@type": "AggregateRating", ratingValue: product.avg_rating, reviewCount: product.review_count }
      : undefined,
  };
  return `<script type="application/ld+json">${JSON.stringify(json)}</script>`;
}

export function renderBreadcrumbJsonLd(items) {
  const json = {
    "@context": "https://schema.org/",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${config.site.baseUrl}${item.url}`,
    })),
  };
  return `<script type="application/ld+json">${JSON.stringify(json)}</script>`;
}
