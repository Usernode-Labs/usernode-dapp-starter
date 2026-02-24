/**
 * Shared server utilities for Usernode dapps.
 *
 * Provides: JSON body parsing, HTTPS fetch, explorer proxy, mock transaction
 * API, chain poller, and path resolution. Used by both the combined examples
 * server and standalone sub-app servers.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ── .env loader ─────────────────────────────────────────────────────────────
// Loads KEY=VALUE pairs from a .env file into process.env (does not overwrite
// existing env vars). Zero dependencies.

function loadEnvFile(filePath) {
  if (!filePath) {
    const candidates = [
      path.resolve(process.cwd(), ".env"),
      path.resolve(__dirname, "..", "..", ".env"),
    ];
    filePath = candidates.find((p) => fs.existsSync(p));
  }
  if (!filePath || !fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = val;
  }
}

function getExplorerUpstream() {
  return process.env.EXPLORER_UPSTREAM || "alpha2.usernodelabs.org";
}
function getExplorerUpstreamBase() {
  return process.env.EXPLORER_UPSTREAM_BASE != null
    ? process.env.EXPLORER_UPSTREAM_BASE
    : "/explorer/api";
}

// ── JSON body parser ─────────────────────────────────────────────────────────

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) { reject(new Error("Body too large")); req.destroy(); }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
  });
}

// ── Protocol helper ──────────────────────────────────────────────────────────

function explorerProto(host) {
  return /^(localhost|127\.|192\.|10\.|172\.)/.test(host) ? "http" : "https";
}

function explorerTransport(host) {
  return explorerProto(host) === "https" ? https : http;
}

// ── JSON requester ───────────────────────────────────────────────────────────

function httpsJson(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === "https:" ? https : http;
    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = transport.request(url, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(bodyBuf ? { "content-length": bodyBuf.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── Explorer API proxy ───────────────────────────────────────────────────────
//
// Returns true if the request was handled (pathname starts with /explorer-api/).

function handleExplorerProxy(req, res, pathname, opts) {
  const upstream = (opts && opts.upstream) || getExplorerUpstream();
  const upstreamBase = (opts && opts.upstreamBase) || getExplorerUpstreamBase();
  const prefix = "/explorer-api/";

  if (!pathname.startsWith(prefix)) return false;

  const upstreamPath = upstreamBase + "/" + pathname.slice(prefix.length);
  const proto = explorerProto(upstream);
  const upstreamUrl = new URL(`${proto}://${upstream}${upstreamPath}`);

  void (async () => {
    try {
      let bodyBuf = null;
      if (req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
          if (chunks.reduce((s, c) => s + c.length, 0) > 1_000_000) {
            res.writeHead(413, { "Content-Type": "text/plain" });
            res.end("Body too large");
            return;
          }
        }
        bodyBuf = Buffer.concat(chunks);
      }
      const proxyReq = explorerTransport(upstream).request(upstreamUrl, {
        method: req.method,
        headers: {
          "content-type": req.headers["content-type"] || "application/json",
          accept: "application/json",
          ...(bodyBuf ? { "content-length": bodyBuf.length } : {}),
        },
      }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, {
          "content-type": proxyRes.headers["content-type"] || "application/json",
          "access-control-allow-origin": "*",
        });
        proxyRes.pipe(res);
      });
      proxyReq.on("error", (err) => {
        console.error(`Explorer proxy error: ${err.message}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
      });
      if (bodyBuf) proxyReq.write(bodyBuf);
      proxyReq.end();
    } catch (err) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
    }
  })();

  return true;
}

// ── Mock transaction API ─────────────────────────────────────────────────────
//
// Returns { transactions, handleRequest }.
// handleRequest(req, res, pathname) returns true if handled.

function createMockApi(opts) {
  const localDev = (opts && opts.localDev) || false;
  const delayMs = (opts && opts.delayMs) || 5000;
  const transactions = [];

  function handleRequest(req, res, pathname) {
    if (pathname === "/__mock/enabled") {
      if (!localDev) {
        res.writeHead(404); res.end("Not found");
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ enabled: true }));
      return true;
    }

    if (pathname === "/__mock/sendTransaction" && req.method === "POST") {
      if (!localDev) {
        res.writeHead(404); res.end("Not found (start with --local-dev)");
        return true;
      }
      readJson(req).then((body) => {
        const from_pubkey = String(body.from_pubkey || "").trim();
        const destination_pubkey = String(body.destination_pubkey || "").trim();
        const amount = body.amount;
        const memo = body.memo == null ? undefined : String(body.memo);
        if (!from_pubkey || !destination_pubkey) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "from_pubkey and destination_pubkey required" }));
          return;
        }
        console.log(`[tx] received from=${from_pubkey.slice(0, 16)}… dest=${destination_pubkey.slice(0, 16)}…`);
        const tx = { id: crypto.randomUUID(), from_pubkey, destination_pubkey, amount, memo, created_at: new Date().toISOString() };
        setTimeout(() => { transactions.push(tx); }, delayMs);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ queued: true, tx }));
      }).catch((e) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
      return true;
    }

    if (pathname === "/__mock/getTransactions" && req.method === "POST") {
      if (!localDev) {
        res.writeHead(404); res.end("Not found (start with --local-dev)");
        return true;
      }
      readJson(req).then((body) => {
        const filterOptions = body.filterOptions || {};
        const owner = String(body.owner_pubkey || filterOptions.account || "").trim();
        const limit = typeof filterOptions.limit === "number" ? filterOptions.limit : 50;
        const items = transactions
          .filter((tx) => !owner || tx.from_pubkey === owner || tx.destination_pubkey === owner)
          .slice(-limit).reverse();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ items }));
      }).catch((e) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
      return true;
    }

    return false;
  }

  return { transactions, handleRequest };
}

// ── Chain poller ─────────────────────────────────────────────────────────────
//
// Polls the explorer API for new transactions and calls onTransaction(tx) for
// each unseen one. Returns { start() }.

function createChainPoller(opts) {
  const appPubkey = opts.appPubkey;
  const onTransaction = opts.onTransaction;
  const intervalMs = opts.intervalMs || 3000;
  const upstream = opts.upstream || getExplorerUpstream();
  const upstreamBase = opts.upstreamBase || getExplorerUpstreamBase();
  const queryField = opts.queryField || "account";

  let chainId = null;
  const seenTxIds = new Set();
  let pollCount = 0;

  async function discoverChainId() {
    try {
      const data = await httpsJson("GET", `${explorerProto(upstream)}://${upstream}${upstreamBase}/active_chain`);
      if (data && data.chain_id) {
        chainId = data.chain_id;
        console.log(`[chain] discovered chain_id: ${chainId}`);
      }
    } catch (e) {
      console.warn(`[chain] could not discover chain ID: ${e.message}`);
    }
  }

  async function poll() {
    if (!chainId) { await discoverChainId(); if (!chainId) return; }

    pollCount++;
    const baseUrl = `${explorerProto(upstream)}://${upstream}${upstreamBase}/${chainId}`;
    const url = `${baseUrl}/transactions`;
    const MAX_PAGES = 10;
    let cursor = null, totalItems = 0, totalNew = 0;

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = { [queryField]: appPubkey, limit: 50 };
        if (cursor) body.cursor = cursor;
        const resp = await httpsJson("POST", url, body);

        if (pollCount <= 2 && page === 0) {
          const keys = resp ? Object.keys(resp) : [];
          const firstItem = resp && resp.items && resp.items[0]
            ? JSON.stringify(resp.items[0]).slice(0, 200) : "none";
          console.log(`[chain] poll #${pollCount} keys=[${keys}] first=${firstItem}`);
        }

        const items = Array.isArray(resp) ? resp
          : (resp && Array.isArray(resp.items)) ? resp.items
          : (resp && Array.isArray(resp.transactions)) ? resp.transactions
          : (resp && resp.data && Array.isArray(resp.data.items)) ? resp.data.items
          : [];

        if (items.length === 0) break;
        totalItems += items.length;

        let allSeen = true;
        for (const tx of items) {
          const txId = tx.tx_id || tx.id || tx.txid || tx.hash || tx.tx_hash;
          if (!txId) continue;
          if (seenTxIds.has(txId)) continue;
          allSeen = false;
          seenTxIds.add(txId);
          totalNew++;
          if (onTransaction) onTransaction(tx);
        }

        if (allSeen) break;
        const hasMore = resp && resp.has_more;
        const nextCursor = resp && resp.next_cursor;
        if (!hasMore || !nextCursor) break;
        cursor = nextCursor;
      }

      if (totalNew > 0 || pollCount <= 3) {
        console.log(`[chain] poll #${pollCount}: ${totalItems} tx(s) scanned, ${totalNew} new`);
      }
    } catch (e) {
      console.warn(`[chain] poll #${pollCount} error: ${e.message}`);
    }
  }

  function start() {
    discoverChainId();
    setInterval(poll, intervalMs);
  }

  return { start };
}

// ── Path resolution ──────────────────────────────────────────────────────────

function resolvePath(...candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[candidates.length - 1];
}

module.exports = {
  get EXPLORER_UPSTREAM() { return getExplorerUpstream(); },
  get EXPLORER_UPSTREAM_BASE() { return getExplorerUpstreamBase(); },
  loadEnvFile,
  readJson,
  httpsJson,
  handleExplorerProxy,
  createMockApi,
  createChainPoller,
  resolvePath,
};
