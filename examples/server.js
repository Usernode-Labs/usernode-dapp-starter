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
const crypto = require("crypto");
const { loadEnvFile, handleExplorerProxy, createMockApi, createAppStateCache, createUsernamesCache, createNodeStatusProbe, fetchAllTransactions, fetchGenesisAccounts, discoverChainInfo, httpsJson, resolvePath } = require("./lib/dapp-server");

loadEnvFile();
const createEngine = require("./falling-sands/engine");
const createLastOneWins = require("./last-one-wins/game-logic");
const createVoteEncryption = require("./opinion-market/vote-encryption");
const createEcho = require("./echo/echo-logic");

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

// Falling-sands app pubkey (for chain polling). Sourced from .env so the
// node sidecar / `make node` can track this same address as a wallet owner —
// without that, the new SSE recent_tx_stream won't buffer events for it.
const SANDS_APP_PUBKEY =
  process.env.SANDS_APP_PUBKEY ||
  "ut1r96pdaa7h2k4vf62w3w598fyrelv9wru4t53qtgswgfzpsvz77msj588uu";

// ── Static file paths (with fallbacks for local dev vs Docker) ───────────────
const BRIDGE_PATH = resolvePath(path.join(__dirname, "usernode-bridge.js"), path.join(__dirname, "..", "usernode-bridge.js"));
const USERNAMES_PATH = resolvePath(path.join(__dirname, "usernode-usernames.js"), path.join(__dirname, "..", "usernode-usernames.js"));
const LOADING_PATH = resolvePath(path.join(__dirname, "usernode-loading.js"), path.join(__dirname, "..", "usernode-loading.js"));
const INDEX_HTML = resolvePath(path.join(__dirname, "index.html"), path.join(__dirname, "..", "index.html"));
const OPINION_MARKET_HTML = path.join(__dirname, "opinion-market", "opinion-market.html");
const SANDS_HTML = path.join(__dirname, "falling-sands", "index.html");
const LASTWIN_HTML = path.join(__dirname, "last-one-wins", "index.html");
const ECHO_HTML = path.join(__dirname, "echo", "index.html");

// ── Build version (per-page) ─────────────────────────────────────────────────
// Hash the HTML file plus the shared bridge files it loads, so any edit to
// the page or to the runtime it pulls in produces a new version. Surfaced
// to clients three ways:
//   1. Substituted into __BUILD_VERSION__ placeholders inside the HTML
//      (used both for ?v=… cache-busters on <script src=…> tags and for a
//      visible "Build XXXXXXXX" footer label so users can confirm at a
//      glance which version they have loaded).
//   2. Echoed in the X-App-Version response header.
//   3. Returned by GET /__build?page=/echo for scripted health checks.
// Hashes are recomputed on each request: they read three small files,
// which is cheap, and it means edits during local-dev are picked up
// without restarting the server.
function buildVersionFor(htmlPath) {
  const hash = crypto.createHash("sha1");
  for (const p of [htmlPath, BRIDGE_PATH, USERNAMES_PATH, LOADING_PATH]) {
    try { hash.update(p).update(fs.readFileSync(p)); } catch (_) {}
  }
  return hash.digest("hex").slice(0, 8);
}

// ── Game config (Last One Wins) ──────────────────────────────────────────────
const LASTWIN_APP_PUBKEY = process.env.APP_PUBKEY || "ut1_lastwin_default_pubkey";
const LASTWIN_APP_SECRET_KEY = process.env.APP_SECRET_KEY || "";
const LASTWIN_NODE_RPC_URL = process.env.NODE_RPC_URL || "https://alpha1.usernodelabs.org";
const LASTWIN_TIMER_MS = parseInt(process.env.TIMER_DURATION_MS, 10) || 86400000;

// ── Opinion Market config ────────────────────────────────────────────────────
// Sourced from .env (same reasoning as SANDS_APP_PUBKEY above).
const OM_APP_PUBKEY =
  process.env.OM_APP_PUBKEY ||
  "ut1zkj9p90e0w0hqsnmr70xmzdcvhrj80upajpw67eywszu2g0qknksl3mlms";
const OM_ADMIN_PUBKEY = process.env.OM_ADMIN_PUBKEY || "";
const OM_VOTE_ENCRYPT_SEED = process.env.VOTE_ENCRYPT_SEED || (LOCAL_DEV ? "dev-seed-do-not-use-in-production" : "");

