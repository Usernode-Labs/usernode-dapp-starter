#!/usr/bin/env node
/**
 * Minimal image hosting server.
 *
 * POST /upload  — accepts raw image bytes, returns { url } with a permanent link.
 * GET  /images/:filename — serves a stored image.
 *
 * Images are stored on disk under DATA_DIR (default ./data).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// Ensure data directory exists.
fs.mkdirSync(DATA_DIR, { recursive: true });

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function extFromContentType(ct) {
  if (!ct) return ".png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("svg")) return ".svg";
  return ".png";
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  // CORS — allow the dapp to load images.
  res.setHeader("Access-Control-Allow-Origin", "*");

  // POST /upload — store an image
  if (req.method === "POST" && url.pathname === "/upload") {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 10_000_000) {
        req.destroy();
        return send(res, 413, { "content-type": "application/json" }, JSON.stringify({ error: "Too large (10MB max)" }));
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) {
        return send(res, 400, { "content-type": "application/json" }, JSON.stringify({ error: "Empty body" }));
      }
      const ext = extFromContentType(req.headers["content-type"]);
      const name = crypto.randomUUID() + ext;
      const filePath = path.join(DATA_DIR, name);
      fs.writeFile(filePath, buf, (err) => {
        if (err) {
          return send(res, 500, { "content-type": "application/json" }, JSON.stringify({ error: err.message }));
        }
        const imageUrl = `${PUBLIC_URL}/images/${name}`;
        console.log(`📸 Stored ${name} (${buf.length} bytes) → ${imageUrl}`);
        return send(res, 200, { "content-type": "application/json" }, JSON.stringify({ url: imageUrl }));
      });
    });
    return;
  }

  // GET /images/:filename — serve a stored image
  if (req.method === "GET" && url.pathname.startsWith("/images/")) {
    const filename = path.basename(url.pathname);
    const filePath = path.join(DATA_DIR, filename);
    // Prevent path traversal.
    if (!filePath.startsWith(DATA_DIR + path.sep) && filePath !== DATA_DIR) {
      return send(res, 400, { "content-type": "text/plain" }, "Bad Request");
    }
    return fs.readFile(filePath, (err, buf) => {
      if (err) {
        return send(res, 404, { "content-type": "text/plain" }, "Not Found");
      }
      const ext = path.extname(filename).toLowerCase();
      const ct =
        ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
        ext === ".gif" ? "image/gif" :
        ext === ".webp" ? "image/webp" :
        ext === ".svg" ? "image/svg+xml" :
        "image/png";
      return send(res, 200, {
        "content-type": ct,
        "cache-control": "public, max-age=31536000, immutable",
        "content-length": buf.length,
      }, buf);
    });
  }

  // Health check
  if (req.method === "GET" && url.pathname === "/") {
    return send(res, 200, { "content-type": "text/plain" }, "image-store ok");
  }

  return send(res, 404, { "content-type": "text/plain" }, "Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🖼️  Image store listening on ${PUBLIC_URL}`);
  console.log(`   Data dir: ${DATA_DIR}`);
});
