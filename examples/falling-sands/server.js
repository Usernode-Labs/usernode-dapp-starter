/**
 * server.js
 *
 * Runs the sandspiel falling-sands simulation server-side and streams the
 * cell state to all connected browser clients over WebSocket.
 *
 * Bandwidth optimisations:
 *   1. Delta compression — only changed cells are sent each tick.
 *   2. Manual zlib deflate on every binary message (permessage-deflate is
 *      disabled because Mobile Safari's implementation is buggy).
 *   3. Keyframes for new clients; deltas for existing ones.
 *
 * IMPORTANT: All zlib compression is ASYNC to avoid blocking the event loop.
 * This keeps the WebSocket upgrade handler responsive so mobile clients can
 * connect reliably.
 *
 * Usage:
 *   npm install
 *   node server.js          # starts on http://localhost:3333
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const WebSocket = require("ws");
const { Universe, Species, memory } = require("./wasm-loader");

// ── CLI flags ────────────────────────────────────────────────────────────────
const LOCAL_DEV = process.argv.includes("--local-dev");

// ── Explorer upstream (used for both the proxy and chain polling) ────────────
const EXPLORER_UPSTREAM = "alpha2.usernodelabs.org";
const EXPLORER_UPSTREAM_BASE = "/explorer/api";
const APP_PUBKEY = "ut1r96pdaa7h2k4vf62w3w598fyrelv9wru4t53qtgswgfzpsvz77msj588uu";

// ── Configuration ───────────────────────────────────────────────────────────

const WIDTH = 300;
const HEIGHT = 450;
const TICK_HZ = 30;                        // simulation ticks per second
const CELL_BYTES = 4;                      // {species, ra, rb, clock}
const FRAME_SIZE = WIDTH * HEIGHT * CELL_BYTES; // 540 000 bytes
const PORT = parseInt(process.env.PORT, 10) || 3333;

// Binary message types (first byte of every binary WS message)
const MSG_KEYFRAME = 0x01;
const MSG_DELTA = 0x02;

// ── Create the universe ─────────────────────────────────────────────────────

const universe = Universe.new(WIDTH, HEIGHT);

// ── Neutralise the wind field ────────────────────────────────────────────
(function neutraliseWinds() {
  const windsPtr = universe.winds();
  const winds = new Uint8Array(memory.buffer, windsPtr, FRAME_SIZE);
  for (let i = 0; i < winds.length; i += 4) {
    winds[i]     = 126; // dx  – neutral
    winds[i + 1] = 126; // dy  – neutral
    winds[i + 2] = 0;   // pressure
    winds[i + 3] = 0;   // density
  }
})();

// Seed some initial content so new viewers see something right away
universe.paint(150, 40, 8, Species.Sand);
universe.paint(100, 40, 6, Species.Sand);
universe.paint(200, 40, 6, Species.Sand);
universe.paint(150, 100, 6, Species.Water);
universe.paint(100, 120, 5, Species.Water);

// ── Mock transaction store (usernode-bridge local-dev compatibility) ─────────
//
// Drawings are sent as transactions via usernode-bridge.js.  In local-dev mode
// the bridge POSTs to /__mock/sendTransaction; this server stores them
// in-memory and polls the store to apply drawings to the universe.

const MOCK_TX_DELAY_MS = 2000;   // simulated chain inclusion latency

/** @type {Array<{id:string, from_pubkey:string, destination_pubkey:string, amount:any, memo?:string, created_at:string}>} */
const mockTransactions = [];
let lastProcessedTxIdx = 0;

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

// Interpolate a stroke segment [x1,y1,x2,y2,size,species] into paint points
function segmentToPoints(seg) {
  const [x1, y1, x2, y2, size] = seg;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const step = Math.max(1, Math.floor(size * 0.6));
  const steps = Math.max(1, Math.ceil(dist / step));
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    points.push({
      x: Math.round(x1 + dx * t),
      y: Math.round(y1 + dy * t),
    });
  }
  return points;
}