// ── Echo config (latency-test dapp) ─────────────────────────────────────────
const ECHO_APP_PUBKEY = process.env.ECHO_APP_PUBKEY || "ut1_echo_default_pubkey";
const ECHO_APP_SECRET_KEY = process.env.ECHO_APP_SECRET_KEY || "";
const ECHO_NODE_RPC_URL = process.env.NODE_RPC_URL || "https://alpha1.usernodelabs.org";

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
  const joinTx = {
    id: crypto.randomUUID(),
    from_pubkey: TEST_USER,
    destination_pubkey: OM_APP_PUBKEY,
    amount: 1,
    memo: JSON.stringify({ app: "opinion-market", type: "join" }),
    created_at: new Date(now.getTime() - 2000).toISOString(),
  };
  mockApi.transactions.push(joinTx);
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
        active_duration_ms: 180000,
        allow_custom_options: false,
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
  console.log("[omt] Injected test market: \"Test Market\" (3 options, 3min) from", TEST_USER.slice(0, 20) + "…");
}

// ── Falling-sands engine (async init — discovers chain genesis) ──────────────
//
// Falling-sands is the one dapp that does its own backfill outside the
// shared cache helper: the engine consumes `replayTxs` in its constructor
// for windowed deterministic replay against a disk snapshot. After that, the
// generic createAppStateCache takes over for live polling + mock drain. We
// pass `initialLastHeight` and `initialSeenIds` so the live poller picks up
// exactly where the engine's replay ended.
let engine = null;
let sandsCache = null;

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

  const engineOpts = {
    wasmLoaderPath: require.resolve("./falling-sands/wasm-loader"),
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

  // Attach WebSocket immediately so clients can connect during replay
  // (they receive "loading" messages with progress until replay finishes).
  engine.attachWebSocket(server);

  // Replay is async — yields to the event loop so the server stays responsive.
  await engine.init();
  engine.startTickLoop();

  sandsCache = createAppStateCache({
    name: "sands",
    appPubkey: SANDS_APP_PUBKEY,
    queryFields: ["recipient"],
    intervalMs: 1500,
    backfill: false,                  // engine handles its own (windowed replay)
    initialLastHeight: lastHeight,    // seed live poller from where replay ended
    initialSeenIds: replayTxIds,
    processTransaction: engine.processChainTransaction,
    handleRequest: engine.handleRequest,
    onChainReset(newId, oldId) {
      console.log(`[sands] chain reset ${oldId} -> ${newId}, resetting engine`);
      engine.reset();
    },
    localDev: LOCAL_DEV,
    mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
    nodeRpcUrl: LASTWIN_NODE_RPC_URL,
  });
  sandsCache.start();
})();

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

// Opinion Market raw-tx cache, served at /opinion-market/api/transactions.
// Reads straight off the shared createAppStateCache raw-tx store via
// omCache.getRawTransactions() — no second array. The cache also clears its
// own raw-tx store on chain reset, so we just reset vote-encryption state.
const omCache = createAppStateCache({
  name: "om",
  appPubkey: OM_APP_PUBKEY,
  queryFields: ["recipient"],
  processTransaction: voteEncryption.processTransaction,
  // OM serves /opinion-market/api/transactions and /__om/pubkeys/* — both are
  // routed below in the main HTTP handler since they have OM-specific logic
  // (joins genesis-accounts list, body shape).
  handleRequest: null,
  onChainReset(newId, oldId) {
    console.log(`[om] chain reset ${oldId} -> ${newId}, resetting vote-encryption state`);
    voteEncryption.reset();
  },
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
  nodeRpcUrl: LASTWIN_NODE_RPC_URL,
});
omCache.start();

// ── Last One Wins game ──────────────────────────────────────────────────────
const lastOneWins = createLastOneWins({
  appPubkey: LASTWIN_APP_PUBKEY,
  appSecretKey: LASTWIN_APP_SECRET_KEY,
  nodeRpcUrl: LASTWIN_NODE_RPC_URL,
  timerDurationMs: LASTWIN_TIMER_MS,
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
});
// game.start() runs the payout timer; chain plumbing is in lastwinCache below.
lastOneWins.start();

const lastwinCache = createAppStateCache({
  name: "lastwin",
  appPubkey: LASTWIN_APP_PUBKEY,
  queryFields: ["recipient", "sender"],
  processTransaction: lastOneWins.processTransaction,
  handleRequest: lastOneWins.handleRequest,
  onChainReset(newId, oldId) {
    console.log(`[lastwin] chain reset ${oldId} -> ${newId}, resetting game state`);
    lastOneWins.reset();
  },
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
  nodeRpcUrl: LASTWIN_NODE_RPC_URL,
});
lastwinCache.start();

// ── Echo (latency test) ─────────────────────────────────────────────────────
const echo = createEcho({
  appPubkey: ECHO_APP_PUBKEY,
  appSecretKey: ECHO_APP_SECRET_KEY,
  nodeRpcUrl: ECHO_NODE_RPC_URL,
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
});
// echo.start() runs the sidecar /wallet/signer ensureReady loop; chain
// plumbing is in echoCache below.
echo.start();

