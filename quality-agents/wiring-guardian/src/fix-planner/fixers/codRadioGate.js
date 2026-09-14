/** Safe auto-fix for the "COD radio not gated by trust_badges.cod" finding
 * (checkFeatureFlags.js). Pure string transform on public-site/cart.html:
 *  1. Tags the COD <label> and its <input> with ids so the existing
 *     settings-fetch script (which already reads the same flag for the
 *     trust badge) can target them.
 *  2. Extends that same script to hide the COD option and force-select
 *     prepaid when trust_badges.cod is false - the same source of truth,
 *     the same fetch, no new API call, no payment/business-logic change. */
export function applyCodRadioGate(html) {
  // This file uses CRLF line endings throughout - matched literally below
  // rather than assuming \n, so the fixer works against the real bytes.
  const NL = html.includes("\r\n") ? "\r\n" : "\n";

  const labelBefore = `<label class="payment-method-card">${NL}            <input type="radio" name="pay" value="cod" checked>`;
  const labelAfter = `<label class="payment-method-card" id="cod-payment-option">${NL}            <input type="radio" name="pay" value="cod" id="pay-cod" checked>`;
  if (!html.includes(labelBefore)) {
    throw new Error("codRadioGate fixer: expected COD <label>/<input> markup not found - refusing to guess, file may have changed.");
  }
  let out = html.replace(labelBefore, labelAfter);

  const scriptBefore = `document.getElementById("trust-badges").innerHTML = badges.join(" &nbsp;|&nbsp; ");${NL}  }).catch(() => {});`;
  const scriptAfter =
    `document.getElementById("trust-badges").innerHTML = badges.join(" &nbsp;|&nbsp; ");${NL}` +
    `    if (!b.cod) {${NL}` +
    `      const codOption = document.getElementById("cod-payment-option");${NL}` +
    `      const codRadio = document.getElementById("pay-cod");${NL}` +
    `      const prepaidRadio = document.querySelector('input[name="pay"][value="prepaid"]');${NL}` +
    `      if (codOption) codOption.style.display = "none";${NL}` +
    `      if (codRadio && codRadio.checked && prepaidRadio) { codRadio.checked = false; prepaidRadio.checked = true; }${NL}` +
    `    }${NL}` +
    `  }).catch(() => {});`;
  if (!out.includes(scriptBefore)) {
    throw new Error("codRadioGate fixer: expected trust-badges script block not found - refusing to guess, file may have changed.");
  }
  out = out.replace(scriptBefore, scriptAfter);
  return out;
}