// Poll the mock store for new drawing transactions and apply them
function processDrawings() {
  for (let i = lastProcessedTxIdx; i < mockTransactions.length; i++) {
    const tx = mockTransactions[i];
    try {
      if (!tx.memo) continue;
      const memo = JSON.parse(tx.memo);
      const from = (tx.from_pubkey || "").slice(0, 16);
      applyDrawMemo(memo, `${from}… (mock)`);
    } catch (_) {}
  }
  lastProcessedTxIdx = mockTransactions.length;
}

setInterval(processDrawings, 500);

// ── Chain poller — fetch real transactions from the explorer API ─────────────
//
// When not in --local-dev mode, the server polls the explorer for transactions
// sent to APP_PUBKEY and applies any falling-sands draw memos to the universe.

const CHAIN_POLL_INTERVAL_MS = 3000;
let chainId = null;
const seenTxIds = new Set();
let chainPollCount = 0;

function httpsJson(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request(url, {
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
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function discoverChainId() {
  try {
    const data = await httpsJson("GET", `https://${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}/active_chain`);
    if (data && data.chain_id) {
      chainId = data.chain_id;
      console.log(`[chain] discovered chain_id: ${chainId}`);
    }
  } catch (e) {
    console.warn(`[chain] could not discover chain ID: ${e.message}`);
  }
}

function applyDrawMemo(memo, fromLabel) {
  if (memo.app !== "falling-sands" || memo.type !== "draw" || !Array.isArray(memo.s)) return false;
  for (const seg of memo.s) {
    if (!Array.isArray(seg) || seg.length < 6) continue;
    const species = seg[5] | 0;
    const size = Math.max(1, Math.min(20, seg[4] | 0));
    const pts = segmentToPoints(seg);
    for (const pt of pts) {
      const x = Math.max(0, Math.min(WIDTH - 1, pt.x | 0));
      const y = Math.max(0, Math.min(HEIGHT - 1, pt.y | 0));
      universe.paint(x, y, size, species);
    }
  }
  console.log(`[chain] applied drawing: ${memo.s.length} stroke(s) from ${fromLabel}`);
  return true;
}

async function pollChainTransactions() {
  if (!chainId) {
    await discoverChainId();
    if (!chainId) return;
  }

  chainPollCount++;
  const baseUrl = `https://${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}/${chainId}`;
  const url = `${baseUrl}/transactions`;
  const MAX_PAGES = 10;

  let cursor = null;
  let totalItems = 0;
  let totalNew = 0;
  let totalApplied = 0;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = { account: APP_PUBKEY, limit: 50 };
      if (cursor) body.cursor = cursor;

      const resp = await httpsJson("POST", url, body);

      if (chainPollCount <= 2 && page === 0) {
        const keys = resp ? Object.keys(resp) : [];
        const firstItem = resp && resp.items && resp.items[0]
          ? JSON.stringify(resp.items[0]).slice(0, 200) : "none";
        console.log(`[chain] poll #${chainPollCount} keys=[${keys}] first=${firstItem}`);
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

        if (!tx.memo) continue;
        try {
          const memo = typeof tx.memo === "string" ? JSON.parse(tx.memo) : tx.memo;
          const from = (tx.source || tx.from_pubkey || tx.from || "unknown").slice(0, 16);
          if (applyDrawMemo(memo, `${from}… (${txId.slice(0, 8)}…)`)) totalApplied++;
        } catch (_) {}
      }

      // Stop paginating if we've caught up to already-seen transactions
      if (allSeen) break;

      // Continue to next page if the API indicates more results
      const hasMore = resp && resp.has_more;
      const nextCursor = resp && resp.next_cursor;
      if (!hasMore || !nextCursor) break;
      cursor = nextCursor;
    }

    if (totalNew > 0 || chainPollCount <= 3) {
      console.log(`[chain] poll #${chainPollCount}: ${totalItems} tx(s) scanned, ${totalNew} new, ${totalApplied} drawing(s)`);
    }
  } catch (e) {
    console.warn(`[chain] poll #${chainPollCount} error: ${e.message}`);
  }
}

// Start chain polling (runs alongside mock store processing)
discoverChainId();
setInterval(pollChainTransactions, CHAIN_POLL_INTERVAL_MS);

// ── HTTP server (serves index.html + usernode-bridge.js + mock API) ──────────

const BRIDGE_PATH = (() => {
  const local = path.join(__dirname, "usernode-bridge.js");
  if (fs.existsSync(local)) return local;
  return path.join(__dirname, "..", "..", "usernode-bridge.js");
})();

const server = http.createServer((req, res) => {
  const pathname = (() => {
    try { return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname; }
    catch (_) { return req.url || "/"; }
  })();

  // ── Serve the usernode bridge ────────────────────────────────────────
  if (pathname === "/usernode-bridge.js") {
    try {
      const buf = fs.readFileSync(BRIDGE_PATH);
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to read usernode-bridge.js: " + e.message);
    }
    return;
  }

  // ── Mock endpoints (only when --local-dev) ───────────────────────────
  if (pathname === "/__mock/sendTransaction" && req.method === "POST") {
    if (!LOCAL_DEV) { res.writeHead(404); res.end("Not found (start with --local-dev)"); return; }
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
      const memoBytes = memo ? Buffer.byteLength(memo, "utf8") : 0;
      const from = from_pubkey.slice(0, 16);
      console.log(`[tx] received  from=${from}…  memo=${memoBytes} bytes  dest=${destination_pubkey.slice(0, 16)}…`);
      const tx = {
        id: crypto.randomUUID(),
        from_pubkey,
        destination_pubkey,
        amount,
        memo,
        created_at: new Date().toISOString(),
      };
      // Simulate chain inclusion latency
      setTimeout(() => { mockTransactions.push(tx); }, MOCK_TX_DELAY_MS);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ queued: true, tx }));
    }).catch((e) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  if (pathname === "/__mock/getTransactions" && req.method === "POST") {
    if (!LOCAL_DEV) { res.writeHead(404); res.end("Not found (start with --local-dev)"); return; }
    readJson(req).then((body) => {
      const owner = String(body.owner_pubkey || "").trim();
      const filterOptions = body.filterOptions || {};
      const limit = typeof filterOptions.limit === "number" ? filterOptions.limit : 50;
      const items = mockTransactions
        .filter((tx) => {
          if (!owner) return true;
          return tx.from_pubkey === owner || tx.destination_pubkey === owner;
        })
        .slice(-limit)
        .reverse();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items }));
    }).catch((e) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // ── Explorer API proxy (/explorer-api/*) ──────────────────────────────
  const EXPLORER_PROXY_PREFIX = "/explorer-api/";

  if (pathname.startsWith(EXPLORER_PROXY_PREFIX)) {
    const upstreamPath =
      EXPLORER_UPSTREAM_BASE + "/" + pathname.slice(EXPLORER_PROXY_PREFIX.length);
    const upstreamUrl = new URL(`https://${EXPLORER_UPSTREAM}${upstreamPath}`);

    return void (async () => {
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

        const proxyReq = https.request(
          upstreamUrl,
          {
            method: req.method,
            headers: {
              "content-type": req.headers["content-type"] || "application/json",
              accept: "application/json",
              ...(bodyBuf ? { "content-length": bodyBuf.length } : {}),
            },
          },
          (proxyRes) => {
            const resHeaders = {
              "content-type": proxyRes.headers["content-type"] || "application/json",
              "access-control-allow-origin": "*",
            };
            res.writeHead(proxyRes.statusCode || 502, resHeaders);
            proxyRes.pipe(res);
          }
        );

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
  }

  // ── Serve static pages ───────────────────────────────────────────────
  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

// ── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false,           // Mobile Safari's implementation is buggy
});

// Track which clients still need their first keyframe and which are "ready"
const needsKeyframe = new WeakSet();
const readyClients = new WeakSet();

function safeSend(ws, data) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  } catch (e) {
    console.error("send error:", e.message);
  }
}

