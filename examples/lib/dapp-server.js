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
  return process.env.EXPLORER_UPSTREAM || "alpha1.usernodelabs.org";
}
function getExplorerUpstreamBase() {
  return process.env.EXPLORER_UPSTREAM_BASE != null
    ? process.env.EXPLORER_UPSTREAM_BASE
    : "/api";
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
  const delayOverrides = (opts && opts.delayOverrides) || {};
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
        const txDelay = (destination_pubkey in delayOverrides) ? delayOverrides[destination_pubkey] : delayMs;
        setTimeout(() => { transactions.push(tx); }, txDelay);
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
        const cursor = filterOptions.cursor || body.cursor || null;

        const filtered = transactions
          .filter((tx) => !owner || tx.from_pubkey === owner || tx.destination_pubkey === owner);

        // Cursor is a 0-based index into the filtered array (descending).
        // Reverse so newest is first (index 0 = newest).
        const reversed = filtered.slice().reverse();
        let startIdx = 0;
        if (cursor != null) {
          try {
            startIdx = parseInt(Buffer.from(String(cursor), "base64").toString("utf8"), 10);
            if (!Number.isFinite(startIdx) || startIdx < 0) startIdx = 0;
          } catch (_) { startIdx = 0; }
        }

        const page = reversed.slice(startIdx, startIdx + limit);
        const nextIdx = startIdx + limit;
        const hasMore = nextIdx < reversed.length;
        const nextCursor = hasMore
          ? Buffer.from(String(nextIdx)).toString("base64")
          : null;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          items: page,
          has_more: hasMore,
          next_cursor: nextCursor,
        }));
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

// ── Confirmation status ──────────────────────────────────────────────────────

function isExplorerConfirmed(status) {
  return status === "confirmed" || status === "canonical";
}

// ── Chain poller ─────────────────────────────────────────────────────────────
//
// Polls the explorer API for new transactions and calls onTransaction(tx) for
// each unseen one. Returns { start() }.

function createChainPoller(opts) {
  const appPubkey = opts.appPubkey;
  const onTransaction = opts.onTransaction;
  const onChainReset = opts.onChainReset || null;
  const intervalMs = opts.intervalMs || 3000;
  const upstream = opts.upstream || getExplorerUpstream();
  const upstreamBase = opts.upstreamBase || getExplorerUpstreamBase();
  const queryField = opts.queryField || "account";
  const maxPages = opts.maxPages || 200;
  const seenIdsCap = opts.seenIdsCap || 5000;
  const recheckIntervalPolls = opts.recheckIntervalPolls || 10;
  const skipOrphaned = opts.skipOrphaned !== false;

  let chainId = null;
  const seenTxIds = new Set();
  let lastHeight = (opts.initialLastHeight != null) ? opts.initialLastHeight : null;
  let pollCount = 0;

  async function fetchActiveChainId() {
    const data = await httpsJson("GET", `${explorerProto(upstream)}://${upstream}${upstreamBase}/active_chain`);
    return (data && data.chain_id) ? data.chain_id : null;
  }

  async function discoverChainId() {
    try {
      const id = await fetchActiveChainId();
      if (id) {
        chainId = id;
        console.log(`[chain] discovered chain_id: ${chainId}`);
      }
    } catch (e) {
      console.warn(`[chain] could not discover chain ID: ${e.message}`);
    }
  }

  async function recheckChainId() {
    try {
      const id = await fetchActiveChainId();
      if (id && id !== chainId) {
        const oldId = chainId;
        console.log(`[chain] chain_id changed: ${oldId} -> ${id} — resetting poller state`);
        chainId = id;
        seenTxIds.clear();
        lastHeight = null;
        if (onChainReset) onChainReset(id, oldId);
      }
    } catch (e) {
      // Transient error — keep using current chainId
    }
  }

  function extractTxTimestamp(tx) {
    const candidates = [tx.timestamp_ms, tx.created_at, tx.createdAt, tx.timestamp, tx.time];
    for (const v of candidates) {
      if (typeof v === "number" && Number.isFinite(v))
        return v < 10_000_000_000 ? v * 1000 : v;
      if (typeof v === "string" && v.trim()) {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) return t;
      }
    }
    return 0;
  }

  async function poll() {
    if (!chainId) { await discoverChainId(); if (!chainId) return; }
    else if (pollCount > 0 && pollCount % recheckIntervalPolls === 0) {
      await recheckChainId();
    }

    pollCount++;
    const baseUrl = `${explorerProto(upstream)}://${upstream}${upstreamBase}/${chainId}`;
    const url = `${baseUrl}/transactions`;
    const MAX_PAGES = maxPages;
    let cursor = null, totalItems = 0;
    const newTxs = [];
    const fromHeight = lastHeight;
    let maxHeight = lastHeight;

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = { [queryField]: appPubkey, limit: 50 };
        if (cursor) body.cursor = cursor;
        if (fromHeight != null) body.from_height = fromHeight;
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
          if (skipOrphaned && tx.status && !isExplorerConfirmed(tx.status)) continue;
          allSeen = false;
          seenTxIds.add(txId);
          newTxs.push(tx);

          const bh = tx.block_height;
          if (typeof bh === "number" && (maxHeight == null || bh > maxHeight)) {
            maxHeight = bh;
          }
        }

        if (allSeen) break;
        const hasMore = resp && resp.has_more;
        const nextCursor = resp && resp.next_cursor;
        if (!hasMore || !nextCursor) break;
        cursor = nextCursor;
      }

      if (maxHeight != null) lastHeight = maxHeight;

      // Bound seenTxIds to prevent unbounded memory growth.
      if (seenTxIds.size > seenIdsCap) {
        const arr = Array.from(seenTxIds);
        seenTxIds.clear();
        for (let i = arr.length - seenIdsCap; i < arr.length; i++) {
          seenTxIds.add(arr[i]);
        }
      }

      // Process in chronological order so stateful consumers (game logic,
      // vote resolution) see events oldest-first.
      newTxs.sort((a, b) => extractTxTimestamp(a) - extractTxTimestamp(b));
      for (const tx of newTxs) {
        if (onTransaction) onTransaction(tx);
      }

      if (newTxs.length > 0 || pollCount <= 3) {
        console.log(`[chain] poll #${pollCount}: ${totalItems} tx(s) scanned, ${newTxs.length} new (lastHeight=${lastHeight ?? "none"})`);
      }
    } catch (e) {
      console.warn(`[chain] poll #${pollCount} error: ${e.message}`);
    }
  }

  function setInitialLastHeight(h) {
    if (lastHeight == null && h != null) lastHeight = h;
  }

  function addSeenIds(ids) {
    for (const id of ids) if (id) seenTxIds.add(id);
  }

  function start() {
    poll();
    setInterval(poll, intervalMs);
  }

  return { start, setInitialLastHeight, addSeenIds };
}

