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
const { handleExplorerProxy, createMockApi, createAppStateCache, fetchAllTransactions, discoverChainInfo, resolvePath } = require("../lib/dapp-server");
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

// ── Async init (discover chain info, run engine-owned backfill, then wire cache) ──
//
// Falling-sands is the one dapp that does its own backfill outside the
// shared cache helper: the engine consumes `replayTxs` in its constructor
// for windowed deterministic replay against a disk snapshot. After that, the
// generic createAppStateCache takes over for live polling + mock drain. We
// pass `initialLastHeight` and `initialSeenIds` so the live poller picks up
// exactly where the engine's replay ended.
let engine = null;
let engineCache = null;

(async function init() {
  const chainInfo = await discoverChainInfo().catch(() => ({ chainId: null, genesisTimestampMs: null }));

  let replayTxs = [];
  let lastHeight = null;
  let replayIds = [];
  if (!LOCAL_DEV && chainInfo.chainId) {
    const fetched = await fetchAllTransactions({
      chainId: chainInfo.chainId,
      appPubkey: APP_PUBKEY,
      queryField: "recipient",
    });
    replayTxs = fetched.transactions;
    lastHeight = fetched.lastHeight;
    replayIds = fetched.txIds || [];
  }

  const engineOpts = {
    wasmLoaderPath: require.resolve("./wasm-loader"),
    chainId: chainInfo.chainId,
    epoch: chainInfo.genesisTimestampMs,
    replayTxs,
  };
  if (process.env.SNAPSHOT_DIR) {
    const dir = path.resolve(process.env.SNAPSHOT_DIR);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    engineOpts.snapshotDir = dir;
  }

  engine = createEngine(engineOpts);
  engine.attachWebSocket(server);
  await engine.init();
  engine.startTickLoop();

  engineCache = createAppStateCache({
    name: "sands",
    appPubkey: APP_PUBKEY,
    queryFields: ["recipient"],
    intervalMs: 1500,
    backfill: false,                  // engine handles its own (windowed replay)
    initialLastHeight: lastHeight,    // seed live poller from where replay ended
    initialSeenIds: replayIds,
    processTransaction: engine.processChainTransaction,
    handleRequest: engine.handleRequest,
    onChainReset(newId, oldId) {
      console.log(`[sands] chain reset ${oldId} -> ${newId}, resetting engine`);
      engine.reset();
    },
    localDev: LOCAL_DEV,
    mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
  });
  engineCache.start();
})();

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

  // Engine state APIs (snapshot + transactions log) — wired through the
  // shared cache so future engines can opt in by exposing engine.handleRequest.
  if (engineCache && engineCache.handleRequest(req, res, pathname)) return;
  if (!engine && (pathname === "/__sands/snapshot" || pathname === "/__sands/transactions")) {
    return send(res, 503, { "Content-Type": "text/plain" }, "Engine loading...");
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

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\nFalling Sands server running at http://localhost:${PORT}`);

  const nets = require("os").networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        console.log(`   LAN: http://${iface.address}:${PORT}`);
      }
    }
  }

  console.log(`   Mock API (--local-dev): ${LOCAL_DEV ? "ENABLED" : "disabled"}`);
  console.log(`   Clients run WASM locally — server relays transactions + snapshots\n`);
});
