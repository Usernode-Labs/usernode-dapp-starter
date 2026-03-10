/**
 * Falling-sands simulation engine.
 *
 * Encapsulates the WASM universe, WebSocket streaming with delta compression,
 * and draw-memo processing. Used by both the standalone falling-sands server
 * and the combined examples server.
 *
 * Usage:
 *   const createEngine = require('./engine');
 *   const engine = createEngine({ wasmLoaderPath: './wasm-loader' });
 *   engine.attachWebSocket(httpServer);
 *   engine.startTickLoop();
 *   engine.applyDrawMemo(memo, 'user123');
 */

const zlib = require("zlib");
const WebSocket = require("ws");

const WIDTH = 300;
const HEIGHT = 450;
const TICK_HZ = 30;
const CELL_BYTES = 4;
const FRAME_SIZE = WIDTH * HEIGHT * CELL_BYTES;
const MSG_KEYFRAME = 0x01;
const MSG_DELTA = 0x02;
const PING_INTERVAL = 20_000;

const FLAG_OPEN_BOTTOM = 1;
const FLAG_SOURCES = 2;
const FLAG_PLANT_ABSORBS = 4;

function createEngine(opts) {
  const wasmLoaderPath = (opts && opts.wasmLoaderPath) || "./wasm-loader";
  const { Universe, Species, memory } = require(wasmLoaderPath);

  const universe = Universe.new(WIDTH, HEIGHT);

  const openBottom = process.env.FALLING_SANDS_OPEN_BOTTOM !== "false";
  const sourcesEnabled = process.env.FALLING_SANDS_SOURCES !== "false";
  const plantAbsorbs = process.env.FALLING_SANDS_PLANT_ABSORBS !== "false";
  let flags = 0;
  if (openBottom) flags |= FLAG_OPEN_BOTTOM;
  if (sourcesEnabled) flags |= FLAG_SOURCES;
  if (plantAbsorbs) flags |= FLAG_PLANT_ABSORBS;
  if (flags) universe.set_flags(flags);

  // Neutralise the wind field
  const windsPtr = universe.winds();
  const winds = new Uint8Array(memory.buffer, windsPtr, FRAME_SIZE);
  for (let i = 0; i < winds.length; i += 4) {
    winds[i]     = 126;
    winds[i + 1] = 126;
    winds[i + 2] = 0;
    winds[i + 3] = 0;
  }

  // Seed initial content
  if (sourcesEnabled) {
    const srcY = Math.round(HEIGHT / 8);
    const gap = WIDTH / 5;
    universe.paint(Math.round(gap * 1), srcY, 5, Species.Spout);
    universe.paint(Math.round(gap * 2), srcY, 5, Species.SandSource);
    universe.paint(Math.round(gap * 3), srcY, 5, Species.Torch);
    universe.paint(Math.round(gap * 4), srcY, 5, Species.OilWell);

    // Small wall cups under the water, sand, and oil sources
    const cupBottom = Math.round(HEIGHT * 7 / 8);
    const cupW = 18;
    const cupH = 14;
    const cupSources = [1, 2, 4]; // indices into gap multiplier (skip torch at 3)
    for (const si of cupSources) {
      const cx = Math.round(gap * si);
      for (let dy = 0; dy <= cupH; dy++) {
        universe.paint(cx - cupW, cupBottom - dy, 2, Species.Wall);
        universe.paint(cx + cupW, cupBottom - dy, 2, Species.Wall);
      }
      for (let dx = -cupW; dx <= cupW; dx += 2) {
        universe.paint(cx + dx, cupBottom, 2, Species.Wall);
      }
    }
  } else {
    universe.paint(150, 40, 8, Species.Sand);
    universe.paint(100, 40, 6, Species.Sand);
    universe.paint(200, 40, 6, Species.Sand);
    universe.paint(150, 100, 6, Species.Water);
    universe.paint(100, 120, 5, Species.Water);
  }

  // ── Draw helpers ─────────────────────────────────────────────────────────

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
      points.push({ x: Math.round(x1 + dx * t), y: Math.round(y1 + dy * t) });
    }
    return points;
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

  // ── Mock transaction draw processing ───────────────────────────────────

  let lastProcessedTxIdx = 0;

  function processMockTransactions(transactions) {
    for (let i = lastProcessedTxIdx; i < transactions.length; i++) {
      const tx = transactions[i];
      try {
        if (!tx.memo) continue;
        const memo = JSON.parse(tx.memo);
        const from = (tx.from_pubkey || "").slice(0, 16);
        applyDrawMemo(memo, `${from}… (mock)`);
      } catch (_) {}
    }
    lastProcessedTxIdx = transactions.length;
  }

  // ── WebSocket streaming ────────────────────────────────────────────────

  let wss = null;
  const needsKeyframe = new WeakSet();
  const readyClients = new WeakSet();

  function safeSend(ws, data) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(data); } catch (e) { console.error("send error:", e.message); }
  }

  function attachWebSocket(httpServer) {
    wss = new WebSocket.Server({ server: httpServer, perMessageDeflate: false });

    // Keep-alive ping
    setInterval(() => {
      for (const ws of wss.clients) {
        if (ws._pongPending) { ws.terminate(); continue; }
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
        const txt = msg.toString();
        if (txt === "ping") { try { ws.send("pong"); } catch(_) {} return; }

        try {
          const cmd = JSON.parse(msg);
          if (cmd.type === "ready") {
            if (ws.readyState !== WebSocket.OPEN) return;
            safeSend(ws, JSON.stringify({ type: "config", width: WIDTH, height: HEIGHT, sources: sourcesEnabled }));
            needsKeyframe.add(ws);
            readyClients.add(ws);
            const total = [...wss.clients].filter(c => readyClients.has(c)).length;
            console.log(`WS  client ready   (total ready: ${total})`);
          } else if (cmd.type === "reset") {
            universe.reset();
          }
        } catch (_) {}
      });

      ws.on("close", (code, reason) => {
        const elapsed = Date.now() - connTime;
        const r = reason ? reason.toString() : "";
        console.log(`WS  disconnected  code=${code}${r ? " reason=" + r : ""}  after=${elapsed}ms  remaining=${wss.clients.size}`);
      });

      ws.on("error", (err) => { console.error(`WS  error: ${err.message}`); });
    });

    return wss;
  }

  // ── Simulation tick loop ───────────────────────────────────────────────

  let prevFrame = null;
  let tickCount = 0;
  let bytesSentTotal = 0;
  let bytesSentWindow = 0;
  let lastStatsTime = Date.now();

  function tick() {
    universe.tick();
    tickCount++;

    if (!wss || wss.clients.size === 0) { prevFrame = null; return; }

    const cellPtr = universe.cells();
    const cells = new Uint8Array(memory.buffer, cellPtr, FRAME_SIZE);
    const frame = Buffer.from(cells);

    let changedOffsets = null;
    if (prevFrame) {
      changedOffsets = [];
      for (let i = 0; i < FRAME_SIZE; i += CELL_BYTES) {
        if (frame[i] !== prevFrame[i] || frame[i+1] !== prevFrame[i+1] || frame[i+2] !== prevFrame[i+2]) {
          changedOffsets.push(i);
        }
      }
    }

    let anyNeedsKeyframe = false;
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && readyClients.has(client) && needsKeyframe.has(client)) {
        anyNeedsKeyframe = true;
        break;
      }
    }

    if (changedOffsets && changedOffsets.length === 0 && !anyNeedsKeyframe) { prevFrame = frame; return; }

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

    const needKF = anyNeedsKeyframe || (!deltaMsg && changedOffsets && changedOffsets.length > 0);
    const needDelta = !!deltaMsg;

    const clientsSnapshot = [];
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN || !readyClients.has(client)) continue;
      const wantsKeyframe = needsKeyframe.has(client);
      if (wantsKeyframe) needsKeyframe.delete(client);
      clientsSnapshot.push({ client, wantsKeyframe });
    }

    if (clientsSnapshot.length === 0) return;

    setImmediate(() => {
      const tasks = [];
      if (needKF) tasks.push(new Promise((res, rej) => { zlib.deflate(getKeyframe(), { level: 1 }, (e, r) => e ? rej(e) : res({ type: "keyframe", data: r })); }));
      if (needDelta) tasks.push(new Promise((res, rej) => { zlib.deflate(deltaMsg, { level: 1 }, (e, r) => e ? rej(e) : res({ type: "delta", data: r })); }));
      if (tasks.length === 0) return;

      Promise.all(tasks).then((results) => {
        let compKF = null, compDelta = null;
        for (const r of results) { if (r.type === "keyframe") compKF = r.data; if (r.type === "delta") compDelta = r.data; }

        for (const { client, wantsKeyframe } of clientsSnapshot) {
          if (client.readyState !== WebSocket.OPEN) continue;
          if (wantsKeyframe && compKF) { safeSend(client, compKF); bytesSentWindow += compKF.length; }
          else if (compDelta) { safeSend(client, compDelta); bytesSentWindow += compDelta.length; }
          else if (compKF) { safeSend(client, compKF); bytesSentWindow += compKF.length; }
        }

        const now = Date.now();
        if (now - lastStatsTime >= 5000) {
          const kbps = ((bytesSentWindow / 1024) / ((now - lastStatsTime) / 1000)).toFixed(1);
          bytesSentTotal += bytesSentWindow;
          console.log(`[stats] ${kbps} KB/s out  |  ${wss.clients.size} client(s)  |  tick ${tickCount}  |  total ${(bytesSentTotal / 1048576).toFixed(1)} MB`);
          bytesSentWindow = 0;
          lastStatsTime = now;
        }
      }).catch((err) => { console.error("compression error:", err.message); });
    });
  }

  function startTickLoop() {
    setInterval(tick, 1000 / TICK_HZ);
  }

  return {
    universe,
    applyDrawMemo,
    processMockTransactions,
    attachWebSocket,
    startTickLoop,
    config: { width: WIDTH, height: HEIGHT, tickHz: TICK_HZ },
  };
}

module.exports = createEngine;