// ── Node RPC: tracked-owner registration + recent-tx-by-recipient ──────────
//
// Direct-to-node fast path for the `recipient` queryField. Lets dapp servers
// bypass explorer indexing lag (5–60s observed) by reading newly-applied
// transactions out of the node's per-tracked-owner ring buffer instead.
// See `usernode/docs/reference/rpc.md` for endpoint shapes.

async function walletAddTrackedOwner(opts) {
  const nodeRpcUrl = opts && opts.nodeRpcUrl;
  const owner = opts && opts.owner;
  if (!nodeRpcUrl || !owner) {
    throw new Error("walletAddTrackedOwner: nodeRpcUrl and owner required");
  }
  return httpsJson("POST", `${nodeRpcUrl}/wallet/tracked_owner/add`, { owner });
}

async function nodeRecentTxByRecipient(opts) {
  const nodeRpcUrl = opts.nodeRpcUrl;
  const recipient = opts.recipient;
  if (!nodeRpcUrl || !recipient) {
    throw new Error("nodeRecentTxByRecipient: nodeRpcUrl and recipient required");
  }
  const body = { recipient };
  if (opts.sinceHeight != null) body.since_height = opts.sinceHeight;
  if (opts.limit != null) body.limit = opts.limit;
  return httpsJson("POST", `${nodeRpcUrl}/transactions/by_recipient`, body);
}

// ── Memo decoder (node wire format → dapp-friendly UTF-8 string) ───────────
//
// The node serializes `Memo` as base64url-encoded bytes (per its
// human-readable serde — see `crates/core/src/transaction/memo.rs`). The
// explorer returns the raw memo string. Dapps' `parseMemo` helpers expect
// the explorer shape, so we decode at the boundary.

function _base64urlDecodeUtf8(s) {
  if (s == null) return "";
  const str = String(s);
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  try {
    return Buffer.from(padded + "=".repeat(padLen), "base64").toString("utf8");
  } catch (_) {
    return "";
  }
}

// Convert a `RecentTxEntry` (node wire format) to the explorer-compatible
// shape that `processTransaction` expects everywhere else in the dapp stack.
function _nodeEntryToExplorerShape(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    tx_id: entry.tx_id,
    source: entry.source != null ? entry.source : null,
    destination: entry.recipient,
    amount: typeof entry.amount === "string" ? Number(entry.amount) : entry.amount,
    memo: _base64urlDecodeUtf8(entry.memo),
    block_hash: entry.block_hash,
    block_height: entry.block_height,
    timestamp_ms: entry.block_timestamp_ms,
    status: "confirmed",
    tx_type: "transfer",
  };
}

// ── Node SSE client (live recent-tx stream) ─────────────────────────────────
//
// Connects to `GET /transactions/stream?recipient=…`. Each frame is a
// `data: {JSON RecentTxEntry}\n\n` block; comments (lines starting with `:`)
// and other SSE fields are ignored. Returns { close() }.
//
// Caller handles reconnect — this function just returns when the connection
// drops (via `onClose`).

