/**
 * Last One Wins — standalone server.
 *
 * Runs the "Last One Wins" token game: polls the chain for new entries,
 * tracks the countdown timer, and triggers automatic payouts via the node's
 * RPC when the timer expires.
 *
 * Usage:
 *   node server.js              # production mode (connects to real node)
 *   node server.js --local-dev  # enables mock transaction endpoints
 *
 * Environment variables:
 *   PORT             — HTTP port (default 3333)
 *   APP_PUBKEY       — game pot address (required for chain mode)
 *   APP_SECRET_KEY   — secret key for payout signing (required for chain mode)
 *   NODE_RPC_URL     — node RPC base URL (default https://alpha1.usernodelabs.org)
 *   TIMER_DURATION_MS — countdown duration in ms (default 86400000 = 24h)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  loadEnvFile,
  handleExplorerProxy,
  createMockApi,
  createAppStateCache,
  createUsernamesCache,
  createNodeStatusProbe,
  resolvePath,
} = require("../lib/dapp-server");
const createLastOneWins = require("./game-logic");

loadEnvFile();

// ── CLI flags ────────────────────────────────────────────────────────────────
const LOCAL_DEV = process.argv.includes("--local-dev");
const PORT = parseInt(process.env.PORT, 10) || 3333;

// ── Game config ──────────────────────────────────────────────────────────────
const APP_PUBKEY = process.env.APP_PUBKEY || "ut1_lastwin_default_pubkey";
const APP_SECRET_KEY = process.env.APP_SECRET_KEY || "";
const NODE_RPC_URL = process.env.NODE_RPC_URL || "https://alpha1.usernodelabs.org";
const TIMER_DURATION_MS = parseInt(process.env.TIMER_DURATION_MS, 10) || 86400000;

// ── Static file paths ────────────────────────────────────────────────────────
const BRIDGE_PATH = resolvePath(
  path.join(__dirname, "usernode-bridge.js"),
  path.join(__dirname, "..", "..", "usernode-bridge.js"),
);
const LOADING_PATH = resolvePath(
  path.join(__dirname, "usernode-loading.js"),
  path.join(__dirname, "..", "..", "usernode-loading.js"),
);

// ── Mock API ─────────────────────────────────────────────────────────────────
const mockApi = createMockApi({ localDev: LOCAL_DEV });

// ── Game logic ───────────────────────────────────────────────────────────────
const game = createLastOneWins({
  appPubkey: APP_PUBKEY,
  appSecretKey: APP_SECRET_KEY,
  nodeRpcUrl: NODE_RPC_URL,
  timerDurationMs: TIMER_DURATION_MS,
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
});
// game.start() runs the payout timer and any other app-specific tasks; chain
// plumbing and mock-drain are handled by createAppStateCache below.
game.start();

// ── Game state cache (chain backfill + live poll + /__game/state) ────────────
const gameCache = createAppStateCache({
  name: "lastwin",
  appPubkey: APP_PUBKEY,
  queryFields: ["recipient", "sender"],
  processTransaction: game.processTransaction,
  handleRequest: game.handleRequest,
  onChainReset(newId, oldId) {
    console.log(`[lastwin] chain reset ${oldId} -> ${newId}, resetting game state`);
    game.reset();
  },
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
  nodeRpcUrl: NODE_RPC_URL,
});
gameCache.start();

// ── Global usernames cache (chain backfill + live poll + /__usernames/state) ─
const usernamesCache = createUsernamesCache({
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
  nodeRpcUrl: NODE_RPC_URL,
});
usernamesCache.start();

// ── Sidecar /status probe (powers usernode-loading.js overlay) ──────────────
const nodeStatusProbe = createNodeStatusProbe({
  nodeRpcUrl: NODE_RPC_URL,
  localDev: LOCAL_DEV,
});
nodeStatusProbe.start();

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

  // Bridge
  if (pathname === "/usernode-bridge.js") {
    try {
      const buf = fs.readFileSync(BRIDGE_PATH);
      return send(res, 200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read usernode-bridge.js: " + e.message);
    }
  }

  // Node-readiness loader
  if (pathname === "/usernode-loading.js") {
    try {
      const buf = fs.readFileSync(LOADING_PATH);
      return send(res, 200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read usernode-loading.js: " + e.message);
    }
  }

  // Game state API
  if (gameCache.handleRequest(req, res, pathname)) return;

  // Global usernames cache
  if (usernamesCache.handleRequest(req, res, pathname)) return;

  // Sidecar /status probe (cached snapshot for usernode-loading.js)
  if (nodeStatusProbe.handleRequest(req, res, pathname)) return;

  // Mock API
  if (mockApi.handleRequest(req, res, pathname)) return;

  // Explorer proxy
  if (handleExplorerProxy(req, res, pathname)) return;

  // Serve index.html
  if (pathname === "/" || pathname === "/index.html") {
    try {
      const buf = fs.readFileSync(path.join(__dirname, "index.html"));
      return send(res, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read index.html: " + e.message);
    }
  }

  send(res, 404, { "Content-Type": "text/plain" }, "Not found");
});

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  const timerMinutes = Math.round((LOCAL_DEV ? 120000 : TIMER_DURATION_MS) / 60000);
  console.log(`\nLast One Wins server running at http://localhost:${PORT}`);
  console.log(`  App pubkey:    ${APP_PUBKEY.slice(0, 24)}…`);
  console.log(`  Node RPC:      ${NODE_RPC_URL}`);
  console.log(`  Timer:         ${timerMinutes} minutes`);
  console.log(`  Mock API:      ${LOCAL_DEV ? "ENABLED" : "disabled"}`);
  console.log(`  Payouts:       ${APP_SECRET_KEY ? "enabled" : "DISABLED (no APP_SECRET_KEY)"}\n`);
});