// ── WebSocket-level keep-alive ──────────────────────────────────────────
const PING_INTERVAL = 20_000;

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._pongPending) {
      ws.terminate();
      continue;
    }
    ws._pongPending = true;
    ws.ping();
  }
}, PING_INTERVAL);

wss.on("connection", (ws, req) => {
  const connTime = Date.now();

  const socket = req.socket;
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30_000);

  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const ua = (req.headers["user-agent"] || "").slice(0, 80);
  console.log(`WS  connected     (total: ${wss.clients.size})  ip=${ip}  ua=${ua}`);

  ws._pongPending = false;
  ws.on("pong", () => { ws._pongPending = false; });

  ws.on("message", (msg) => {
    // Simple text echo for test page
    const txt = msg.toString();
    if (txt === "ping") { try { ws.send("pong"); } catch(_) {} return; }

    try {
      const cmd = JSON.parse(msg);

      if (cmd.type === "ready") {
        if (ws.readyState !== WebSocket.OPEN) return;
        safeSend(ws, JSON.stringify({ type: "config", width: WIDTH, height: HEIGHT }));
        needsKeyframe.add(ws);
        readyClients.add(ws);
        const total = [...wss.clients].filter(c => readyClients.has(c)).length;
        console.log(`WS  client ready   (total ready: ${total})`);
      } else if (cmd.type === "reset") {
        universe.reset();
      }
      // NOTE: paint commands are no longer sent via WebSocket.
      // Drawings are submitted as transactions via usernode-bridge.js.
    } catch (_) {}
  });

  ws.on("close", (code, reason) => {
    const elapsed = Date.now() - connTime;
    const r = reason ? reason.toString() : "";
    const gotReady = readyClients.has(ws);
    console.log(
      `WS  disconnected  code=${code}${r ? " reason=" + r : ""}  ` +
      `after=${elapsed}ms  ready=${gotReady}  remaining=${wss.clients.size}`
    );
  });

  ws.on("error", (err) => {
    console.error(`WS  error: ${err.message}`);
  });
});

