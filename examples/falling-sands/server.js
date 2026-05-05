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
const { handleExplorerProxy, createMockApi, createAppStateCache, createNodeStatusProbe, createDappServerStatus, fetchAllTransactions, discoverChainInfo, resolvePath } = require("../lib/dapp-server");
const createEngine = require("./engine");

// ── CLI flags ────────────────────────────────────────────────────────────────
const LOCAL_DEV = process.argv.includes("--local-dev");
const PORT = parseInt(process.env.PORT, 10) || 3333;
const APP_PUBKEY = "ut1r96pdaa7h2k4vf62w3w598fyrelv9wru4t53qtgswgfzpsvz77msj588uu";

// When set, the engine cache's `recipient` queryField uses the node's
// direct SSE stream + catch-up poll (see createNodeRecentTxStream in
// lib/dapp-server.js) instead of polling the explorer. Backfill stays
// explorer-driven. Requires the node to expose
// `/transactions/by_recipient` + `/transactions/stream` (i.e. started
// with `--enable-recent-tx-stream`).
const NODE_RPC_URL = process.env.NODE_RPC_URL || null;

// Pubkey permitted to issue `{ app: "falling-sands", type: "reset" }`
// memos. Any reset from a different sender is silently ignored (engine.js
// enforces this in both live and replay paths). Unset → no admin and
// the client never shows the reset UI.
const ADMIN_PUBKEY = process.env.SANDS_ADMIN_PUBKEY || null;

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

// ── Sidecar /status probe (powers usernode-loading.js overlay) ──────────────
// Falling-sands' own HTML doesn't show the overlay (its WASM loader already
// gates the page), but the endpoint is still served for any other tooling
// that might consume it.
const nodeStatusProbe = createNodeStatusProbe({
  nodeRpcUrl: NODE_RPC_URL,
  localDev: LOCAL_DEV,
});

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

// Register the sands stream lazily — engineCache is null until the IIFE
// below builds it. Lambda is read fresh on every snapshot, so it returns
// false during replay and tracks real readiness once the cache exists.
nodeStatusProbe.registerStream("sands", () => !!engineCache && engineCache.isStreamReady());
nodeStatusProbe.start();

// ── Aggregated dapp-server status (HTML viewer + SSE) ───────────────────────
const dappServerStatus = createDappServerStatus({
  name: "sands",
  nodeProbe: nodeStatusProbe,
  localDev: LOCAL_DEV,
  port: PORT,
});
// engineCache is created inside the async init() IIFE below. Poll for it
// and register once it exists (cap at 60s — partial status beats spinning).
{
  const start = Date.now();
  const sandsRegPoll = setInterval(() => {
    if (engineCache) {
      dappServerStatus.registerCache(engineCache);
      clearInterval(sandsRegPoll);
    } else if (Date.now() - start > 60000) {
      clearInterval(sandsRegPoll);
      console.warn("[status] sands cache never came up — leaving unregistered");
    }
  }, 500);
  if (sandsRegPoll.unref) sandsRegPoll.unref();
}

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
    adminPubkey: ADMIN_PUBKEY,
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
    nodeRpcUrl: NODE_RPC_URL,
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

  // Serve the WASM binary. Revalidate via ETag (mtime+size) on every load
  // so a stale browser-cached module can't silently drift the client physics
  // away from the server's after a deploy. Same fix as in examples/server.js.
  if (pathname === "/sandtable_bg.wasm") {
    try {
      const stat = fs.statSync(WASM_PATH);
      const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(36)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { "ETag": etag, "Cache-Control": "no-cache" });
        res.end();
        return;
      }
      const buf = fs.readFileSync(WASM_PATH);
      return send(res, 200, {
        "Content-Type": MIME_TYPES[".wasm"],
        "Cache-Control": "no-cache",
        "ETag": etag,
      }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read WASM: " + e.message);
    }
  }

  // Sidecar /status probe (cached snapshot for usernode-loading.js)
  if (nodeStatusProbe.handleRequest(req, res, pathname)) return;

  // Aggregated dapp-server status: /status, /__usernode/status,
  // /__usernode/status/stream
  if (dappServerStatus.handleRequest(req, res, pathname)) return;

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
