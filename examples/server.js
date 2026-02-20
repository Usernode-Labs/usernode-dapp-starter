#!/usr/bin/env node
/**
 * Combined examples server.
 *
 * Hosts all three dapp examples from a single process:
 *   /               — dapp-starter demo (index.html)
 *   /cis            — Collective Intelligence Service
 *   /falling-sands  — Falling Sands (with server-side WASM + WebSocket streaming)
 *
 * Also provides:
 *   /usernode-bridge.js   — shared bridge
 *   /__mock/*             — mock transaction endpoints (--local-dev)
 *   /explorer-api/*       — explorer proxy
 *   WebSocket             — falling-sands simulation stream
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { handleExplorerProxy, createMockApi, createChainPoller, resolvePath } = require("./lib/dapp-server");
const createEngine = require("./falling-sands/engine");

// ── CLI flags ────────────────────────────────────────────────────────────────
const LOCAL_DEV = process.argv.includes("--local-dev");
const PORT = parseInt(process.env.PORT, 10) || 8000;

// Falling-sands app pubkey (for chain polling)
const SANDS_APP_PUBKEY = "ut1r96pdaa7h2k4vf62w3w598fyrelv9wru4t53qtgswgfzpsvz77msj588uu";

// ── Static file paths (with fallbacks for local dev vs Docker) ───────────────
const BRIDGE_PATH = resolvePath(path.join(__dirname, "usernode-bridge.js"), path.join(__dirname, "..", "usernode-bridge.js"));
const INDEX_HTML = resolvePath(path.join(__dirname, "index.html"), path.join(__dirname, "..", "index.html"));
const CIS_HTML = path.join(__dirname, "cis", "usernode_cis.html");
const SANDS_HTML = path.join(__dirname, "falling-sands", "index.html");

// ── Mock API ─────────────────────────────────────────────────────────────────
const mockApi = createMockApi({ localDev: LOCAL_DEV });

// ── Falling-sands engine ─────────────────────────────────────────────────────
const engine = createEngine({ wasmLoaderPath: require.resolve("./falling-sands/wasm-loader") });

// Poll mock transactions for falling-sands drawings
setInterval(() => engine.processMockTransactions(mockApi.transactions), 500);

// ── Chain polling for falling-sands ──────────────────────────────────────────
const poller = createChainPoller({
  appPubkey: SANDS_APP_PUBKEY,
  onTransaction(tx) {
    if (!tx.memo) return;
    try {
      const memo = typeof tx.memo === "string" ? JSON.parse(tx.memo) : tx.memo;
      const from = (tx.source || tx.from_pubkey || tx.from || "unknown").slice(0, 16);
      const txId = tx.tx_id || tx.id || tx.txid || tx.hash || tx.tx_hash || "";
      engine.applyDrawMemo(memo, `${from}… (${txId.slice(0, 8)}…)`);
    } catch (_) {}
  },
});
poller.start();

// ── HTTP server ──────────────────────────────────────────────────────────────

function send(res, code, headers, body) {
  res.writeHead(code, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  const pathname = (() => {
    try { return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname; }
    catch (_) { return req.url || "/"; }
  })();

  // Shared bridge
  if (pathname === "/usernode-bridge.js") {
    try {
      const buf = fs.readFileSync(BRIDGE_PATH);
      return send(res, 200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read usernode-bridge.js: " + e.message);
    }
  }

  // Mock API
  if (mockApi.handleRequest(req, res, pathname)) return;

  // Explorer proxy
  if (handleExplorerProxy(req, res, pathname)) return;

  // Static routes
  const staticRoutes = {
    "/":               INDEX_HTML,
    "/index.html":     INDEX_HTML,
    "/cis":            CIS_HTML,
    "/cis/":           CIS_HTML,
    "/falling-sands":  SANDS_HTML,
    "/falling-sands/": SANDS_HTML,
  };

  const htmlFile = staticRoutes[pathname];
  if (htmlFile) {
    try {
      const buf = fs.readFileSync(htmlFile);
      return send(res, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read file: " + e.message);
    }
  }

  send(res, 404, { "Content-Type": "text/plain" }, "Not found");
});

// ── WebSocket + tick loop ────────────────────────────────────────────────────
engine.attachWebSocket(server);
engine.startTickLoop();

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  const { width, height, tickHz } = engine.config;
  console.log(`\nCombined examples server running at http://localhost:${PORT}`);
  console.log(`  /               — dapp-starter demo`);
  console.log(`  /cis            — Collective Intelligence Service`);
  console.log(`  /falling-sands  — Falling Sands (WASM + WebSocket)`);
  console.log(`  Grid: ${width}x${height}  |  Tick rate: ${tickHz} Hz`);
  console.log(`  Mock API (--local-dev): ${LOCAL_DEV ? "ENABLED" : "disabled"}\n`);
});
