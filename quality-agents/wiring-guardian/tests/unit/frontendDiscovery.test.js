import fs from "fs";
import path from "path";
import os from "os";
import { discoverFrontend, normalizePath } from "../../src/discovery/frontendDiscovery.js";
import { assert, assertEqual } from "../helpers.js";

export default async function () {
  assertEqual(normalizePath("/products/${id}"), "/products/:param", "template interpolation normalizes to :param");
  assertEqual(normalizePath("/orders?status=pending"), "/orders", "query string is stripped");
  assertEqual(normalizePath("/staff/"), "/staff", "trailing slash stripped (but not for bare '/')");
  assertEqual(normalizePath("/"), "/", "bare root path is preserved");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wg-frontend-test-"));
  fs.mkdirSync(path.join(tmpRoot, "admin", "js"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "public-site", "js"), { recursive: true });

  fs.writeFileSync(
    path.join(tmpRoot, "admin", "users.html"),
    `<script>
      Api.get("/staff");
      Api.put(\`/staff/\${id}\`, { role });
      fetch("/api/admin/custom-report", { method: "POST" });
    </script>`,
    "utf8"
  );
  fs.writeFileSync(path.join(tmpRoot, "admin", "js", "api.js"), `window.Api = { get: (p) => fetch(\`/api/admin\${p}\`) };`, "utf8");
  fs.writeFileSync(
    path.join(tmpRoot, "public-site", "cart.html"),
    `<script>
      apiGet("/api/public/wishlist");
      fetch("/api/public/settings");
    </script>`,
    "utf8"
  );

  const { calls } = discoverFrontend(tmpRoot);

  assert(calls.some((c) => c.method === "GET" && c.fullPath === "/api/admin/staff"), "admin Api.get() call discovered with /api/admin prefix");
  assert(calls.some((c) => c.method === "PUT" && c.fullPath === "/api/admin/staff/:param"), "admin Api.put() template literal normalized");
  assert(calls.some((c) => c.method === "POST" && c.fullPath === "/api/admin/custom-report"), "raw fetch() with explicit method captured");
  assert(calls.some((c) => c.method === "GET" && c.fullPath === "/api/public/wishlist"), "public-site apiGet() call discovered");
  assert(calls.some((c) => c.method === "GET" && c.fullPath === "/api/public/settings"), "public-site raw fetch() (default GET) discovered");
  assert(!calls.some((c) => c.file.endsWith("admin/js/api.js")), "the wrapper definition file itself is not scanned as a call site");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  return { callsFound: calls.length };
}
