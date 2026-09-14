// Minimal static file server for serving test fixtures over HTTP (Playwright
// needs a real navigable URL, not file://, for consistent CSP/asset behavior).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".json": "application/json" };

export function startStaticServer(rootDir) {
  const root = path.resolve(rootDir);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const filePath = path.join(root, urlPath === "/" ? "/actual.html" : urlPath);
      if (!filePath.startsWith(root)) { res.writeHead(403); res.end("Forbidden"); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
  });
}
