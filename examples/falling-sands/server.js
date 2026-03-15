/**
 * Standalone falling-sands server.
 *
 * Runs the sandspiel simulation server-side for snapshot generation, relays
 * transactions to connected browser clients via WebSocket. Clients run the
 * WASM simulation locally for rendering.
 *
 * Usage:
 *   npm install
 *   node server.js              # starts on http://localhost:3333
 *   node server.js --local-dev  # enables mock transaction endpoints
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { handleExplorerProxy, createMockApi, createChainPoller, resolvePath } = require("../lib/dapp-server");
const createEngine = require("./engine");

// ── CLI flags ────────────────────────────────────────────────────────────────
const LOCAL_DEV = process.argv.includes("--local-dev");
const PORT = parseInt(process.env.PORT, 10) || 3333;
const APP_PUBKEY = "ut1r96pdaa7h2k4vf62w3w598fyrelv9wru4t53qtgswgfzpsvz77msj588uu";

// ── Static file paths ────────────────────────────────────────────────────────
const BRIDGE_PATH = resolvePath(
  path.join(__dirname, "usernode-bridge.js"),
  path.join(__dirname, "..", "..", "usernode-bridge.js"),
);

const USERNAMES_PATH = resolvePath(
  path.join(__dirname, "usernode-usernames.js"),
  path.join(__dirname, "..", "..", "usernode-usernames.js"),
);

const WASM_PATH = path.join(__dirname, "sandspiel", "crate", "pkg", "sandtable_bg.wasm");
const WASM_BROWSER_PATH = path.join(__dirname, "wasm-browser.js");

// ── Mock API ─────────────────────────────────────────────────────────────────
const mockApi = createMockApi({ localDev: LOCAL_DEV });

// ── Engine ───────────────────────────────────────────────────────────────────
const engine = createEngine({ wasmLoaderPath: require.resolve("./wasm-loader") });

// Poll mock transactions for drawings
setInterval(() => engine.processMockTransactions(mockApi.transactions), 500);

// ── Chain polling ────────────────────────────────────────────────────────────
const poller = createChainPoller({
  appPubkey: APP_PUBKEY,
  queryField: "recipient",
  onTransaction(tx) {
    if (!tx.memo) return;
    try {
      const memo = typeof tx.memo === "string" ? JSON.parse(tx.memo) : tx.memo;
      const from = (tx.source || tx.from_pubkey || tx.from || "unknown").slice(0, 16);
      const txId = tx.tx_id || tx.id || tx.txid || tx.hash || tx.tx_hash || "";
      engine.applyDrawMemo(memo, `${from}… (${txId.slice(0, 8)}…)`);
      const timestampMs = tx.timestamp_ms || (tx.created_at ? Date.parse(tx.created_at) : Date.now());
      engine.addTransaction({
        timestamp_ms: timestampMs,
        memo,
        from: tx.source || tx.from_pubkey || tx.from || "unknown",
      });
    } catch (e) { console.warn("[sands] failed to apply tx memo:", e.message); }
  },
});
if (!LOCAL_DEV) poller.start();

// ── HTTP server ──────────────────────────────────────────────────────────────

function send(res, code, headers, body) {
  res.writeHead(code, headers);
  res.end(body);
}

const MIME_TYPES = {
  ".js": "application/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".html": "text/html; charset=utf-8",
};

const server = http.createServer((req, res) => {
  const pathname = (() => {
    try { return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname; }
    catch (_) { return req.url || "/"; }
  })();

  // Serve the usernode bridge
  if (pathname === "/usernode-bridge.js") {
    try {
      const buf = fs.readFileSync(BRIDGE_PATH);
      return send(res, 200, { "Content-Type": MIME_TYPES[".js"], "Cache-Control": "no-store" }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read usernode-bridge.js: " + e.message);
    }
  }

  if (pathname === "/usernode-usernames.js") {
    try {
      const buf = fs.readFileSync(USERNAMES_PATH);
      return send(res, 200, { "Content-Type": MIME_TYPES[".js"], "Cache-Control": "no-store" }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read usernode-usernames.js: " + e.message);
    }
  }

  // Serve the browser WASM loader
  if (pathname === "/wasm-browser.js") {
    try {
      const buf = fs.readFileSync(WASM_BROWSER_PATH);
      return send(res, 200, { "Content-Type": MIME_TYPES[".js"], "Cache-Control": "no-store" }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read wasm-browser.js: " + e.message);
    }
  }

  // Serve the WASM binary
  if (pathname === "/sandtable_bg.wasm") {
    try {
      const buf = fs.readFileSync(WASM_PATH);
      return send(res, 200, { "Content-Type": MIME_TYPES[".wasm"], "Cache-Control": "public, max-age=86400" }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read WASM: " + e.message);
    }
  }

  // Snapshot API
  if (pathname === "/__sands/snapshot") {
    return engine.handleSnapshotRequest(req, res);
  }

  // Transactions API
  if (pathname === "/__sands/transactions") {
    return engine.handleTransactionsRequest(req, res);
  }

  // Mock API
  if (mockApi.handleRequest(req, res, pathname)) return;

  // Explorer proxy
  if (handleExplorerProxy(req, res, pathname)) return;

  // Serve index.html
  if (pathname === "/" || pathname === "/index.html") {
    try {
      const buf = fs.readFileSync(path.join(__dirname, "index.html"));
      return send(res, 200, { "Content-Type": MIME_TYPES[".html"], "Cache-Control": "no-store" }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read index.html: " + e.message);
    }
  }

  send(res, 404, { "Content-Type": "text/plain" }, "Not found");
});

// ── WebSocket + tick loop ────────────────────────────────────────────────────
engine.attachWebSocket(server);
engine.startTickLoop();

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  const { width, height, tickHz, epoch } = engine.config;
  console.log(`\nFalling Sands server running at http://localhost:${PORT}`);

  const nets = require("os").networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        console.log(`   LAN: http://${iface.address}:${PORT}`);
      }
    }
  }

  console.log(`   Grid: ${width}x${height}  |  Tick rate: ${tickHz} Hz`);
  console.log(`   Tick epoch: ${new Date(epoch).toISOString()}`);
  console.log(`   Mock API (--local-dev): ${LOCAL_DEV ? "ENABLED" : "disabled"}`);
  console.log(`   Clients run WASM locally — server relays transactions + snapshots\n`);
});
