#!/usr/bin/env node

/**
 * Latency Debugger — sends a transaction via RPC and polls both the local node
 * and the block explorer until it appears in both, printing detailed timing and
 * per-source status for every poll cycle.
 *
 * Usage:
 *   node examples/latency-debugger.js [--polls N] [--interval MS]
 *
 * Reads APP_PUBKEY, APP_SECRET_KEY, NODE_RPC_URL, EXPLORER_UPSTREAM, and
 * EXPLORER_UPSTREAM_BASE from .env (same keys as Last One Wins).
 */

const http = require("http");
const https = require("https");
const path = require("path");

// ── .env ────────────────────────────────────────────────────────────────────
const { loadEnvFile } = require("./lib/dapp-server");
loadEnvFile();

const APP_PUBKEY = process.env.APP_PUBKEY;
const APP_SECRET_KEY = process.env.APP_SECRET_KEY;
const NODE_RPC_URL = process.env.NODE_RPC_URL || "https://alpha2.usernodelabs.org";
const EXPLORER_UPSTREAM = process.env.EXPLORER_UPSTREAM || "alpha2.usernodelabs.org";
const EXPLORER_UPSTREAM_BASE =
  process.env.EXPLORER_UPSTREAM_BASE != null ? process.env.EXPLORER_UPSTREAM_BASE : "/api";

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return fallback;
  return Number(args[i + 1]);
}
const MAX_POLLS = flag("--polls", 120);
const POLL_INTERVAL_MS = flag("--interval", 1500);

// ── HTTP helper with timing ─────────────────────────────────────────────────
function timedFetch(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === "https:" ? https : http;
    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
    const t0 = performance.now();
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
        const elapsed = performance.now() - t0;
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`), { elapsedMs: elapsed }));
          return;
        }
        try {
          resolve({ data: JSON.parse(text), elapsedMs: elapsed, status: res.statusCode });
        } catch (e) {
          reject(Object.assign(new Error(`JSON parse: ${e.message}`), { elapsedMs: elapsed }));
        }
      });
    });
    req.on("error", (e) => reject(Object.assign(e, { elapsedMs: performance.now() - t0 })));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function explorerUrl(pathSuffix) {
  const proto = /^(localhost|127\.|192\.|10\.|172\.)/.test(EXPLORER_UPSTREAM) ? "http" : "https";
  return `${proto}://${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}${pathSuffix}`;
}

function ts() {
  return new Date().toISOString().slice(11, 23);
}

function ms(v) {
  return `${v.toFixed(0)}ms`;
}

// ── Node RPC polling helpers ────────────────────────────────────────────────

async function checkNodeMempool(txId) {
  try {
    const { data, elapsedMs } = await timedFetch(
      "GET",
      `${NODE_RPC_URL}/mempool?ids_only=true&limit=50`,
    );
    const ids = (data.ids || []).map(String);
    const found = ids.includes(txId);
    return { source: "mempool", found, elapsedMs, error: null };
  } catch (e) {
    return { source: "mempool", found: false, elapsedMs: e.elapsedMs || 0, error: e.message };
  }
}

async function checkNodeBlockchain(txId) {
  try {
    const { data, elapsedMs } = await timedFetch(
      "GET",
      `${NODE_RPC_URL}/blockchain/tx/${txId}`,
    );
    const found = data && data.included === true;
    return {
      source: "node-chain",
      found,
      elapsedMs,
      error: null,
      globalSlot: data.block ? data.block.global_slot : null,
    };
  } catch (e) {
    return { source: "node-chain", found: false, elapsedMs: e.elapsedMs || 0, error: e.message };
  }
}

