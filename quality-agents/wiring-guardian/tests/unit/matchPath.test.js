import { pathsMatch } from "../../src/contract-engine/matchPath.js";
import { assert } from "../helpers.js";

export default async function () {
  assert(pathsMatch("/api/admin/products", "/api/admin/products"), "identical literal paths match");
  assert(!pathsMatch("/api/admin/products", "/api/admin/product"), "different segment counts/text must not match");
  assert(pathsMatch("/api/admin/products/:id", "/api/admin/products/:param"), "backend :id vs frontend :param wildcard");
  assert(pathsMatch("/api/admin/products/:id/variants/:variantId", "/api/admin/products/:param/variants/:param"), "multi-segment wildcards");
  assert(!pathsMatch("/api/admin/products/:id", "/api/admin/categories/:param"), "wildcard segment still requires siblings to match");
  assert(pathsMatch("/api/public/settings", "/api/public/settings"), "no-param route matches itself");
  assert(!pathsMatch("/api/public/settings", "/api/public/settings/extra"), "extra trailing segment must not match");
  return { assertions: 7 };
}
