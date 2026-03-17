/**
 * Falling-sands simulation engine.
 *
 * Runs the WASM universe server-side for snapshot generation and relays
 * transactions to connected clients via WebSocket. Clients run their own
 * local WASM simulation for rendering (see wasm-browser.js + index.html).
 *
 * Usage:
 *   const createEngine = require('./engine');
 *   const engine = createEngine({ wasmLoaderPath: './wasm-loader' });
 *   engine.attachWebSocket(httpServer);
 *   engine.startTickLoop();
 *   engine.addTransaction({ timestamp_ms, memo, from });
 */

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { seedUniverse, WIDTH, HEIGHT, CELL_BYTES, FRAME_SIZE } = require("./seed-content");

const TICK_HZ = 30;
const TICK_INTERVAL_MS = 1000 / TICK_HZ;
const PING_INTERVAL = 20_000;

// Default epoch (Jan 1, 2026). Overridden per-engine by chain genesis time.
const DEFAULT_TICK_EPOCH = 1767225600000;

const SNAPSHOT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours (disk saves)
const CHECKPOINT_INTERVAL_TICKS = TICK_HZ * 5;    // every 5 seconds
const MAX_CHECKPOINTS = 24;

// Physics only runs for WINDOW_SECONDS after genesis or any draw transaction.
const WINDOW_SECONDS = 10 * 60;
const WINDOW_TICKS = WINDOW_SECONDS * TICK_HZ;

