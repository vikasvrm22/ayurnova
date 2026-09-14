/** Compares an Express route path (e.g. "/api/admin/products/:id/variants/:variantId")
 * against a frontend-call path already normalized to use ":param" for every
 * interpolated segment (e.g. "/api/admin/products/:param/variants/:param").
 * A backend ":name" segment matches any frontend segment; a frontend
 * ":param" segment matches any backend segment; otherwise segments must be
 * byte-identical. Trailing slashes are ignored. */
export function pathsMatch(backendPath, frontendPath) {
  const a = splitSegments(backendPath);
  const b = splitSegments(frontendPath);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const segA = a[i];
    const segB = b[i];
    if (segA.startsWith(":") || segB.startsWith(":")) continue;
    if (segA !== segB) return false;
  }
  return true;
}

function splitSegments(p) {
  return p.split("/").filter(Boolean);
}
