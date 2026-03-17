#!/usr/bin/env node
/**
 * Combined examples server.
 *
 * Hosts all dapp examples from a single process:
 *   /               — dapp-starter demo (index.html)
 *   /opinion-market — Opinion Market
 *   /falling-sands  — Falling Sands (client-side WASM + server snapshot/relay)
 *   /last-one-wins  — Last One Wins token game (with server-side payouts)
 *
 * Also provides:
 *   /usernode-bridge.js   — shared bridge
 *   /usernode-usernames.js — shared global usernames module
 *   /__mock/*             — mock transaction endpoints (--local-dev)
 *   /__game/state         — Last One Wins game state API
 *   /explorer-api/*       — explorer proxy
 *   WebSocket             — falling-sands transaction relay
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadEnvFile, handleExplorerProxy, createMockApi, createChainPoller, fetchAllTransactions, fetchGenesisAccounts, discoverChainInfo, httpsJson, resolvePath } = require("./lib/dapp-server");

loadEnvFile();
const createEngine = require("./falling-sands/engine");
const createLastOneWins = require("./last-one-wins/game-logic");
const createVoteEncryption = require("./opinion-market/vote-encryption");

// ── CLI flags ────────────────────────────────────────────────────────────────
const LOCAL_DEV = process.argv.includes("--local-dev");
const OM_TEST_MARKET = process.argv.includes("-omt");
const PORT = parseInt(process.env.PORT, 10) || 8000;

// -t N or --tx-delay N: transaction delay in seconds (mock API)
let TX_DELAY_MS = null;
for (let i = 0; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "-t" || arg === "--tx-delay") {
    const val = parseInt(process.argv[i + 1], 10);
    if (Number.isFinite(val) && val >= 0) TX_DELAY_MS = val * 1000;
    break;
  }
  if (arg.startsWith("-t") && arg.length > 2) {
    const val = parseInt(arg.slice(2), 10);
    if (Number.isFinite(val) && val >= 0) TX_DELAY_MS = val * 1000;
    break;
  }
}

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

// Genesis accounts (fetched once on startup; empty in local-dev)
let omGenesisAccounts = [];
if (!LOCAL_DEV) {
  fetchGenesisAccounts().then(accounts => {
    omGenesisAccounts = accounts;
    console.log(`[om] genesis accounts loaded: ${accounts.length}`);
  }).catch(e => {
    console.warn(`[om] failed to load genesis accounts: ${e.message}`);
  });
}

// ── Mock API ─────────────────────────────────────────────────────────────────
const mockApi = createMockApi({
  localDev: LOCAL_DEV,
  delayMs: TX_DELAY_MS ?? 5000,
  delayOverrides: TX_DELAY_MS == null ? { [SANDS_APP_PUBKEY]: 3000 } : {},
});

// ── Seed test market for Opinion Market (--local-dev -omt) ───────────────────
if (LOCAL_DEV && OM_TEST_MARKET) {
  const crypto = require("crypto");
  const TEST_USER = "ut1_omt_test_user_000000000000000000000000000000000000000000000000";
  const now = new Date();
  const surveyTx = {
    id: crypto.randomUUID(),
    from_pubkey: TEST_USER,
    destination_pubkey: OM_APP_PUBKEY,
    amount: 1,
    memo: JSON.stringify({
      app: "opinion-market",
      type: "create_survey",
      survey: {
        id: "test-market",
        title: "Test Market",
        question: "Which option will win?",
        active_duration_ms: 86400000,
        options: [
          { key: "yes", label: "Yes" },
          { key: "no", label: "No" },
          { key: "maybe", label: "Maybe" },
        ],
      },
    }),
    created_at: new Date(now.getTime() - 1000).toISOString(),
  };
  mockApi.transactions.push(surveyTx);
  console.log("[omt] Injected test market: \"Test Market\" (3 options, 24h) from", TEST_USER.slice(0, 20) + "…");
}

// ── Falling-sands engine (async init — discovers chain genesis) ──────────────
let engine = null;

(async function initEngine() {
  const chainInfo = await discoverChainInfo().catch(() => ({ chainId: null, genesisTimestampMs: null }));

  let replayTxs = [];
  let lastHeight = null;
  let replayTxIds = [];
  if (!LOCAL_DEV && chainInfo.chainId) {
    const fetched = await fetchAllTransactions({
      chainId: chainInfo.chainId,
      appPubkey: SANDS_APP_PUBKEY,
      queryField: "recipient",
    });
    replayTxs = fetched.transactions;
    lastHeight = fetched.lastHeight;
    replayTxIds = fetched.txIds || [];
  }

  engine = createEngine({
    wasmLoaderPath: require.resolve("./falling-sands/wasm-loader"),
    chainId: chainInfo.chainId,
    epoch: chainInfo.genesisTimestampMs,
    replayTxs,
  });

  setInterval(() => engine.processMockTransactions(mockApi.transactions), 500);

  engine.attachWebSocket(server);
  engine.startTickLoop();

  if (!LOCAL_DEV) {
    if (lastHeight != null) sandsPoller.setInitialLastHeight(lastHeight);
    sandsPoller.addSeenIds(replayTxIds);
    sandsPoller.start();
  }
})();

// ── Chain polling for falling-sands ──────────────────────────────────────────
const sandsPoller = createChainPoller({
  appPubkey: SANDS_APP_PUBKEY,
  queryField: "recipient",
  onTransaction(tx) {
    if (!engine || !tx.memo) return;
    try {
      const memo = typeof tx.memo === "string" ? JSON.parse(tx.memo) : tx.memo;
      const timestampMs = tx.timestamp_ms || (tx.created_at ? Date.parse(tx.created_at) : Date.now());
      engine.addTransaction({ timestamp_ms: timestampMs, memo, from: tx.source || tx.from_pubkey || tx.from || "unknown" });
    } catch (e) { console.warn("[sands] failed to apply tx memo:", e.message); }
  },
  onChainReset(newId, oldId) {
    console.log(`[sands] chain reset ${oldId} -> ${newId}, resetting engine`);
    if (engine && engine.universe) engine.universe.reset();
  },
});

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

const omTxCache = [];
const omPoller = createChainPoller({
  appPubkey: OM_APP_PUBKEY,
  queryField: "recipient",
  onTransaction(tx) {
    omTxCache.push(tx);
    voteEncryption.processTransaction(tx);
  },
  onChainReset(newId, oldId) {
    console.log(`[om] chain reset ${oldId} -> ${newId}, clearing tx cache and vote-encryption state`);
    omTxCache.length = 0;
    voteEncryption.reset();
  },
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

function resetLastOneWins(newId, oldId) {
  console.log(`[lastwin] chain reset ${oldId} -> ${newId}, resetting game state`);
  lastOneWins.reset();
}
const lastwinEntryPoller = createChainPoller({
  appPubkey: LASTWIN_APP_PUBKEY,
  queryField: "recipient",
  onTransaction: lastOneWins.processTransaction,
  onChainReset: resetLastOneWins,
});
const lastwinPayoutPoller = createChainPoller({
  appPubkey: LASTWIN_APP_PUBKEY,
  queryField: "sender",
  onTransaction: lastOneWins.processTransaction,
  onChainReset: resetLastOneWins,
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

  // Opinion Market CPMM core
  if (pathname === "/opinion-market/opinion-market-core.js") {
    try {
      const buf = fs.readFileSync(path.join(__dirname, "opinion-market", "opinion-market-core.js"));
      return send(res, 200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read opinion-market-core.js: " + e.message);
    }
  }

  // Falling-sands browser WASM loader
  if (pathname === "/wasm-browser.js" || pathname === "/falling-sands/wasm-browser.js") {
    try {
      const buf = fs.readFileSync(path.join(__dirname, "falling-sands", "wasm-browser.js"));
      return send(res, 200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read wasm-browser.js: " + e.message);
    }
  }

  // Falling-sands WASM binary
  if (pathname === "/sandtable_bg.wasm" || pathname === "/falling-sands/sandtable_bg.wasm") {
    try {
      const buf = fs.readFileSync(path.join(__dirname, "falling-sands", "sandspiel", "crate", "pkg", "sandtable_bg.wasm"));
      return send(res, 200, { "Content-Type": "application/wasm", "Cache-Control": "public, max-age=86400" }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read WASM: " + e.message);
    }
  }

  // Falling-sands snapshot and transactions APIs
  if (pathname === "/__sands/snapshot") {
    if (!engine) return send(res, 503, { "Content-Type": "text/plain" }, "Engine loading...");
    return engine.handleSnapshotRequest(req, res);
  }
  if (pathname === "/__sands/transactions") {
    if (!engine) return send(res, 503, { "Content-Type": "text/plain" }, "Engine loading...");
    return engine.handleTransactionsRequest(req, res);
  }

  // Last One Wins game state API
  if (lastOneWins.handleRequest(req, res, pathname)) return;

  // Opinion Market vote encryption pubkey fallback
  if (voteEncryption.handleRequest(req, res, pathname)) return;

  // Opinion Market cached transactions
  if (pathname === "/opinion-market/api/transactions" && (req.method === "GET" || req.method === "HEAD")) {
    const body = JSON.stringify({ items: omTxCache });
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
      return res.end();
    }
    return send(res, 200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body);
  }

  // Mock API
  if (mockApi.handleRequest(req, res, pathname)) return;

  // Opinion Market config (exposes non-secret settings to the client)
  if (pathname === "/__config/opinion-market") {
    return send(res, 200, { "Content-Type": "application/json", "Cache-Control": "no-store" },
      JSON.stringify({
        admin_pubkey: OM_ADMIN_PUBKEY || null,
        genesis_accounts: omGenesisAccounts,
      }));
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

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\nCombined examples server running at http://localhost:${PORT}`);
  console.log(`  /               — dapp-starter demo`);
  console.log(`  /opinion-market — Opinion Market`);
  console.log(`  /falling-sands  — Falling Sands (client-side WASM + server relay)`);
  console.log(`  /last-one-wins  — Last One Wins token game`);
  console.log(`  Mock API (--local-dev): ${LOCAL_DEV ? "ENABLED" : "disabled"}`);
  if (LOCAL_DEV && TX_DELAY_MS != null) {
    console.log(`  Mock tx delay: ${TX_DELAY_MS / 1000}s (-t / --tx-delay)`);
  }
  if (LOCAL_DEV && OM_TEST_MARKET) {
    console.log(`  Opinion Market test market: INJECTED (-omt)`);
  }
  console.log("");
});