async function checkExplorer(chainId, txId, memo) {
  try {
    const { data, elapsedMs } = await timedFetch(
      "POST",
      explorerUrl(`/${chainId}/transactions`),
      { sender: APP_PUBKEY, limit: 20 },
    );
    const items = data.items || [];
    const matchById = txId ? items.find((t) => (t.tx_id || t.id) === txId) : null;
    const matchByMemo = !matchById
      ? items.find((t) => t.memo === memo.slice(0, 200))
      : null;
    const match = matchById || matchByMemo;
    return {
      source: "explorer",
      found: !!match,
      elapsedMs,
      error: null,
      status: match ? match.status : null,
      blockHeight: match ? match.block_height : null,
      items: items.length,
    };
  } catch (e) {
    return { source: "explorer", found: false, elapsedMs: e.elapsedMs || 0, error: e.message };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!APP_PUBKEY || !APP_SECRET_KEY) {
    console.error("Missing APP_PUBKEY or APP_SECRET_KEY in .env");
    process.exit(1);
  }

  console.log("=== Latency Debugger ===");
  console.log(`  Node RPC:  ${NODE_RPC_URL}`);
  console.log(`  Explorer:  ${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}`);
  console.log(`  Pubkey:    ${APP_PUBKEY.slice(0, 20)}…`);
  console.log(`  Max polls: ${MAX_POLLS}  interval: ${POLL_INTERVAL_MS}ms`);
  console.log();

  // Step 1: Configure signer
  console.log(`[${ts()}] Configuring wallet signer...`);
  try {
    const { data, elapsedMs } = await timedFetch("POST", `${NODE_RPC_URL}/wallet/signer`, {
      secret_key: APP_SECRET_KEY,
    });
    console.log(`[${ts()}]   ✓ signer configured (${ms(elapsedMs)}) response: ${JSON.stringify(data)}`);
  } catch (e) {
    console.error(`[${ts()}]   ✗ signer config failed (${ms(e.elapsedMs || 0)}): ${e.message}`);
    process.exit(1);
  }

  // Step 2: Send self-transfer
  const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const memoJson = JSON.stringify({ app: "latency-debug", type: "ping", nonce });
  const memo = Buffer.from(memoJson).toString("base64url");
  const sendBody = {
    from_pk_hash: APP_PUBKEY,
    amount: 1,
    to_pk_hash: APP_PUBKEY,
    fee: 0,
    memo,
  };

  console.log(`[${ts()}] Sending self-transfer (nonce: ${nonce})...`);
  const sendStart = performance.now();
  let txId = null;
  try {
    const { data, elapsedMs } = await timedFetch("POST", `${NODE_RPC_URL}/wallet/send`, sendBody);
    txId = data.tx_id || data.txid || data.hash || null;
    console.log(`[${ts()}]   ✓ RPC returned (${ms(elapsedMs)}) queued=${data.queued} tx_id=${txId || "n/a"}`);
    if (data.error) console.log(`[${ts()}]   ⚠ RPC error field: ${data.error}`);
    if (!data.queued) {
      console.error(`[${ts()}]   ✗ Transaction was not queued. Aborting.`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[${ts()}]   ✗ RPC send failed (${ms(e.elapsedMs || 0)}): ${e.message}`);
    process.exit(1);
  }

  // Step 3: Discover chain ID
  console.log(`[${ts()}] Discovering chain ID...`);
  let chainId;
  try {
    const { data, elapsedMs } = await timedFetch("GET", explorerUrl("/active_chain"));
    chainId = data.chain_id;
    console.log(`[${ts()}]   ✓ chain_id=${chainId} (${ms(elapsedMs)})`);
  } catch (e) {
    console.error(`[${ts()}]   ✗ chain discovery failed (${ms(e.elapsedMs || 0)}): ${e.message}`);
    process.exit(1);
  }

  // Step 4: Poll node + explorer until tx appears in both
  console.log(`[${ts()}] Polling node + explorer for confirmation...`);
  console.log();

  let nodeChainConfirmed = false;
  let explorerConfirmed = false;
  let nodeChainTs = null;
  let explorerTs = null;
  let firstMempoolTs = null;

  for (let i = 1; i <= MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const sinceSend = performance.now() - sendStart;

    // Run all three checks in parallel
    const [mempool, nodeChain, explorer] = await Promise.all([
      txId ? checkNodeMempool(txId) : Promise.resolve({ source: "mempool", found: false, elapsedMs: 0, error: "no tx_id" }),
      txId ? checkNodeBlockchain(txId) : Promise.resolve({ source: "node-chain", found: false, elapsedMs: 0, error: "no tx_id" }),
      checkExplorer(chainId, txId, memo),
    ]);

    // Track first-seen timestamps
    if (mempool.found && !firstMempoolTs) firstMempoolTs = sinceSend;
    if (nodeChain.found && !nodeChainConfirmed) {
      nodeChainConfirmed = true;
      nodeChainTs = sinceSend;
    }
    if (explorer.found && explorer.status === "confirmed" && !explorerConfirmed) {
      explorerConfirmed = true;
      explorerTs = sinceSend;
    }

    // Format status for each source
    const mempoolStr = mempool.error
      ? `err`
      : mempool.found ? `✓ in mempool` : `not in mempool`;
    const nodeChainStr = nodeChain.error && !nodeChain.found
      ? `not found`
      : nodeChain.found ? `✓ slot=${nodeChain.globalSlot || "?"}` : `not found`;
    const explorerStr = explorer.error
      ? `err`
      : explorer.found ? `✓ ${explorer.status || "?"} block=${explorer.blockHeight || "?"}` : `not found (${explorer.items} items)`;

    const maxRpc = Math.max(mempool.elapsedMs, nodeChain.elapsedMs).toFixed(0);

    console.log(
      `[${ts()}] #${String(i).padStart(3)} | ` +
      `${ms(sinceSend).padStart(8)} | ` +
      `node: ${mempoolStr}, ${nodeChainStr} (${maxRpc}ms) | ` +
      `explorer: ${explorerStr} (${ms(explorer.elapsedMs)})`,
    );

    if (nodeChainConfirmed && explorerConfirmed) {
      const totalMs = performance.now() - sendStart;

      console.log();
      console.log("=== CONFIRMED (both node + explorer) ===");
      console.log(`  tx_id:             ${txId || "?"}`);
      console.log(`  total_time:        ${ms(totalMs)}`);
      if (firstMempoolTs) {
        console.log(`  first_in_mempool:  ${ms(firstMempoolTs)} after send`);
      }
      if (nodeChainTs) {
        console.log(`  node_blockchain:   ${ms(nodeChainTs)} after send`);
      }
      if (explorerTs) {
        console.log(`  explorer_confirm:  ${ms(explorerTs)} after send`);
      }
      if (nodeChainTs && explorerTs) {
        const delta = explorerTs - nodeChainTs;
        console.log(`  explorer_lag:      ${ms(delta)} (explorer behind node)`);
      }
      console.log(`  polls:             ${i}`);
      break;
    }
  }

  if (!nodeChainConfirmed || !explorerConfirmed) {
    const elapsed = performance.now() - sendStart;
    console.log();
    console.log(`=== NOT FULLY CONFIRMED after ${MAX_POLLS} polls (${ms(elapsed)}) ===`);
    console.log(`  node blockchain: ${nodeChainConfirmed ? "✓" : "✗"}`);
    console.log(`  explorer:        ${explorerConfirmed ? "✓" : "✗"}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
