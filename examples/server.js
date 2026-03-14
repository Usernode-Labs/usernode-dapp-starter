#!/usr/bin/env node
/**
 * Combined examples server.
 *
 * Hosts all dapp examples from a single process:
 *   /               — dapp-starter demo (index.html)
 *   /opinion-market — Opinion Market
 *   /falling-sands  — Falling Sands (with server-side WASM + WebSocket streaming)
 *   /last-one-wins  — Last One Wins token game (with server-side payouts)
 *
 * Also provides:
 *   /usernode-bridge.js   — shared bridge
 *   /usernode-usernames.js — shared global usernames module
 *   /__mock/*             — mock transaction endpoints (--local-dev)
 *   /__game/state         — Last One Wins game state API
 *   /explorer-api/*       — explorer proxy
 *   WebSocket             — falling-sands simulation stream
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadEnvFile, handleExplorerProxy, createMockApi, createChainPoller, httpsJson, resolvePath } = require("./lib/dapp-server");

loadEnvFile();
const createEngine = require("./falling-sands/engine");
const createLastOneWins = require("./last-one-wins/game-logic");
const createVoteEncryption = require("./opinion-market/vote-encryption");

// ── CLI flags ────────────────────────────────────────────────────────────────
const LOCAL_DEV = process.argv.includes("--local-dev");
const PORT = parseInt(process.env.PORT, 10) || 8000;

// Falling-sands app pubkey (for chain polling)
const SANDS_APP_PUBKEY = "ut1r96pdaa7h2k4vf62w3w598fyrelv9wru4t53qtgswgfzpsvz77msj588uu";

// ── Static file paths (with fallbacks for local dev vs Docker) ───────────────
const BRIDGE_PATH = resolvePath(path.join(__dirname, "usernode-bridge.js"), path.join(__dirname, "..", "usernode-bridge.js"));
const USERNAMES_PATH = resolvePath(path.join(__dirname, "usernode-usernames.js"), path.join(__dirname, "..", "usernode-usernames.js"));
const INDEX_HTML = resolvePath(path.join(__dirname, "index.html"), path.join(__dirname, "..", "index.html"));
const OPINION_MARKET_HTML = path.join(__dirname, "opinion-market", "opinion-market.html");
const SANDS_HTML = path.join(__dirname, "falling-sands", "index.html");
const LASTWIN_HTML = path.join(__dirname, "last-one-wins", "index.html");

// ── Game config (Last One Wins) ──────────────────────────────────────────────
const LASTWIN_APP_PUBKEY = process.env.APP_PUBKEY || "ut1_lastwin_default_pubkey";
const LASTWIN_APP_SECRET_KEY = process.env.APP_SECRET_KEY || "";
const LASTWIN_NODE_RPC_URL = process.env.NODE_RPC_URL || "https://alpha2.usernodelabs.org";
const LASTWIN_TIMER_MS = parseInt(process.env.TIMER_DURATION_MS, 10) || 86400000;

// ── Opinion Market config ────────────────────────────────────────────────────
const OM_APP_PUBKEY = "ut1zkj9p90e0w0hqsnmr70xmzdcvhrj80upajpw67eywszu2g0qknksl3mlms";
const OM_ADMIN_PUBKEY = process.env.OM_ADMIN_PUBKEY || "";
const OM_VOTE_ENCRYPT_SEED = process.env.VOTE_ENCRYPT_SEED || (LOCAL_DEV ? "dev-seed-do-not-use-in-production" : "");

// ── Mock API ─────────────────────────────────────────────────────────────────
const mockApi = createMockApi({ localDev: LOCAL_DEV });

// ── Falling-sands engine ─────────────────────────────────────────────────────
const engine = createEngine({ wasmLoaderPath: require.resolve("./falling-sands/wasm-loader") });

// Poll mock transactions for falling-sands drawings
setInterval(() => engine.processMockTransactions(mockApi.transactions), 500);

// ── Chain polling for falling-sands ──────────────────────────────────────────
const sandsPoller = createChainPoller({
  appPubkey: SANDS_APP_PUBKEY,
  queryField: "recipient",
  onTransaction(tx) {
    if (!tx.memo) return;
    try {
      const memo = typeof tx.memo === "string" ? JSON.parse(tx.memo) : tx.memo;
      const from = (tx.source || tx.from_pubkey || tx.from || "unknown").slice(0, 16);
      const txId = tx.tx_id || tx.id || tx.txid || tx.hash || tx.tx_hash || "";
      engine.applyDrawMemo(memo, `${from}… (${txId.slice(0, 8)}…)`);
    } catch (e) { console.warn("[sands] failed to apply tx memo:", e.message); }
  },
});
if (!LOCAL_DEV) sandsPoller.start();

// ── Opinion Market vote encryption ───────────────────────────────────────────
const voteEncryption = createVoteEncryption({
  seed: OM_VOTE_ENCRYPT_SEED,
  appPubkey: OM_APP_PUBKEY,
  senderPubkey: LASTWIN_APP_PUBKEY,
  senderSecretKey: LASTWIN_APP_SECRET_KEY,
  nodeRpcUrl: LASTWIN_NODE_RPC_URL,
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
});
voteEncryption.start();

const omPoller = createChainPoller({
  appPubkey: OM_APP_PUBKEY,
  queryField: "recipient",
  onTransaction: voteEncryption.processTransaction,
});
if (!LOCAL_DEV) omPoller.start();

// ── Last One Wins game ──────────────────────────────────────────────────────
const lastOneWins = createLastOneWins({
  appPubkey: LASTWIN_APP_PUBKEY,
  appSecretKey: LASTWIN_APP_SECRET_KEY,
  nodeRpcUrl: LASTWIN_NODE_RPC_URL,
  timerDurationMs: LASTWIN_TIMER_MS,
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
});
lastOneWins.start();

const lastwinEntryPoller = createChainPoller({
  appPubkey: LASTWIN_APP_PUBKEY,
  queryField: "recipient",
  onTransaction: lastOneWins.processTransaction,
});
const lastwinPayoutPoller = createChainPoller({
  appPubkey: LASTWIN_APP_PUBKEY,
  queryField: "sender",
  onTransaction: lastOneWins.processTransaction,
});
if (!LOCAL_DEV) { lastwinEntryPoller.start(); lastwinPayoutPoller.start(); }

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

  // Shared usernames module
  if (pathname === "/usernode-usernames.js") {
    try {
      const buf = fs.readFileSync(USERNAMES_PATH);
      return send(res, 200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read usernode-usernames.js: " + e.message);
    }
  }

  // Last One Wins game state API
  if (lastOneWins.handleRequest(req, res, pathname)) return;

  // Opinion Market vote encryption pubkey fallback
  if (voteEncryption.handleRequest(req, res, pathname)) return;

  // Mock API
  if (mockApi.handleRequest(req, res, pathname)) return;

  // Opinion Market config (exposes non-secret settings to the client)
  if (pathname === "/__config/opinion-market") {
    return send(res, 200, { "Content-Type": "application/json", "Cache-Control": "no-store" },
      JSON.stringify({ admin_pubkey: OM_ADMIN_PUBKEY || null }));
  }

  // Explorer proxy
  if (handleExplorerProxy(req, res, pathname)) return;

  // Static routes
  const staticRoutes = {
    "/":                 INDEX_HTML,
    "/index.html":       INDEX_HTML,
    "/opinion-market":   OPINION_MARKET_HTML,
    "/opinion-market/":  OPINION_MARKET_HTML,
    "/falling-sands":    SANDS_HTML,
    "/falling-sands/":   SANDS_HTML,
    "/last-one-wins":    LASTWIN_HTML,
    "/last-one-wins/":   LASTWIN_HTML,
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
  console.log(`  /opinion-market — Opinion Market`);
  console.log(`  /falling-sands  — Falling Sands (WASM + WebSocket)`);
  console.log(`  /last-one-wins  — Last One Wins token game`);
  console.log(`  Grid: ${width}x${height}  |  Tick rate: ${tickHz} Hz`);
  console.log(`  Mock API (--local-dev): ${LOCAL_DEV ? "ENABLED" : "disabled"}\n`);
});