function _streamNodeSse(opts) {
  const nodeRpcUrl = opts.nodeRpcUrl;
  const recipient = opts.recipient;
  const onEvent = opts.onEvent;
  const onClose = opts.onClose;
  const url = new URL(`${nodeRpcUrl}/transactions/stream`);
  url.searchParams.set("recipient", recipient);
  const transport = url.protocol === "https:" ? https : http;

  let closed = false;
  function safeClose(err) {
    if (closed) return;
    closed = true;
    try { onClose(err || null); } catch (_) {}
  }

  const req = transport.request(url, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      "cache-control": "no-store",
    },
    // Disable timeout — SSE is long-lived. Heartbeat is the underlying
    // transport's keep-alive; the server emits `:keep-alive` comments via
    // axum's `KeepAlive::default()` (15s).
    timeout: 0,
  }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      safeClose(new Error(`SSE HTTP ${res.statusCode}`));
      return;
    }
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      let idx;
      // SSE event boundary is a blank line (\n\n). Tolerate \r\n endings too.
      while ((idx = buf.search(/\n\n|\r\n\r\n/)) !== -1) {
        const sep = buf[idx] === "\r" ? 4 : 2;
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + sep);
        const dataLines = [];
        for (const rawLine of frame.split(/\r?\n/)) {
          if (rawLine.startsWith(":")) continue; // comment / keep-alive
          if (rawLine.startsWith("data:")) {
            dataLines.push(rawLine.slice(5).replace(/^ /, ""));
          }
          // Other SSE fields (event:, id:, retry:) ignored.
        }
        if (!dataLines.length) continue;
        const data = dataLines.join("\n");
        try {
          const parsed = JSON.parse(data);
          onEvent(parsed);
        } catch (_) {
          // Tolerate malformed frames; SSE is best-effort and the
          // catch-up poll will pick up anything we drop.
        }
      }
    });
    res.on("end", () => safeClose(null));
    res.on("error", (err) => safeClose(err));
    res.on("aborted", () => safeClose(new Error("SSE response aborted")));
  });
  req.on("error", (err) => safeClose(err));
  req.on("timeout", () => safeClose(new Error("SSE request timeout")));
  req.end();

  return {
    close() {
      if (!closed) req.destroy();
      safeClose(null);
    },
  };
}

// ── Live recent-tx stream from the node (SSE + catch-up poll) ───────────────
//
// Replaces `createChainPoller` for the `recipient` queryField when a
// `nodeRpcUrl` is available. Drives `onTransaction(tx)` with the same
// explorer-shape transaction objects the rest of the dapp pipeline expects.
//
// Reliability strategy:
//   - Bootstrap on every (re)connect: poll `POST /transactions/by_recipient`
//     with `since_height: lastHeight + 1` to fill the gap between the
//     explorer-driven backfill (or previous SSE session) and now.
//   - Subscribe to `GET /transactions/stream` and dispatch each frame.
//   - On any stream error/close, exponential-backoff and reconnect — the
//     next bootstrap-poll catches anything missed during the gap.
//   - Periodic safety-net poll (every `catchupIntervalMs`, default 30s) to
//     paper over silently-broken streams (e.g. proxies that hold the
//     connection open without delivering data).
//
// Returns { start, setInitialLastHeight, addSeenIds, close }.

function createNodeRecentTxStream(opts) {
  const nodeRpcUrl = opts.nodeRpcUrl;
  const recipient = opts.recipient;
  const onTransaction = opts.onTransaction;
  const onChainReset = opts.onChainReset || null;
  const name = opts.name || (recipient ? recipient.slice(0, 12) + "…" : "node-stream");
  const catchupIntervalMs = opts.catchupIntervalMs || 30000;
  const seenIdsCap = opts.seenIdsCap || 5000;
  const initialBackoffMs = opts.initialBackoffMs || 1000;
  const maxBackoffMs = opts.maxBackoffMs || 30000;
  const ensureTrackedOwner = opts.ensureTrackedOwner !== false;

  if (!nodeRpcUrl) throw new Error("createNodeRecentTxStream: nodeRpcUrl required");
  if (!recipient) throw new Error("createNodeRecentTxStream: recipient required");
  if (typeof onTransaction !== "function") {
    throw new Error("createNodeRecentTxStream: onTransaction required");
  }

  let lastHeight = (opts.initialLastHeight != null) ? opts.initialLastHeight : null;
  const seenTxIds = new Set();
  let stream = null;
  let stopped = false;
  let backoffMs = initialBackoffMs;
  let trackedOwnerEnsured = !ensureTrackedOwner;
  let catchupTimer = null;

  function trimSeenIds() {
    if (seenTxIds.size <= seenIdsCap) return;
    const arr = Array.from(seenTxIds);
    seenTxIds.clear();
    for (let i = arr.length - seenIdsCap; i < arr.length; i++) {
      seenTxIds.add(arr[i]);
    }
  }

  function dispatchEntry(entry) {
    if (!entry || !entry.tx_id) return;
    if (seenTxIds.has(entry.tx_id)) return;
    seenTxIds.add(entry.tx_id);
    if (typeof entry.block_height === "number") {
      if (lastHeight == null || entry.block_height > lastHeight) {
        lastHeight = entry.block_height;
      }
    }
    const tx = _nodeEntryToExplorerShape(entry);
    if (tx) onTransaction(tx);
  }

  async function ensureTracked() {
    if (trackedOwnerEnsured) return;
    try {
      await walletAddTrackedOwner({ nodeRpcUrl, owner: recipient });
      trackedOwnerEnsured = true;
      console.log(`[${name}] tracked-owner registered with node`);
    } catch (e) {
      // Non-fatal: the SSE will simply yield no events until tracking is
      // established. Surface to logs and let the reconnect loop retry.
      console.warn(`[${name}] tracked_owner/add failed: ${e.message}`);
    }
  }

  async function catchup() {
    try {
      const since = lastHeight != null ? lastHeight : undefined;
      const resp = await nodeRecentTxByRecipient({
        nodeRpcUrl,
        recipient,
        sinceHeight: since,
      });
      if (!resp || !Array.isArray(resp.items)) return;
      if (resp.tracked === false && ensureTrackedOwner) {
        // The recipient isn't tracked yet — re-register and retry on the
        // next reconnect cycle.
        trackedOwnerEnsured = false;
      }
      // Sort oldest-first as a defensive measure (the endpoint already
      // guarantees this, but downstream consumers expect chronological).
      const items = resp.items.slice().sort(
        (a, b) => (a.block_height || 0) - (b.block_height || 0)
      );
      for (const entry of items) dispatchEntry(entry);
      trimSeenIds();
    } catch (e) {
      // Surface but don't escalate; the next tick will retry.
      console.warn(`[${name}] catchup failed: ${e.message}`);
    }
  }

  async function connect() {
    if (stopped) return;

    await ensureTracked();
    await catchup();

    if (stopped) return;

    stream = _streamNodeSse({
      nodeRpcUrl,
      recipient,
      onEvent: (entry) => {
        dispatchEntry(entry);
        trimSeenIds();
        // Reset backoff on first successful event.
        backoffMs = initialBackoffMs;
      },
      onClose: (err) => {
        stream = null;
        if (stopped) return;
        if (err) {
          console.warn(`[${name}] SSE closed: ${err.message}; reconnecting in ${backoffMs}ms`);
        }
        const wait = backoffMs;
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        setTimeout(() => { if (!stopped) connect(); }, wait);
      },
    });
  }

  function start() {
    if (stopped) return;
    void connect();
    if (catchupTimer == null) {
      catchupTimer = setInterval(() => { void catchup(); }, catchupIntervalMs);
    }
  }

  function close() {
    stopped = true;
    if (catchupTimer != null) {
      clearInterval(catchupTimer);
      catchupTimer = null;
    }
    if (stream) {
      try { stream.close(); } catch (_) {}
      stream = null;
    }
  }

  function setInitialLastHeight(h) {
    if (lastHeight == null && h != null) lastHeight = h;
  }

  function addSeenIds(ids) {
    if (!Array.isArray(ids)) return;
    for (const id of ids) if (id) seenTxIds.add(id);
    trimSeenIds();
  }

  // Stub for parity with `createChainPoller`'s onChainReset semantics. The
  // node-side ring buffer doesn't need explicit reset notifications — when
  // the node restarts on a new chain, the catch-up poll sees `tracked: false`
  // (we re-register) and `latest_block_height: null` (height resets), and
  // `onChainReset` is fired by the parallel explorer poller (or the cache
  // wrapper) anyway.
  void onChainReset;

  return { start, close, setInitialLastHeight, addSeenIds };
}