function createEngine(opts) {
  const wasmLoaderPath = (opts && opts.wasmLoaderPath) || "./wasm-loader";
  const snapshotDir = (opts && opts.snapshotDir) || __dirname;
  const chainId = (opts && opts.chainId) || null;
  const TICK_EPOCH = (opts && opts.epoch) || DEFAULT_TICK_EPOCH;

  function timestampToTick(ms) { return Math.floor((ms - TICK_EPOCH) / TICK_INTERVAL_MS); }
  function tickToTimestamp(tick) { return TICK_EPOCH + tick * TICK_INTERVAL_MS; }
  const { Universe, Species, memory, prng } = require(wasmLoaderPath);

  const universe = Universe.new(WIDTH, HEIGHT);

  const { sourcesEnabled } = seedUniverse(universe, Species, memory, {
    openBottom: process.env.FALLING_SANDS_OPEN_BOTTOM !== "false",
    sources: process.env.FALLING_SANDS_SOURCES !== "false",
    plantAbsorbs: process.env.FALLING_SANDS_PLANT_ABSORBS !== "false",
  });

  // ── Tick state ──────────────────────────────────────────────────────────

  let tickCount = timestampToTick(Date.now());
  let ticksProcessed = 0;

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
        const timestampMs = tx.created_at ? Date.parse(tx.created_at) : Date.now();
        const ageMs = Date.now() - timestampMs;
        const assignedTick = timestampToTick(timestampMs);
        console.log(`[sands-tx] mock tx picked up: created_at age=${(ageMs / 1000).toFixed(1)}s  assignedTick=${assignedTick}  serverTick=${tickCount}`);
        addTransaction({
          timestamp_ms: timestampMs,
          memo,
          from: tx.from_pubkey || "mock",
        });
      } catch (_) {}
    }
    lastProcessedTxIdx = transactions.length;
  }

  // ── Snapshot system ─────────────────────────────────────────────────────

  let lastSnapshot = null;
  let transactionsSinceSnapshot = [];
  let lastSnapshotTime = Date.now();

  function captureSnapshot() {
    const cellsCopy = Buffer.from(new Uint8Array(memory.buffer, universe.cells(), FRAME_SIZE));
    const windsCopy = Buffer.from(new Uint8Array(memory.buffer, universe.winds(), FRAME_SIZE));
    const burnsCopy = Buffer.from(new Uint8Array(memory.buffer, universe.burns(), FRAME_SIZE));

    const allBufs = Buffer.concat([cellsCopy, windsCopy, burnsCopy]);
    const compressed = zlib.deflateSync(allBufs, { level: 1 });
    lastSnapshot = {
      tick: tickCount,
      timestamp: Date.now(),
      cells_b64: compressed.toString("base64"),
      prng_state: prng ? prng.getState() : 0,
      generation: universe.generation ? universe.generation() : 0,
      wasm_rng_state: universe.rng_state ? String(universe.rng_state()) : "0",
      buffers: 3,
      width: WIDTH,
      height: HEIGHT,
      chain_id: chainId || undefined,
      epoch: TICK_EPOCH,
    };
    transactionsSinceSnapshot = [];
    lastSnapshotTime = Date.now();
    console.log(`[snapshot] created at tick ${tickCount} (${(compressed.length / 1024).toFixed(1)} KB compressed)`);
    return lastSnapshot;
  }

  function saveSnapshotToDisk() {
    if (!lastSnapshot) return;
    try {
      const filePath = path.join(snapshotDir, "snapshot.json");
      fs.writeFileSync(filePath, JSON.stringify(lastSnapshot));
      console.log(`[snapshot] saved to ${filePath}`);
    } catch (e) {
      console.warn(`[snapshot] failed to save: ${e.message}`);
    }
  }

  function loadSnapshotFromDisk() {
    try {
      const filePath = path.join(snapshotDir, "snapshot.json");
      if (!fs.existsSync(filePath)) return false;
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!data.cells_b64 || !data.tick) return false;

      const compressed = Buffer.from(data.cells_b64, "base64");
      const raw = zlib.inflateSync(compressed);

      if (data.buffers === 3 && raw.length === FRAME_SIZE * 3) {
        new Uint8Array(memory.buffer, universe.cells(), FRAME_SIZE)
          .set(new Uint8Array(raw.buffer, raw.byteOffset, FRAME_SIZE));
        new Uint8Array(memory.buffer, universe.winds(), FRAME_SIZE)
          .set(new Uint8Array(raw.buffer, raw.byteOffset + FRAME_SIZE, FRAME_SIZE));
        new Uint8Array(memory.buffer, universe.burns(), FRAME_SIZE)
          .set(new Uint8Array(raw.buffer, raw.byteOffset + FRAME_SIZE * 2, FRAME_SIZE));
      } else {
        new Uint8Array(memory.buffer, universe.cells(), FRAME_SIZE)
          .set(new Uint8Array(raw.buffer, raw.byteOffset, raw.length));
      }

      tickCount = data.tick;
      if (prng && data.prng_state !== undefined) prng.setState(data.prng_state);
      if (universe.set_generation && data.generation !== undefined) universe.set_generation(data.generation);
      if (universe.set_rng_state && data.wasm_rng_state !== undefined) {
        universe.set_rng_state(BigInt(data.wasm_rng_state));
      }
      lastSnapshot = data;
      console.log(`[snapshot] loaded from disk at tick ${tickCount}`);
      return true;
    } catch (e) {
      console.warn(`[snapshot] failed to load from disk: ${e.message}`);
      return false;
    }
  }

  // ── Windowed deterministic replay ────────────────────────────────────────
  //
  // Physics only simulates during "active windows": 10 minutes after genesis
  // and 10 minutes after each draw transaction. Between windows the canonical
  // state freezes and tickCount jumps forward without physics.

  const replayTxs = (opts && opts.replayTxs) || [];
  let activeUntilTick = 0;

  let snapshotLoaded = loadSnapshotFromDisk();

  if (snapshotLoaded && lastSnapshot) {
    let discard = false;
    const reason = [];

    const snapChain = lastSnapshot.chain_id || null;
    const snapEpoch = lastSnapshot.epoch || DEFAULT_TICK_EPOCH;

    if (chainId && snapChain && snapChain !== chainId) {
      reason.push(`chain_id mismatch (snapshot: ${snapChain.slice(0, 16)}…, current: ${chainId.slice(0, 16)}…)`);
      discard = true;
    }
    if (snapEpoch !== TICK_EPOCH) {
      reason.push(`epoch mismatch (snapshot: ${new Date(snapEpoch).toISOString()}, current: ${new Date(TICK_EPOCH).toISOString()})`);
      discard = true;
    }

    if (discard) {
      console.log(`[snapshot] discarding disk snapshot: ${reason.join("; ")}`);
      snapshotLoaded = false;
    }
  }

  if (!snapshotLoaded) {
    tickCount = 0;
  }

  // Parse replay txs: extract timestamp + drawing memo, filter to sands draws
  const replayDraws = [];
  for (const tx of replayTxs) {
    try {
      if (!tx.memo) continue;
      const memo = typeof tx.memo === "string" ? JSON.parse(tx.memo) : tx.memo;
      if (memo.app !== "falling-sands" || memo.type !== "draw") continue;
      const ts = tx.timestamp_ms || (tx.created_at ? Date.parse(tx.created_at) : 0);
      if (!ts) continue;
      const txTick = timestampToTick(ts);
      if (txTick <= tickCount) continue;
      replayDraws.push({ tick: txTick, memo, from: tx.source || tx.from_pubkey || "chain" });
    } catch (_) {}
  }
  replayDraws.sort((a, b) => a.tick - b.tick);

  // Genesis window: simulate 10 min from wherever we start
  activeUntilTick = tickCount + WINDOW_TICKS;

  const nowTick = timestampToTick(Date.now());
  const replayT0 = Date.now();
  let lastProgressLog = replayT0;
  let drawsApplied = 0;
  let physicsTicksSimulated = 0;
  let ticksSkipped = 0;

  {
    const fromLabel = snapshotLoaded ? `snapshot tick ${tickCount}` : "genesis (tick 0)";
    const timelineSpan = Math.max(0, nowTick - tickCount);
    console.log(`[replay] starting from ${fromLabel}, timeline span ${timelineSpan} ticks (${(timelineSpan / TICK_HZ).toFixed(1)}s), ${replayDraws.length} draw txs, window=${WINDOW_SECONDS}s`);
  }

  const REPLAY_BATCH = 512;

  function advancePhysicsTo(target) {
    while (tickCount < target) {
      const chunk = Math.min(REPLAY_BATCH, target - tickCount);
      universe.tick_n(chunk);
      tickCount += chunk;
      physicsTicksSimulated += chunk;

      const now = Date.now();
      if (now - lastProgressLog >= 2000) {
        const elapsed = ((now - replayT0) / 1000).toFixed(1);
        const rate = physicsTicksSimulated > 0 ? (physicsTicksSimulated / ((now - replayT0) / 1000)).toFixed(0) : "?";
        console.log(`[replay] tick ${tickCount} — ${elapsed}s elapsed — ${rate} ticks/s — ${physicsTicksSimulated} simulated, ${ticksSkipped} skipped — ${drawsApplied}/${replayDraws.length} draws`);
        lastProgressLog = now;
      }
    }
  }

  for (const draw of replayDraws) {
    const drawTick = Math.min(draw.tick, nowTick);

    if (drawTick > activeUntilTick) {
      // Finish the current active window
      const windowEnd = Math.min(activeUntilTick, nowTick);
      if (tickCount < windowEnd) advancePhysicsTo(windowEnd);
      // Skip the gap
      const gap = drawTick - tickCount;
      if (gap > 0) {
        ticksSkipped += gap;
        tickCount = drawTick;
      }
    } else {
      // Still within the active window — simulate up to the draw
      if (tickCount < drawTick) advancePhysicsTo(drawTick);
    }

    // Extend the window past this draw
    activeUntilTick = Math.max(activeUntilTick, drawTick + WINDOW_TICKS);

    applyDrawMemo(draw.memo, `${(draw.from || "").slice(0, 16)}… (replay)`);
    drawsApplied++;
  }

  // Finish the final active window (capped at now)
  const finalWindowEnd = Math.min(activeUntilTick, nowTick);
  if (tickCount < finalWindowEnd) advancePhysicsTo(finalWindowEnd);

  // If we're still behind now, skip the remaining gap (frozen period)
  if (tickCount < nowTick) {
    ticksSkipped += nowTick - tickCount;
    tickCount = nowTick;
  }

  {
    const elapsed = ((Date.now() - replayT0) / 1000).toFixed(1);
    console.log(`[replay] complete in ${elapsed}s — ${physicsTicksSimulated} ticks simulated (${(physicsTicksSimulated / TICK_HZ).toFixed(1)}s of physics), ${ticksSkipped} skipped — ${drawsApplied} draws applied — canonical tick ${tickCount}`);
  }

  captureSnapshot();
  if (physicsTicksSimulated > TICK_HZ * 60) {
    saveSnapshotToDisk();
  }

  // ── Transaction management ──────────────────────────────────────────────

  function addTransaction(txData) {
    const tx = {
      timestamp_ms: txData.timestamp_ms || Date.now(),
      memo: txData.memo,
      from: txData.from || "unknown",
    };

    // Check if this is a draw — if so, it activates the physics window
    const isDraw = tx.memo && tx.memo.app === "falling-sands" && tx.memo.type === "draw";

    if (isDraw) {
      const drawTick = timestampToTick(tx.timestamp_ms);
      const wasFrozen = tickCount >= activeUntilTick;

      // If the draw is ahead of our canonical tick, advance physics to it
      if (drawTick > tickCount && drawTick > activeUntilTick) {
        // We were frozen — skip the gap to the draw tick
        tickCount = drawTick;
      } else if (drawTick > tickCount) {
        // Still in an active window — simulate up to the draw
        const target = Math.min(drawTick, activeUntilTick);
        while (tickCount < target) {
          universe.tick();
          tickCount++;
        }
        if (drawTick > tickCount) tickCount = drawTick;
      }

      // Apply the draw to the canonical state
      applyDrawMemo(tx.memo, `${(tx.from || "").slice(0, 16)}… (live)`);

      // Extend the active window
      activeUntilTick = Math.max(activeUntilTick, drawTick + WINDOW_TICKS);

      // Capture fresh snapshot and resync all clients
      captureSnapshot();
      broadcastResync();

      console.log(`[window] draw received — canonical tick ${tickCount}, active until tick ${activeUntilTick} (${((activeUntilTick - tickCount) / TICK_HZ).toFixed(0)}s remaining)`);
    }

    transactionsSinceSnapshot.push(tx);
  }

  // ── WebSocket — transaction relay ───────────────────────────────────────

  let wss = null;
  const readyClients = new WeakSet();

  function safeSend(ws, data) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(data); }
    catch (e) { console.error("send error:", e.message); }
  }

  function broadcastResync() {
    if (!wss) return;
    const msg = JSON.stringify({
      type: "resync",
      snapshot: lastSnapshot,
      transactions: transactionsSinceSnapshot,
      epoch: TICK_EPOCH,
      tickHz: TICK_HZ,
      activeUntilTick,
    });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN && readyClients.has(client)) {
        safeSend(client, msg);
      }
    }
  }

  function sendInitMessage(ws) {
    captureSnapshot();

    const frozen = tickCount >= activeUntilTick;
    const snapshotAgeSec = ((Date.now() - lastSnapshotTime) / 1000).toFixed(1);
    const txsSince = transactionsSinceSnapshot.length;
    console.log(`[init] snapshot at tick ${lastSnapshot.tick}  age=${snapshotAgeSec}s  frozen=${frozen}  txsSinceSnapshot=${txsSince}`);

    const initMsg = {
      type: "init",
      config: { width: WIDTH, height: HEIGHT, sources: sourcesEnabled },
      epoch: TICK_EPOCH,
      tickHz: TICK_HZ,
      snapshot: lastSnapshot,
      transactions: transactionsSinceSnapshot,
      frozen,
      activeUntilTick: frozen ? tickCount : activeUntilTick,
    };
    safeSend(ws, JSON.stringify(initMsg));
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
            readyClients.add(ws);
            sendInitMessage(ws);
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

  let lastStatsTime = Date.now();
  let wasActive = tickCount < activeUntilTick;

  function tick() {
    const wallTick = timestampToTick(Date.now());
    const isActive = tickCount < activeUntilTick && tickCount < wallTick;

    if (isActive) {
      universe.tick();
      tickCount++;
      ticksProcessed++;
    }

    // Transition active → frozen: save snapshot
    if (wasActive && !isActive) {
      console.log(`[window] physics frozen at tick ${tickCount}`);
      captureSnapshot();
      saveSnapshotToDisk();
    }
    wasActive = isActive;

    // Periodic snapshot (while active)
    if (isActive && Date.now() - lastSnapshotTime >= SNAPSHOT_INTERVAL_MS) {
      captureSnapshot();
      saveSnapshotToDisk();
    }

    // Periodic stats
    const now = Date.now();
    if (now - lastStatsTime >= 10000) {
      const clientCount = wss ? wss.clients.size : 0;
      const txCount = transactionsSinceSnapshot.length;
      const state = isActive ? "active" : "frozen";
      console.log(`[stats] tick ${tickCount} (${state})  |  ${clientCount} client(s)  |  ${txCount} txs since snapshot`);
      lastStatsTime = now;
    }
  }

  function startTickLoop() {
    setInterval(tick, 1000 / TICK_HZ);
  }

  // ── HTTP handlers for snapshot and transactions ─────────────────────────

  function handleSnapshotRequest(req, res) {
    if (!lastSnapshot) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No snapshot available" }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30",
    });
    res.end(JSON.stringify(lastSnapshot));
  }

  function handleTransactionsRequest(req, res) {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({
      epoch: TICK_EPOCH,
      tickHz: TICK_HZ,
      currentTick: tickCount,
      transactions: transactionsSinceSnapshot,
    }));
  }

  return {
    universe,
    applyDrawMemo,
    addTransaction,
    processMockTransactions,
    attachWebSocket,
    startTickLoop,
    handleSnapshotRequest,
    handleTransactionsRequest,
    captureSnapshot,
    config: { width: WIDTH, height: HEIGHT, tickHz: TICK_HZ, epoch: TICK_EPOCH },
  };
}

module.exports = createEngine;
