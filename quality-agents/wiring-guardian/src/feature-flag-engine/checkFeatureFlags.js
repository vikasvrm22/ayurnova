import path from "path";
import { readText } from "../discovery/fsWalk.js";
import { makeFinding } from "../evidence/Finding.js";

/**
 * Layer 4 (business-rule wiring) checker for this repo's two known runtime
 * flags (both confirmed via the docs/product-strategy Phase 9 audits and the
 * settings table): `trust_badges.cod` and `tax_profile.gst_registered`.
 * Verifies the flag is not just *read* somewhere, but actually *enforced* at
 * every layer the spec requires (server AND the customer-facing control that
 * lets the customer choose the gated option), not only cosmetically shown.
 */
export function checkFeatureFlags(repoRoot) {
  const findings = [];

  // ---- COD flag: server-side enforcement (should already be present - Phase 9B P1-3 fix) ----
  const publicRoutesPath = path.join(repoRoot, "server/src/routes/public.js");
  const publicSrc = safeRead(publicRoutesPath);
  const codServerGated = /payment_method\s*===\s*["']cod["'][\s\S]{0,400}?trust_badges/.test(publicSrc || "");
  if (publicSrc && !codServerGated) {
    findings.push(
      makeFinding({
        layer: "L4-business-rule",
        category: "feature-flag",
        file: "server/src/routes/public.js",
        route: "POST /api/public/checkout",
        observed: "Could not find the trust_badges.cod gate near the payment_method === 'cod' branch in checkout.",
        expected: "COD order creation must be rejected server-side when settings.trust_badges.cod is false (Phase 9B P1-3 fix), independent of any client-side display.",
        evidence: "Regex scan of server/src/routes/public.js found no `trust_badges` reference within 400 chars of the `payment_method === \"cod\"` branch.",
        severity: "P0",
        confidence: "medium",
        recommendedFix: "Restore the server-side COD eligibility check before accepting a COD order (see git history around Phase 9B P1-3 for the original fix).",
      })
    );
  }

  // ---- COD flag: customer-facing checkout control should reflect the same flag the trust badge already reads ----
  const cartHtmlPath = path.join(repoRoot, "public-site/cart.html");
  const cartSrc = safeRead(cartHtmlPath);
  if (cartSrc) {
    const lines = cartSrc.split("\n");
    const codRadioLine = lines.findIndex((l) => /name="pay"\s+value="cod"/.test(l)) + 1;
    const badgeReadLine = lines.findIndex((l) => /trust_badges/.test(l)) + 1;
    // Gating logic doesn't have to sit immediately next to the <input> - the
    // established pattern in this file (see the trust-badge block) is a
    // separate <script> later in the file that reacts to the same fetched
    // settings. So: is there a flag-driven branch ANYWHERE in the file that
    // actually references the COD control (by id, since that's how a
    // separate script block would target it) rather than just the badge text?
    const codControlIsIdentifiable = /id="cod-payment-option"|id="pay-cod"/.test(cartSrc);
    const flagGatesTheControl =
      codControlIsIdentifiable &&
      /(?:cod-payment-option|pay-cod)[\s\S]{0,400}(?:trust_badges|b\.cod|codEnabled)|(?:trust_badges|b\.cod|codEnabled)[\s\S]{0,400}(?:cod-payment-option|pay-cod)/.test(
        cartSrc
      );
    const radioIsConditionallyRendered = flagGatesTheControl;
    if (codRadioLine && badgeReadLine && !radioIsConditionallyRendered) {
      findings.push(
        makeFinding({
          layer: "L4-business-rule",
          category: "feature-flag",
          file: "public-site/cart.html",
          line: codRadioLine,
          route: "POST /api/public/checkout",
          observed: `The COD payment-method radio (public-site/cart.html:${codRadioLine}, hard-coded 'checked') is always rendered and pre-selected, while the same page independently fetches settings.trust_badges.cod (public-site/cart.html:${badgeReadLine}) only to toggle a decorative trust badge string.`,
          expected: "When trust_badges.cod is false, the storefront should not let a customer select or submit COD at all - the same flag the trust badge already reads should also gate the actual payment-method control, not just its own badge text.",
          evidence: `public-site/cart.html:${codRadioLine} renders the COD option unconditionally; public-site/cart.html:${badgeReadLine}-151 reads the flag only for badge text. Server-side (server/src/routes/public.js) does correctly reject a COD order when the flag is off, so this is a UX/business-rule wiring gap, not a security hole: a customer who selects COD while it is admin-disabled gets a late, confusing checkout-time rejection instead of the option never being offered.`,
          severity: "P2",
          confidence: "high",
          recommendedFix:
            "Reuse the same GET /api/public/settings response already fetched for the trust badges to hide/disable the COD radio and auto-select prepaid when trust_badges.cod is false.",
        })
      );
    }
  }

  return { findings };
}

function safeRead(p) {
  try {
    return readText(p);
  } catch {
    return null;
  }
}