// ── Bulk transaction fetch ───────────────────────────────────────────────────
//
// One-shot paginated fetch of all transactions for a pubkey/chain.
// Returns { transactions: [...], lastHeight, txIds: [...] } sorted oldest-first.

async function fetchAllTransactions(opts) {
  const chainId = opts.chainId;
  const appPubkey = opts.appPubkey;
  const queryField = opts.queryField || "recipient";
  const upstream = opts.upstream || getExplorerUpstream();
  const upstreamBase = opts.upstreamBase || getExplorerUpstreamBase();
  const maxPages = opts.maxPages || 500;

  if (!chainId || !appPubkey) return { transactions: [], lastHeight: null };

  const baseUrl = `${explorerProto(upstream)}://${upstream}${upstreamBase}/${chainId}`;
  const url = `${baseUrl}/transactions`;
  const allTxs = [];
  let lastHeight = null;
  let cursor = null;

  try {
    for (let page = 0; page < maxPages; page++) {
      const body = { [queryField]: appPubkey, limit: 50 };
      if (cursor) body.cursor = cursor;
      const resp = await httpsJson("POST", url, body);

      const items = Array.isArray(resp) ? resp
        : (resp && Array.isArray(resp.items)) ? resp.items
        : (resp && Array.isArray(resp.transactions)) ? resp.transactions
        : [];

      if (items.length === 0) break;

      for (const tx of items) {
        allTxs.push(tx);
        const bh = tx.block_height;
        if (typeof bh === "number" && (lastHeight == null || bh > lastHeight)) {
          lastHeight = bh;
        }
      }

      if (page % 10 === 0 && page > 0) {
        console.log(`[fetch-txs] page ${page}, ${allTxs.length} txs so far...`);
      }

      const hasMore = resp && resp.has_more;
      const nextCursor = resp && resp.next_cursor;
      if (!hasMore || !nextCursor) break;
      cursor = nextCursor;
    }
  } catch (e) {
    console.warn(`[fetch-txs] error after ${allTxs.length} txs: ${e.message}`);
  }

  function extractTs(tx) {
    const candidates = [tx.timestamp_ms, tx.created_at, tx.createdAt, tx.timestamp, tx.time];
    for (const v of candidates) {
      if (typeof v === "number" && Number.isFinite(v))
        return v < 10_000_000_000 ? v * 1000 : v;
      if (typeof v === "string" && v.trim()) {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) return t;
      }
    }
    return 0;
  }

  allTxs.sort((a, b) => extractTs(a) - extractTs(b));
  const txIds = allTxs.map(tx => tx.tx_id || tx.id || tx.txid || tx.hash || tx.tx_hash).filter(Boolean);
  console.log(`[fetch-txs] fetched ${allTxs.length} transaction(s), lastHeight=${lastHeight ?? "none"}`);
  return { transactions: allTxs, lastHeight, txIds };
}

