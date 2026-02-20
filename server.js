#!/usr/bin/env node
/**
 * Minimal Node server to host index.html on http://localhost:8000
 *
 * Run:
 *   node server.js
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8000;
const INDEX_PATH = path.join(__dirname, "index.html");
const BRIDGE_PATH = path.join(__dirname, "usernode-bridge.js");
const ENABLE_MOCK_API = process.argv.includes("--local-dev");

/** @type {Array<{id:string, from_pubkey:string, destination_pubkey:string, amount:any, memo?:string, created_at:string}>} */
const mockTransactions = [];

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function safeResolveFromRoot(rootDir, urlPathname) {
  // Normalize and prevent path traversal outside rootDir.
  // - strip leading slash
  // - decode URL components best-effort
  const raw = (urlPathname || "/").replace(/^\/+/, "");
  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch (_) {
      return raw;
    }
  })();

  const normalized = path.normalize(decoded);
  const abs = path.resolve(rootDir, normalized);
  const rootAbs = path.resolve(rootDir);
  if (!abs.startsWith(rootAbs + path.sep) && abs !== rootAbs) return null;
  return abs;
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") {
    return send(res, 405, { "content-type": "text/plain" }, "Method Not Allowed");
  }

  const pathname = (() => {
    try {
      return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
        .pathname;
    } catch (_) {
      return req.url || "/";
    }
  })();

  if (pathname === "/usernode-bridge.js") {
    return fs.readFile(BRIDGE_PATH, (err, buf) => {
      if (err) {
        return send(
          res,
          500,
          { "content-type": "text/plain" },
          `Failed to read usernode-bridge.js: ${err.message}\n`
        );
      }

      if (req.method === "HEAD") {
        res.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "content-length": buf.length,
          "cache-control": "no-store",
        });
        return res.end();
      }

      return send(
        res,
        200,
        {
          "content-type": "application/javascript; charset=utf-8",
          "cache-control": "no-store",
        },
        buf
      );
    });
  }

  if (pathname === "/__mock/sendTransaction") {
    if (!ENABLE_MOCK_API) {
      return send(res, 404, { "content-type": "text/plain" }, "Not Found");
    }
    if (req.method !== "POST") {
      return send(
        res,
        405,
        { "content-type": "text/plain" },
        "Method Not Allowed"
      );
    }
    return void readJson(req)
      .then((body) => {
        const from_pubkey = String(body.from_pubkey || "").trim();
        const destination_pubkey = String(body.destination_pubkey || "").trim();
        const amount = body.amount;
        const memo = body.memo == null ? undefined : String(body.memo);

        if (!from_pubkey || !destination_pubkey) {
          return send(
            res,
            400,
            { "content-type": "application/json" },
            JSON.stringify({ error: "from_pubkey and destination_pubkey required" })
          );
        }

        const memoLen = memo != null ? memo.length : 0;
        const memoType = (() => {
          try { const m = JSON.parse(memo); return m && m.type ? m.type : "?"; } catch (_) { return "?"; }
        })();
        if (memoLen > 1024) {
          console.warn(`⚠️  MEMO WARNING: ${memoLen} chars (exceeds 1024) — type=${memoType}, from=${from_pubkey.slice(0, 12)}…`);
        } else {
          console.log(`📝 memo: ${memoLen} chars — type=${memoType}, from=${from_pubkey.slice(0, 12)}…`);
        }

        const tx = {
          id: crypto.randomUUID(),
          from_pubkey,
          destination_pubkey,
          amount,
          memo,
          created_at: new Date().toISOString(),
        };
        // Simulate network / mempool / indexing latency in local-dev mode so dapps
        // can exercise "wait until visible in getTransactions" flows.
        setTimeout(() => {
          mockTransactions.push(tx);
        }, 5000);

        return send(
          res,
          200,
          { "content-type": "application/json" },
          JSON.stringify({ queued: true, tx })
        );
      })
      .catch((e) => {
        return send(
          res,
          400,
          { "content-type": "application/json" },
          JSON.stringify({ error: `Invalid JSON: ${e.message}` })
        );
      });
  }

  if (pathname === "/__mock/getTransactions") {
    if (!ENABLE_MOCK_API) {
      return send(res, 404, { "content-type": "text/plain" }, "Not Found");
    }
    if (req.method !== "POST") {
      return send(
        res,
        405,
        { "content-type": "text/plain" },
        "Method Not Allowed"
      );
    }
    return void readJson(req)
      .then((body) => {
        const filterOptions = body.filterOptions || {};
        const owner_pubkey = String(body.owner_pubkey || filterOptions.account || "").trim();
        const limit =
          typeof filterOptions.limit === "number" ? filterOptions.limit : 50;

        const items = mockTransactions
          .filter((tx) => {
            if (!owner_pubkey) return true;
            return tx.from_pubkey === owner_pubkey || tx.destination_pubkey === owner_pubkey;
          })
          .slice(-limit)
          .reverse();

        return send(
          res,
          200,
          { "content-type": "application/json" },
          JSON.stringify({ items })
        );
      })
      .catch((e) => {
        return send(
          res,
          400,
          { "content-type": "application/json" },
          JSON.stringify({ error: `Invalid JSON: ${e.message}` })
        );
      });
  }

  // ── Explorer API proxy (/explorer-api/*) ──────────────────────────────
  // Proxies requests to the remote block explorer to avoid CORS issues
  // when the page is loaded inside a WebView or from a different origin.
  const EXPLORER_PROXY_PREFIX = "/explorer-api/";
  const EXPLORER_UPSTREAM = "alpha2.usernodelabs.org";
  const EXPLORER_UPSTREAM_BASE = "/explorer/api";

  if (pathname.startsWith(EXPLORER_PROXY_PREFIX)) {
    const upstreamPath =
      EXPLORER_UPSTREAM_BASE + "/" + pathname.slice(EXPLORER_PROXY_PREFIX.length);
    const upstreamUrl = new URL(`https://${EXPLORER_UPSTREAM}${upstreamPath}`);

    return void (async () => {
      try {
        let bodyBuf = null;
        if (req.method === "POST") {
          const chunks = [];
          for await (const chunk of req) {
            chunks.push(chunk);
            if (chunks.reduce((s, c) => s + c.length, 0) > 1_000_000) {
              return send(res, 413, { "content-type": "text/plain" }, "Body too large");
            }
          }
          bodyBuf = Buffer.concat(chunks);
        }

        const proxyReq = https.request(
          upstreamUrl,
          {
            method: req.method,
            headers: {
              "content-type": req.headers["content-type"] || "application/json",
              accept: "application/json",
              ...(bodyBuf ? { "content-length": bodyBuf.length } : {}),
            },
          },
          (proxyRes) => {
            const resHeaders = {
              "content-type": proxyRes.headers["content-type"] || "application/json",
              "access-control-allow-origin": "*",
            };
            res.writeHead(proxyRes.statusCode || 502, resHeaders);
            proxyRes.pipe(res);
          }
        );

        proxyReq.on("error", (err) => {
          console.error(`Explorer proxy error: ${err.message}`);
          send(res, 502, { "content-type": "application/json" },
            JSON.stringify({ error: `Proxy error: ${err.message}` }));
        });

        if (bodyBuf) proxyReq.write(bodyBuf);
        proxyReq.end();
      } catch (err) {
        send(res, 502, { "content-type": "application/json" },
          JSON.stringify({ error: `Proxy error: ${err.message}` }));
      }
    })();
  }

  // Static file serving:
  // - "/" serves index.html
  // - "/foo.html" serves "./foo.html"
  // - "/subdir/" serves "./subdir/index.html" if present
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, { "content-type": "text/plain" }, "Method Not Allowed");
  }

  const rootDir = __dirname;
  let filePath;
  if (pathname === "/" || pathname === "") {
    filePath = INDEX_PATH;
  } else {
    const resolved = safeResolveFromRoot(rootDir, pathname);
    if (!resolved) {
      return send(res, 400, { "content-type": "text/plain" }, "Bad Request");
    }
    filePath = resolved;
  }

  fs.stat(filePath, (stErr, st) => {
    if (stErr) {
      return send(res, 404, { "content-type": "text/plain" }, "Not Found");
    }

    // If a directory is requested, try to serve its index.html.
    if (st.isDirectory()) {
      const dirIndex = path.join(filePath, "index.html");
      return fs.readFile(dirIndex, (dirErr, buf) => {
        if (dirErr) {
          return send(res, 404, { "content-type": "text/plain" }, "Not Found");
        }
        const headers = {
          "content-type": "text/html; charset=utf-8",
          "content-length": buf.length,
          "cache-control": "no-store",
        };
        if (req.method === "HEAD") {
          res.writeHead(200, headers);
          return res.end();
        }
        return send(res, 200, headers, buf);
      });
    }

    return fs.readFile(filePath, (err, buf) => {
      if (err) {
        return send(
          res,
          500,
          { "content-type": "text/plain" },
          `Failed to read file: ${err.message}\n`
        );
      }

      const headers = {
        "content-type": contentTypeFor(filePath),
        "content-length": buf.length,
        "cache-control": "no-store",
      };

      if (req.method === "HEAD") {
        res.writeHead(200, headers);
        return res.end();
      }

      return send(res, 200, headers, buf);
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Serving ${INDEX_PATH}`);
  console.log(`Listening on http://localhost:${PORT}`);
});