const echoCache = createAppStateCache({
  name: "echo",
  appPubkey: ECHO_APP_PUBKEY,
  queryFields: ["recipient", "sender"],
  processTransaction: echo.processTransaction,
  handleRequest: echo.handleRequest,
  onChainReset(newId, oldId) {
    console.log(`[echo] chain reset ${oldId} -> ${newId}, resetting state`);
    echo.reset();
  },
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
  nodeRpcUrl: ECHO_NODE_RPC_URL,
});
echoCache.start();

// ── Global usernames cache (chain backfill + live poll + /__usernames/state) ─
const usernamesCache = createUsernamesCache({
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
  nodeRpcUrl: LASTWIN_NODE_RPC_URL,
});
usernamesCache.start();

// ── Sidecar /status probe (powers usernode-loading.js overlay) ──────────────
const nodeStatusProbe = createNodeStatusProbe({
  nodeRpcUrl: process.env.NODE_RPC_URL,
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

  // Shared node-readiness loader
  if (pathname === "/usernode-loading.js") {
    try {
      const buf = fs.readFileSync(LOADING_PATH);
      return send(res, 200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" }, buf);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read usernode-loading.js: " + e.message);
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
  if (sandsCache && sandsCache.handleRequest(req, res, pathname)) return;
  if (!engine && (pathname === "/__sands/snapshot" || pathname === "/__sands/transactions")) {
    return send(res, 503, { "Content-Type": "text/plain" }, "Engine loading...");
  }

  // Last One Wins game state API
  if (lastwinCache.handleRequest(req, res, pathname)) return;

  // Echo (latency test) state API
  if (echoCache.handleRequest(req, res, pathname)) return;

  // Global usernames cache
  if (usernamesCache.handleRequest(req, res, pathname)) return;

  // Sidecar /status probe (cached snapshot for usernode-loading.js)
  if (nodeStatusProbe.handleRequest(req, res, pathname)) return;

  // Opinion Market vote encryption pubkey fallback
  if (voteEncryption.handleRequest(req, res, pathname)) return;

  // Opinion Market: serves the auto-mounted /__usernode/cache/<OM_PUBKEY>/*
  // routes (info + getTransactions) for the bridge's inclusion polling.
  // OM passes handleRequest:null to createAppStateCache, but the wrapped
  // cache.handleRequest still owns the cache-route prefix — we just have
  // to call it here so it gets a shot at the request.
  if (omCache.handleRequest(req, res, pathname)) return;

  // Opinion Market cached transactions
  if (pathname === "/opinion-market/api/transactions" && (req.method === "GET" || req.method === "HEAD")) {
    const body = JSON.stringify({ items: omCache.getRawTransactions() });
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
    "/echo":             ECHO_HTML,
    "/echo/":            ECHO_HTML,
  };

  const htmlFile = staticRoutes[pathname];
  if (htmlFile) {
    try {
      // Read each request — both because TX_DELAY_MS and other dev-loop
      // edits should show up immediately, and because the per-page
      // version hash needs to track the file's current contents.
      const raw = fs.readFileSync(htmlFile, "utf8");
      const version = buildVersionFor(htmlFile);
      const rendered = raw.includes("__BUILD_VERSION__")
        ? raw.split("__BUILD_VERSION__").join(version)
        : raw;
      return send(res, 200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-App-Version": version,
      }, rendered);
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Failed to read file: " + e.message);
    }
  }

  // Build-info endpoint for scripted health checks. Returns the version
  // for whichever HTML route the caller specifies (e.g. ?page=/echo); falls
  // back to the root index. Public on purpose — it's just a hash.
  if (pathname === "/__build") {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const page = url.searchParams.get("page") || "/";
      const target = staticRoutes[page] || INDEX_HTML;
      return send(res, 200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      }, JSON.stringify({ version: buildVersionFor(target), page, localDev: LOCAL_DEV }));
    } catch (e) {
      return send(res, 500, { "Content-Type": "text/plain" }, "Build info error: " + e.message);
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
  console.log(`  /echo           — Echo (sidecar latency test)`);
  console.log(`  Mock API (--local-dev): ${LOCAL_DEV ? "ENABLED" : "disabled"}`);
  if (LOCAL_DEV && TX_DELAY_MS != null) {
    console.log(`  Mock tx delay: ${TX_DELAY_MS / 1000}s (-t / --tx-delay)`);
  }
  if (LOCAL_DEV && OM_TEST_MARKET) {
    console.log(`  Opinion Market test market: INJECTED (-omt)`);
  }
  console.log("");
});