// ── Chain info discovery ─────────────────────────────────────────────────────
//
// Discovers chain_id and estimates genesis timestamp from the block explorer.
// Returns { chainId, genesisTimestampMs } — either field may be null on failure.

async function discoverChainInfo(opts) {
  const upstream = (opts && opts.upstream) || getExplorerUpstream();
  const upstreamBase = (opts && opts.upstreamBase) || getExplorerUpstreamBase();
  const baseUrl = `${explorerProto(upstream)}://${upstream}${upstreamBase}`;

  const result = { chainId: null, genesisTimestampMs: null };

  try {
    const data = await httpsJson("GET", `${baseUrl}/active_chain`);
    if (data && data.chain_id) result.chainId = data.chain_id;
  } catch (e) {
    console.warn(`[chain-info] could not discover chain: ${e.message}`);
    return result;
  }

  if (!result.chainId) return result;

  try {
    const data = await httpsJson("GET", `${baseUrl}/${result.chainId}/blocks?limit=2`);
    const blocks = (data && data.items) || [];

    if (blocks.length >= 2) {
      const [b1, b2] = blocks;
      const slotDiff = b1.global_slot - b2.global_slot;
      const timeDiff = b1.timestamp_ms - b2.timestamp_ms;
      if (slotDiff > 0 && timeDiff > 0) {
        const slotMs = timeDiff / slotDiff;
        result.genesisTimestampMs = Math.round(b1.timestamp_ms - b1.global_slot * slotMs);
        console.log(`[chain-info] genesis: ${new Date(result.genesisTimestampMs).toISOString()} (slot=${slotMs}ms, chain=${result.chainId.slice(0, 16)}…)`);
      }
    } else if (blocks.length === 1 && blocks[0].global_slot > 0) {
      const b = blocks[0];
      const slotMs = 5000;
      result.genesisTimestampMs = Math.round(b.timestamp_ms - b.global_slot * slotMs);
      console.log(`[chain-info] genesis (estimated, 1 block): ${new Date(result.genesisTimestampMs).toISOString()}`);
    }
  } catch (e) {
    console.warn(`[chain-info] could not fetch blocks for genesis time: ${e.message}`);
  }

  return result;
}

// ── Genesis accounts fetch ───────────────────────────────────────────────
//
// One-shot fetch of genesis-ledger accounts by querying the explorer for
// genesis-type transactions (block height 0). Returns an array of unique
// destination addresses that received genesis distributions.

async function fetchGenesisAccounts(opts) {
  const upstream = (opts && opts.upstream) || getExplorerUpstream();
  const upstreamBase = (opts && opts.upstreamBase) || getExplorerUpstreamBase();

  let chainId = opts && opts.chainId;
  if (!chainId) {
    try {
      const data = await httpsJson("GET", `${explorerProto(upstream)}://${upstream}${upstreamBase}/active_chain`);
      chainId = data && data.chain_id;
    } catch (e) {
      console.warn(`[genesis] could not discover chain: ${e.message}`);
      return [];
    }
  }
  if (!chainId) return [];

  const baseUrl = `${explorerProto(upstream)}://${upstream}${upstreamBase}/${chainId}`;
  const accounts = new Set();

  try {
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const body = { to_height: 1, limit: 200 };
      if (cursor) body.cursor = cursor;
      const resp = await httpsJson("POST", `${baseUrl}/transactions`, body);

      const items = (resp && Array.isArray(resp.items)) ? resp.items
        : (resp && Array.isArray(resp.transactions)) ? resp.transactions
        : [];

      for (const tx of items) {
        if (tx.tx_type === "genesis" && tx.destination) {
          accounts.add(tx.destination);
        }
      }

      if (!resp || !resp.has_more || !resp.next_cursor) break;
      cursor = resp.next_cursor;
    }
    console.log(`[genesis] found ${accounts.size} genesis account(s)`);
  } catch (e) {
    console.warn(`[genesis] could not fetch genesis accounts: ${e.message}`);
  }

  return Array.from(accounts);
}

