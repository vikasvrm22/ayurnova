// ============================================================
// 2. ACTUAL UI ANALYZER
// ============================================================
// Drives a real (headed) browser against the implemented page and pulls
// out the structural/visual evidence the Comparator needs: DOM structure,
// bounding boxes, computed styles, text hierarchy, assets, and overflow
// indicators. Never mutates the page beyond navigation/waiting.
const GENERIC_SELECTORS = "h1,h2,h3,h4,h5,h6,button,a,input,select,textarea,nav,header,footer,form,img,[role=button]";

/** Navigates `page` to `url` and returns raw evidence + a PNG screenshot buffer. */
export async function collectEvidence(page, { url, viewport, waitForSelector, scrollToSelector, extraSelectors = [], settleMs = 400 }) {
  // "Failed to load resource: ..." is Chromium's own network-failure log (e.g. a missing
  // favicon.ico every page gets asked for, regardless of the app) - a browser-noise
  // artifact, not an application error. Broken assets are already caught explicitly via
  // evidence.images[].broken; this filter just keeps consoleErrors meaningful.
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(String(err.message || err)));
  page.on("console", (msg) => { if (msg.type() === "error" && !/^Failed to load resource:/.test(msg.text())) consoleErrors.push(msg.text()); });

  await page.setViewportSize(viewport);
  const response = await page.goto(url, { waitUntil: "load", timeout: 30000 }).catch((e) => ({ __navError: String(e.message || e) }));
  const navError = response && response.__navError ? response.__navError : null;
  const httpStatus = response && typeof response.status === "function" ? response.status() : null;

  if (!navError && waitForSelector) {
    await page.waitForSelector(waitForSelector, { timeout: 8000 }).catch(() => {});
  }
  // Lets a page.config.json entry target a sub-section of a shared/long page (e.g. one
  // provider's card on a settings page that has many) instead of always capturing the
  // viewport from y=0 - a URL #fragment alone scrolls inconsistently depending on layout
  // that hasn't finished settling yet, so this explicitly scrolls after everything above.
  if (!navError && scrollToSelector) {
    await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "start" }), scrollToSelector).catch(() => {});
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(settleMs); // let webfonts/late layout shifts settle before measuring

  const screenshotPng = await page.screenshot({ fullPage: false });

  if (navError) {
    return { url, viewport, httpStatus, navError, consoleErrors, screenshotPng, elements: [], images: [], links: [], buttons: [], forms: [], overflow: [], headingOutline: [], selectorMatches: {} };
  }

  const dom = await page.evaluate(({ genericSelectors, extraSelectors }) => {
    const bboxOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const styleOf = (el) => {
      const cs = getComputedStyle(el);
      return {
        color: cs.color, backgroundColor: cs.backgroundColor, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
        fontFamily: cs.fontFamily, borderRadius: cs.borderRadius, boxShadow: cs.boxShadow, textAlign: cs.textAlign,
        display: cs.display, opacity: cs.opacity, visibility: cs.visibility,
      };
    };
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0;
    };

    const elements = [...document.querySelectorAll(genericSelectors)].slice(0, 400).map((el, i) => ({
      index: i, tag: el.tagName.toLowerCase(), id: el.id || null,
      classes: el.className && typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean) : [],
      text: (el.textContent || "").trim().slice(0, 120),
      bbox: bboxOf(el), visible: isVisible(el), style: styleOf(el),
    }));

    const images = [...document.querySelectorAll("img")].map((img) => ({
      src: img.currentSrc || img.src, alt: img.getAttribute("alt"),
      naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
      renderedWidth: Math.round(img.getBoundingClientRect().width), renderedHeight: Math.round(img.getBoundingClientRect().height),
      visible: isVisible(img), broken: img.complete && img.naturalWidth === 0,
    }));

    const links = [...document.querySelectorAll("a")].map((a) => ({
      text: (a.textContent || "").trim().slice(0, 80), href: a.getAttribute("href"), visible: isVisible(a),
    }));

    const buttons = [...document.querySelectorAll("button,[role=button],input[type=submit],input[type=button]")].map((b) => ({
      text: (b.textContent || b.value || "").trim().slice(0, 80),
      disabled: !!b.disabled, visible: isVisible(b),
      // A native <button>'s DOM `.type` defaults to "submit" even with no type
      // attribute at all, so that alone can't mean "wired up" - it only does
      // something if there is actually a form around it to submit/reset.
      hasOnclickAttr: !!(b.onclick || b.getAttribute("onclick")),
      type: b.type || "button",
      insideForm: !!b.closest("form"),
    }));

    const forms = [...document.querySelectorAll("form")].map((f) => ({
      action: f.getAttribute("action"), method: f.getAttribute("method") || "get",
      fields: [...f.querySelectorAll("input,select,textarea")].map((fld) => ({
        name: fld.getAttribute("name") || fld.id || null, type: fld.getAttribute("type") || fld.tagName.toLowerCase(),
        required: !!fld.required,
      })),
    }));

    const overflow = [];
    const de = document.documentElement, body = document.body;
    if (de.scrollWidth - de.clientWidth > 2) overflow.push({ selector: "html", scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, deltaPx: de.scrollWidth - de.clientWidth });
    [...document.querySelectorAll("body *")].slice(0, 1000).forEach((el) => {
      if (el.scrollWidth - el.clientWidth > 4 && isVisible(el)) {
        const sel = el.id ? `#${el.id}` : el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/)[0] : "");
        overflow.push({ selector: sel, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, deltaPx: el.scrollWidth - el.clientWidth });
      }
    });

    const headingOutline = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => ({ tag: h.tagName.toLowerCase(), text: (h.textContent || "").trim().slice(0, 100) }));
    const missingAlt = images.filter((i) => !i.alt && i.visible).length;

    const selectorMatches = {};
    for (const sel of extraSelectors) {
      try {
        const el = document.querySelector(sel);
        selectorMatches[sel] = el ? { found: true, bbox: bboxOf(el), style: styleOf(el), text: (el.textContent || "").trim().slice(0, 120), visible: isVisible(el) } : { found: false };
      } catch {
        selectorMatches[sel] = { found: false, error: "invalid selector" };
      }
    }

    return { elements, images, links, buttons, forms, overflow: overflow.slice(0, 30), headingOutline, missingAlt, selectorMatches, pageWidth: de.scrollWidth, pageHeight: de.scrollHeight, title: document.title };
  }, { genericSelectors: GENERIC_SELECTORS, extraSelectors });

  return { url, viewport, httpStatus, navError: null, consoleErrors, screenshotPng, ...dom };
}