// ── Simulation tick loop (non-blocking) ─────────────────────────────────────
//
// Phase 1 (sync, fast):  universe.tick() + diff calculation
// Phase 2 (async):       zlib compression + broadcast
//
// By splitting into two phases with setImmediate between them, the event loop
// can process incoming WebSocket upgrades and messages between ticks.

let prevFrame = null;
let tickCount = 0;
let bytesSentTotal = 0;
let bytesSentWindow = 0;
let lastStatsTime = Date.now();
let broadcasting = false;  // true while async broadcast is in flight

function tick() {
  universe.tick();
  tickCount++;

  if (wss.clients.size === 0) {
    prevFrame = null;
    return;
  }

  // ── Snapshot the cell buffer from WASM linear memory ──────────────────
  const cellPtr = universe.cells();
  const cells = new Uint8Array(memory.buffer, cellPtr, FRAME_SIZE);
  const frame = Buffer.from(cells); // copy (WASM memory may move)

  // ── Diff against previous frame ─────────────────────────────────────
  let changedOffsets = null;
  if (prevFrame) {
    changedOffsets = [];
    for (let i = 0; i < FRAME_SIZE; i += CELL_BYTES) {
      if (
        frame[i]     !== prevFrame[i]     ||
        frame[i + 1] !== prevFrame[i + 1] ||
        frame[i + 2] !== prevFrame[i + 2]
      ) {
        changedOffsets.push(i);
      }
    }
  }

  // ── Check if any ready client actually needs data ──────────────────────
  let anyNeedsKeyframe = false;
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && readyClients.has(client) && needsKeyframe.has(client)) {
      anyNeedsKeyframe = true;
      break;
    }
  }

  // Nothing visually changed AND no new clients need a keyframe → skip
  if (changedOffsets && changedOffsets.length === 0 && !anyNeedsKeyframe) {
    prevFrame = frame;
    return;
  }

  // ── Build raw messages ────────────────────────────────────────────────
  let keyframeMsg = null;
  let deltaMsg = null;

  function getKeyframe() {
    if (!keyframeMsg) {
      keyframeMsg = Buffer.alloc(1 + FRAME_SIZE);
      keyframeMsg[0] = MSG_KEYFRAME;
      frame.copy(keyframeMsg, 1);
    }
    return keyframeMsg;
  }

  if (changedOffsets && changedOffsets.length > 0) {
    const deltaSize = 1 + 4 + changedOffsets.length * 8;
    if (deltaSize < FRAME_SIZE) {
      deltaMsg = Buffer.alloc(deltaSize);
      deltaMsg[0] = MSG_DELTA;
      deltaMsg.writeUInt32BE(changedOffsets.length, 1);
      let pos = 5;
      for (const off of changedOffsets) {
        deltaMsg.writeUInt32BE(off, pos); pos += 4;
        frame.copy(deltaMsg, pos, off, off + CELL_BYTES); pos += 4;
      }
    }
  }

  prevFrame = frame;

  // ── Phase 2: Async compress & broadcast ───────────────────────────────
  // Yield to the event loop with setImmediate, then compress asynchronously.
  // This is the key fix: zlib no longer blocks the event loop.

  // Determine what we need to compress
  const needKeyframe = anyNeedsKeyframe || (!deltaMsg && changedOffsets && changedOffsets.length > 0);
  const needDelta = !!deltaMsg;

  // Snapshot which clients need what (they might disconnect during async work)
  const clientsSnapshot = [];
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (!readyClients.has(client)) continue;
    const wantsKeyframe = needsKeyframe.has(client);
    if (wantsKeyframe) needsKeyframe.delete(client);
    clientsSnapshot.push({ client, wantsKeyframe });
  }

  if (clientsSnapshot.length === 0) return;

  // Use setImmediate to yield the event loop before doing compression
  setImmediate(() => {
    const compressionTasks = [];

    if (needKeyframe) {
      compressionTasks.push(
        new Promise((resolve, reject) => {
          zlib.deflate(getKeyframe(), { level: 1 }, (err, result) => {
            if (err) reject(err); else resolve({ type: "keyframe", data: result });
          });
        })
      );
    }

    if (needDelta) {
      compressionTasks.push(
        new Promise((resolve, reject) => {
          zlib.deflate(deltaMsg, { level: 1 }, (err, result) => {
            if (err) reject(err); else resolve({ type: "delta", data: result });
          });
        })
      );
    }

    if (compressionTasks.length === 0) return;

    Promise.all(compressionTasks).then((results) => {
      let compressedKeyframe = null;
      let compressedDelta = null;

      for (const r of results) {
        if (r.type === "keyframe") compressedKeyframe = r.data;
        if (r.type === "delta") compressedDelta = r.data;
      }

      for (const { client, wantsKeyframe } of clientsSnapshot) {
        if (client.readyState !== WebSocket.OPEN) continue;

        if (wantsKeyframe && compressedKeyframe) {
          safeSend(client, compressedKeyframe);
          bytesSentWindow += compressedKeyframe.length;
        } else if (compressedDelta) {
          safeSend(client, compressedDelta);
          bytesSentWindow += compressedDelta.length;
        } else if (compressedKeyframe) {
          // Delta was too large, fall back to keyframe
          safeSend(client, compressedKeyframe);
          bytesSentWindow += compressedKeyframe.length;
        }
      }

      // ── Periodic stats log ──────────────────────────────────────────
      const now = Date.now();
      if (now - lastStatsTime >= 5000) {
        const kbps = ((bytesSentWindow / 1024) / ((now - lastStatsTime) / 1000)).toFixed(1);
        bytesSentTotal += bytesSentWindow;
        console.log(
          `[stats] ${kbps} KB/s out  |  ${wss.clients.size} client(s)  |  ` +
          `tick ${tickCount}  |  total ${(bytesSentTotal / 1048576).toFixed(1)} MB`
        );
        bytesSentWindow = 0;
        lastStatsTime = now;
      }
    }).catch((err) => {
      console.error("compression error:", err.message);
    });
  });
}

setInterval(tick, 1000 / TICK_HZ);

// ── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🏖  Falling Sands server running at http://localhost:${PORT}`);

  const nets = require("os").networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        console.log(`   LAN: http://${iface.address}:${PORT}`);
      }
    }
  }

  console.log(`   Grid: ${WIDTH}×${HEIGHT}  |  Tick rate: ${TICK_HZ} Hz`);
  console.log(`   Compression: async zlib (level 1) + delta`);
  console.log(`   Mock API (--local-dev): ${LOCAL_DEV ? "ENABLED" : "disabled"}`);
  console.log(`   Open the URL on any device on your network\n`);
  if (!LOCAL_DEV) {
    console.log(`   ⚠  Mock transaction endpoints are off. Run with --local-dev to enable.\n`);
  }
});