// ── Generic app-state cache ─────────────────────────────────────────────────
//
// One-call wiring of the standard pattern from AGENTS.md Section 7: every dapp
// that maintains shared global state should poll the chain server-side, hold
// the derived state in memory, and serve it from a local HTTP endpoint so
// connected clients hit one small response instead of all paginating the
// explorer independently.
//
// Caller provides:
//   - appPubkey            — the address being polled
//   - queryFields          — ["recipient"], ["sender"], or both. Defaults to ["recipient"].
//   - processTransaction   — pure function: takes a raw explorer tx, mutates internal state.
//   - handleRequest        — pure function: serves the state-as-JSON HTTP endpoint(s).
//   - onChainReset         — called when the chain id changes (clear caller state).
//   - localDev             — gate chain polling off and drain mockTransactions instead.
//   - mockTransactions     — array from createMockApi; drained on a 1s timer in localDev.
//   - intervalMs           — live-poll interval (default 3000).
//   - backfill             — run fetchAllTransactions once at start (default true).
//   - name                 — short label for log lines.
//   - nodeRpcUrl           — optional. URL of a usernode RPC server.
//     When set, the `recipient` queryField switches to the node's SSE
//     fast path automatically (see `useNodeStream`).
//   - useNodeStream        — defaults to true whenever `nodeRpcUrl` is
//     set. The `recipient` queryField is then served by a direct-to-node
//     SSE stream + catch-up poll (see createNodeRecentTxStream) instead
//     of paginating the explorer, dropping live-tail latency from 5–60s
//     (explorer indexing) to sub-second. Requires the node to expose
//     `/transactions/by_recipient` and `/transactions/stream` (i.e.
//     started with `--enable-recent-tx-stream`). Pass `false` to opt
//     out — useful when targeting an older node that lacks those
//     endpoints. Other queryFields keep the explorer path; backfill is
//     always explorer-driven.
//
// Helper handles:
//   - Discover chain id, backfill history (oldest→newest, interleaved across
//     multiple queryFields) before any live polling. Avoids out-of-order
//     processing when both incoming and outgoing txs matter to the app.
//   - Live polling via createChainPoller per queryField with `from_height`
//     incremental fetches.
//   - Mock-mode drain of mockTransactions (no chain polling).
//   - Forwarding handleRequest so the caller's HTTP routes are served from
//     the cache wiring.

