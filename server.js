#!/usr/bin/env node
/**
 * Minimal Node server to host index.html on http://localhost:8000
 *
 * Run:
 *   node server.js
 */

const http = require("http");
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

        const tx = {
          id: crypto.randomUUID(),
          from_pubkey,
          destination_pubkey,
          amount,
          memo,
          created_at: new Date().toISOString(),
        };
        mockTransactions.push(tx);

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
        const owner_pubkey = String(body.owner_pubkey || "").trim();
        const filterOptions = body.filterOptions || {};
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

  fs.readFile(INDEX_PATH, (err, buf) => {
    if (err) {
      return send(
        res,
        500,
        { "content-type": "text/plain" },
        `Failed to read index.html: ${err.message}\n`
      );
    }

    if (req.method === "HEAD") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": buf.length,
        "cache-control": "no-store",
      });
      return res.end();
    }

    return send(
      res,
      200,
      {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
      buf
    );
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Serving ${INDEX_PATH}`);
  console.log(`Listening on http://localhost:${PORT}`);
});