function _appStateExtractTs(tx) {
  const candidates = [tx.timestamp_ms, tx.created_at, tx.createdAt, tx.timestamp, tx.time];
  for (const v of candidates) {
    if (typeof v === "number" && Number.isFinite(v))
      return v < 10_000_000_000 ? v * 1000 : v;
    if (typeof v === "string" && v.trim()) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return 0;
}

function _appStateExtractId(tx) {
  return tx.tx_id || tx.id || tx.txid || tx.hash || tx.tx_hash || null;
}

function createAppStateCache(opts) {
  opts = opts || {};
  const appPubkey = opts.appPubkey;
  if (!appPubkey) throw new Error("createAppStateCache: appPubkey is required");
  const userProcessTransaction = opts.processTransaction;
  if (typeof userProcessTransaction !== "function") {
    throw new Error("createAppStateCache: processTransaction(tx) is required");
  }
  // No-op default so callers can unconditionally do `cache.handleRequest(req, res, pathname)`
  // without nil-checks even when the dapp routes its own HTTP separately.
  const userHandleRequest = typeof opts.handleRequest === "function"
    ? opts.handleRequest
    : function () { return false; };
  const queryFields = Array.isArray(opts.queryFields) && opts.queryFields.length
    ? opts.queryFields
    : ["recipient"];
  const onChainReset = opts.onChainReset || null;
  const localDev = !!opts.localDev;
  const mockTransactions = opts.mockTransactions || null;
  const intervalMs = opts.intervalMs || 3000;
  const upstream = opts.upstream || getExplorerUpstream();
  const upstreamBase = opts.upstreamBase || getExplorerUpstreamBase();
  const wantBackfill = opts.backfill !== false;
  // Optional caller-supplied seed for the live poller. Useful when the dapp
  // ran its own backfill before creating the cache (e.g. falling-sands feeds
  // historical txs into its engine constructor for windowed replay) and just
  // needs the poller to start from where that left off.
  const initialLastHeight = opts.initialLastHeight != null ? opts.initialLastHeight : null;
  const initialSeenIds = Array.isArray(opts.initialSeenIds) ? opts.initialSeenIds : null;
  const name = opts.name || appPubkey.slice(0, 12) + "…";
  // Direct-to-node fast path. Defaults ON whenever `nodeRpcUrl` is set so
  // dapps don't need to plumb a feature flag — sub-second live-tail is
  // simply what you get when a node is reachable. Requires the node to
  // expose `/transactions/by_recipient` + `/transactions/stream` (i.e.
  // started with `--enable-recent-tx-stream`; see
  // `usernode/docs/reference/rpc.md`). When the cache includes the
  // `recipient` queryField, live updates for that field come from SSE +
  // catch-up poll instead of paginating the explorer. Other queryFields
  // (sender, account) keep the explorer poller — the node endpoints only
  // cover incoming traffic. Backfill is always explorer-driven.
  //
  // Pass `useNodeStream: false` to opt out (e.g. when targeting an older
  // node that lacks the SSE endpoints).
  const nodeRpcUrl = opts.nodeRpcUrl || null;
  const useNodeStream = (opts.useNodeStream !== false) && !!nodeRpcUrl;

  // ── Raw-tx store + bridge-facing HTTP endpoint ──────────────────────────
  //
  // Every tx that flows through processTransaction is also retained here so
  // the bridge's waitForTransactionVisible can poll the local cache instead
  // of redundantly polling the explorer. One server poll → many client reads.
  //
  // Stored unbounded by design: the cache is rebuilt from chain history on
  // every restart, so it never grows past one server's lifetime, and a few
  // hundred bytes per tx puts the practical ceiling far above what these
  // dapps generate. Add a `maxRetained` opt later if a dapp ever approaches
  // it.
  const rawTxs = []; // chronological insertion order
  const rawTxIds = new Set();
  const cacheRoutePrefix = `/__usernode/cache/${appPubkey}`;

  function processTransaction(rawTx) {
    if (rawTx && typeof rawTx === "object") {
      const id = _appStateExtractId(rawTx);
      if (!id || !rawTxIds.has(id)) {
        if (id) rawTxIds.add(id);
        rawTxs.push(rawTx);
      }
    }
    return userProcessTransaction(rawTx);
  }

  // Read-only access to the cache's raw-tx list, in chronological (insertion)
  // order. Useful for in-process consumers (e.g. a dapp HTTP route) that want
  // the same data the bridge sees but without going through HTTP. Caller
  // must not mutate the returned array.
  function getRawTransactions() {
    return rawTxs;
  }

  function _onChainResetWrapped(newId, oldId) {
    rawTxs.length = 0;
    rawTxIds.clear();
    if (typeof onChainReset === "function") onChainReset(newId, oldId);
  }

  function _txField(tx, ...keys) {
    for (const k of keys) {
      const v = tx && tx[k];
      if (v != null) return v;
    }
    return null;
  }

  function _filterCachedTxs(filter) {
    const limit = typeof filter.limit === "number" && filter.limit > 0 ? filter.limit : 50;
    const sender = filter.sender || null;
    const recipient = filter.recipient || null;
    const account = filter.account || null;
    const out = [];
    // Newest-first (matches explorer API ordering).
    for (let i = rawTxs.length - 1; i >= 0 && out.length < limit; i--) {
      const tx = rawTxs[i];
      const from = _txField(tx, "source", "from_pubkey", "from");
      const to = _txField(tx, "destination", "destination_pubkey", "to");
      if (sender && from !== sender) continue;
      if (recipient && to !== recipient) continue;
      if (account && from !== account && to !== account) continue;
      out.push(tx);
    }
    return out;
  }

  function handleCacheRequest(req, res, pathname) {
    if (!pathname || !pathname.startsWith(cacheRoutePrefix)) return false;
    const sub = pathname.slice(cacheRoutePrefix.length);

    if ((sub === "/info" || sub === "") &&
        (req.method === "GET" || req.method === "HEAD")) {
      const body = JSON.stringify({
        enabled: true,
        app_pubkey: appPubkey,
        count: rawTxs.length,
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? "" : body);
      return true;
    }

    if (sub === "/getTransactions" && req.method === "POST") {
      readJson(req).then(
        (filter) => {
          const items = _filterCachedTxs(filter || {});
          const body = JSON.stringify({
            items,
            count: items.length,
            total_in_cache: rawTxs.length,
          });
          res.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          res.end(body);
        },
        (err) => {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid json: " + err.message }));
        }
      );
      return true;
    }

    return false;
  }

  function handleRequest(req, res, pathname) {
    if (handleCacheRequest(req, res, pathname)) return true;
    return userHandleRequest(req, res, pathname);
  }

  let started = false;

  async function start() {
    if (started) return;
    started = true;

    if (localDev) {
      if (mockTransactions) {
        let idx = 0;
        setInterval(() => {
          while (idx < mockTransactions.length) {
            processTransaction(mockTransactions[idx]);
            idx++;
          }
        }, 1000);
        console.log(`[${name}] mock drain started (queryFields=[${queryFields.join(",")}])`);
      }
      return;
    }

    // Production: backfill history (interleaved across queryFields, sorted
    // chronologically), then start live pollers.
    let chainId = null;
    try {
      const info = await discoverChainInfo({ upstream, upstreamBase });
      chainId = info.chainId;
    } catch (_) {}

    let lastHeight = initialLastHeight;
    const backfillIds = initialSeenIds ? initialSeenIds.slice() : [];
    if (wantBackfill && chainId) {
      const allTxs = [];
      for (const queryField of queryFields) {
        try {
          const fetched = await fetchAllTransactions({
            chainId,
            appPubkey,
            queryField,
            upstream,
            upstreamBase,
          });
          allTxs.push(...fetched.transactions);
          if (fetched.lastHeight != null && (lastHeight == null || fetched.lastHeight > lastHeight)) {
            lastHeight = fetched.lastHeight;
          }
          for (const id of fetched.txIds || []) backfillIds.push(id);
        } catch (e) {
          console.warn(`[${name}] backfill (${queryField}) failed: ${e.message}`);
        }
      }
      // Re-sort across queryFields and dedup so pathological self-sends
      // (sender == recipient) aren't double-counted.
      allTxs.sort((a, b) => _appStateExtractTs(a) - _appStateExtractTs(b));
      const seen = new Set();
      let processed = 0;
      for (const tx of allTxs) {
        const id = _appStateExtractId(tx);
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        processTransaction(tx);
        processed++;
      }
      console.log(`[${name}] backfill complete: ${processed} tx(s) processed (lastHeight=${lastHeight ?? "none"})`);
    }

    for (const queryField of queryFields) {
      // Direct-to-node SSE + catch-up replaces the explorer poller for the
      // `recipient` queryField when `useNodeStream` is opted in and the
      // node URL is set. Drops live-tail latency from explorer-indexing
      // time (5–60s observed) to sub-second push.
      if (useNodeStream && queryField === "recipient") {
        const stream = createNodeRecentTxStream({
          nodeRpcUrl,
          recipient: appPubkey,
          onTransaction: processTransaction,
          name: `${name}:node-stream`,
          initialLastHeight: lastHeight,
        });
        if (backfillIds.length) stream.addSeenIds(backfillIds);
        stream.start();
        continue;
      }
      const poller = createChainPoller({
        appPubkey,
        queryField,
        onTransaction: processTransaction,
        onChainReset: _onChainResetWrapped,
        intervalMs,
        upstream,
        upstreamBase,
      });
      if (lastHeight != null) poller.setInitialLastHeight(lastHeight);
      if (backfillIds.length) poller.addSeenIds(backfillIds);
      poller.start();
    }
  }

  return { start, handleRequest, processTransaction, getRawTransactions };
}

// ── Global usernames cache ──────────────────────────────────────────────────
//
// Thin wrapper around createAppStateCache for the global usernames address.
// Owns the in-memory username map + the GET /__usernames/state HTTP endpoint;
// delegates chain plumbing (backfill + poll + mock drain) to the generic
// helper. Caller wiring is identical to any other createAppStateCache use.

// The well-known global usernames address. Hardcoded fallback so the lib still
// works when callers don't pass `usernamesPubkey`. Override via env (used by
// every server.js in this repo) so `make node` / docker-compose can track the
// same address as a wallet owner — required for the new SSE recent_tx_stream
// to deliver live username updates.
const DEFAULT_USERNAMES_PUBKEY =
  process.env.USERNAMES_PUBKEY ||
  "ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az";

function _usernamesParseMemo(m) {
  if (m == null) return null;
  try { return JSON.parse(String(m)); } catch (_) { return null; }
}

function _usernamesNormalizeTx(tx) {
  if (!tx || typeof tx !== "object") return null;
  return {
    id: _appStateExtractId(tx),
    from: tx.from_pubkey || tx.from || tx.source || null,
    to: tx.destination_pubkey || tx.to || tx.destination || null,
    memo: tx.memo != null ? String(tx.memo) : null,
    ts: _appStateExtractTs(tx) || Date.now(),
  };
}

function createUsernamesCache(opts) {
  opts = opts || {};
  const usernamesPubkey = opts.usernamesPubkey || DEFAULT_USERNAMES_PUBKEY;

  // pubkey → { name, ts } — latest-ts-wins per sender.
  const usernames = new Map();
  let lastSeenTs = 0;

  function processTransaction(rawTx) {
    const tx = _usernamesNormalizeTx(rawTx);
    if (!tx || !tx.from || tx.to !== usernamesPubkey) return;
    const memo = _usernamesParseMemo(tx.memo);
    if (!memo || memo.app !== "usernames" || memo.type !== "set_username") return;
    const raw = String(memo.username || "").trim();
    if (!raw) return;
    const prev = usernames.get(tx.from);
    if (!prev || tx.ts >= prev.ts) {
      usernames.set(tx.from, { name: raw, ts: tx.ts });
    }
    if (tx.ts > lastSeenTs) lastSeenTs = tx.ts;
  }

  function getStateResponse() {
    const map = {};
    for (const [k, v] of usernames) map[k] = v.name;
    return {
      usernames: map,
      lastSeenTs,
      usernamesPubkey,
      count: usernames.size,
    };
  }

  function handleStateRequest(req, res, pathname) {
    if (pathname !== "/__usernames/state") return false;
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const body = JSON.stringify(getStateResponse());
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    };
    if (req.method === "HEAD") {
      res.writeHead(200, { ...headers, "content-length": Buffer.byteLength(body) });
      res.end();
      return true;
    }
    res.writeHead(200, headers);
    res.end(body);
    return true;
  }

  function reset() {
    usernames.clear();
    lastSeenTs = 0;
    console.log("[usernames] cache reset (chain restart detected)");
  }

  const cache = createAppStateCache({
    name: "usernames",
    appPubkey: usernamesPubkey,
    queryFields: ["recipient"],
    processTransaction,
    handleRequest: handleStateRequest,
    onChainReset: reset,
    localDev: opts.localDev,
    mockTransactions: opts.mockTransactions || null,
    intervalMs: opts.intervalMs,
    upstream: opts.upstream,
    upstreamBase: opts.upstreamBase,
    nodeRpcUrl: opts.nodeRpcUrl || null,
    // Pass through unmodified so createAppStateCache's default (on whenever
    // nodeRpcUrl is set) applies. Coercing undefined→false here would shadow
    // the default and force every caller to plumb the flag explicitly.
    useNodeStream: opts.useNodeStream,
  });

  // Expose `cache.handleRequest` (not the inner `handleStateRequest`) so the
  // auto-mounted /__usernode/cache/<usernamesPubkey>/* routes are reachable
  // — that's what the bridge's serverCacheUrl-based inclusion polling hits.
  // `cache.handleRequest` already chains its own cache-route check in front
  // of `handleStateRequest`, so callers get both endpoints from one entry.
  return {
    start: cache.start,
    handleRequest: cache.handleRequest,
    processTransaction,
    getStateResponse,
    reset,
    usernamesPubkey,
  };
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
  DEFAULT_USERNAMES_PUBKEY,
  loadEnvFile,
  readJson,
  httpsJson,
  handleExplorerProxy,
  createMockApi,
  isExplorerConfirmed,
  createChainPoller,
  fetchAllTransactions,
  fetchGenesisAccounts,
  discoverChainInfo,
  createAppStateCache,
  createUsernamesCache,
  walletAddTrackedOwner,
  nodeRecentTxByRecipient,
  createNodeRecentTxStream,
  resolvePath,
};
