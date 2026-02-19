# Skill: Building Usernode Dapps

> **Audience**: AI coding assistants and developers.
> Read this file, then read the other files in this repo, and you'll know how to build a complete Usernode dapp from scratch at a user's direction.

---

## 1. What This Repo Is

A **minimal, clone-and-go starter** for building dapps on the Usernode blockchain. Each dapp is a **single self-contained HTML file** (HTML + CSS + JS) that runs in two modes:

- **Local dev mode** — served by `server.js` at `localhost:8000`, using mock endpoints.
- **Dapp mode** — loaded inside the **Usernode Flutter mobile app** WebView, using the native bridge.

The bridge (`usernode-bridge.js`) abstracts the difference, so your dapp code is identical in both modes.

---

## 2. The Three APIs

Your dapp has exactly three primitives. All are async and return Promises.

### `getNodeAddress()` → `string`
Returns the current user's public key / address. In local dev, this is a stable mock value from `localStorage`.

### `sendTransaction(destination_pubkey, amount, memo, opts?)` → `object`
Sends a transaction. **Returns only after the tx is confirmed on-chain** (visible in `getTransactions`), by internally polling.

| Param | Type | Description |
|---|---|---|
| `destination_pubkey` | string | Your app's public key (the "app address") |
| `amount` | number | Token amount — always use `1` (type discrimination is done via memo) |
| `memo` | string | JSON-encoded payload — this is where your app data lives |
| `opts.timeoutMs` | number | Max wait for inclusion (default 20s; **recommend 90s** for real chains) |
| `opts.pollIntervalMs` | number | Poll interval (default 750ms; **recommend 1500ms** for real chains) |
| `opts.waitForInclusion` | boolean | Set `false` to fire-and-forget (default `true`) |

### `getTransactions(filterOptions?)` → `{ items: Transaction[] }`
Fetches transactions. In local dev, returns from the in-memory mock store. In dapp mode, fetches from a configured remote URL or native bridge.

| Field | Type | Description |
|---|---|---|
| `filterOptions.limit` | number | Max transactions to return |
| `filterOptions.account` | string | Filter by account (some implementations) |

---

## 3. Core Architecture Pattern

**By default, dapp state lives on-chain as transaction memos.** This is the simplest approach and requires no backend database — all data is shared, persistent, and visible to every user automatically. Apps *may* also use a database or other storage for supplemental data, but the default is to keep everything on-chain when possible.

The basic pattern is:

1. **Write** — `sendTransaction(APP_PUBKEY, amount, JSON.stringify(payload))` to store data.
2. **Read** — `getTransactions()` to fetch all transactions, then scan memos to derive current state.
3. **Derive** — Parse memos, apply conflict resolution rules (e.g., "latest write wins", "oldest submission wins"), and render.

### The App Public Key

Every dapp defines a single **app public key** (`APP_PUBKEY`) that acts as the shared address. All transactions are sent **to** this address, and all reads filter **by** this address. This is how all users of a dapp share the same transaction history.

```js
const APP_PUBKEY =
  window.localStorage.getItem("myapp:app_pubkey") || "ut1_myapp_default_pubkey";
```

### Memo Format

Memos are JSON strings with a standard shape:

```js
JSON.stringify({
  app: "myapp",          // app identifier — always include for filtering
  type: "create_thing",  // action type — how you distinguish different operations
  // ... action-specific payload
})
```

Always include `app` so your dapp's transactions can be distinguished from noise. Parse with a safe helper:

```js
function parseMemo(m) {
  if (m == null) return null;
  try { return JSON.parse(String(m)); } catch (_) { return null; }
}
```

### Transaction Normalization

Transaction objects may come in different shapes depending on the source (mock server, native bridge, explorer API). Always normalize:

```js
function normalizeTx(tx) {
  if (!tx || typeof tx !== "object") return null;
  return {
    id:     tx.tx_id || tx.id || tx.txid || tx.hash || null,
    from:   tx.from_pubkey || tx.from || tx.source || null,
    to:     tx.destination_pubkey || tx.to || tx.destination || null,
    amount: tx.amount || null,
    memo:   tx.memo != null ? String(tx.memo) : null,
    ts:     extractTimestamp(tx) || Date.now(),
  };
}
```

### Shared Filter Helper

Since every loop in your dapp will parse + filter CIS transactions the same way, extract a helper:

```js
function parseAppTx(rawTx) {
  const tx = normalizeTx(rawTx);
  if (!tx || !tx.from || !tx.to || tx.to !== APP_PUBKEY) return null;
  const memo = parseMemo(tx.memo);
  if (!memo || memo.app !== "myapp") return null;
  return { tx, memo };
}
```

This eliminates copy-pasting the same 6-line filter in every function.

---

## 4. Transaction Types Are Memo-Only

All transaction type discrimination is done via the `type` field in the JSON memo — **not** via the `amount` field. Use `amount = 1` for all transactions. The memo is the single source of truth for what a transaction means.

```js
// Every sendTransaction call uses amount = 1:
await sendTransaction(APP_PUBKEY, 1, JSON.stringify({
  app: "myapp",
  type: "vote",
  survey: "survey_123",
  choice: "option_a",
}), TX_SEND_OPTS);
```

---

## 5. Conflict Resolution Patterns

How your app handles multiple transactions from the same user is entirely **up to you and the user's requirements**. Some apps may accept every transaction as-is (e.g., a chat app where every message is valid). Others need conflict resolution. Here are common patterns from the CIS example — use them if they fit, or design your own:

### Latest Write Wins (Usernames, Votes)
Track `(sender, timestamp)` and keep the most recent value per sender.

```js
// One vote per user — latest wins
if (tx.ts >= entry.voteTs) {
  entry.voteKey = newVoteKey;
  entry.voteTs = tx.ts;
}
```

### Oldest Write Wins (Custom Options)
Track `(sender, timestamp)` and keep the earliest value per sender.

```js
// One custom option per user per survey — oldest wins
if (!prev || tx.ts < prev.ts) {
  optionsBySender.set(tx.from, { key, label, ts: tx.ts });
}
```

### Rate Limiting (Survey Cooldown)
Enforce time-based limits per sender when rebuilding state:

```js
const lastAccepted = lastAcceptedBySender.get(sender);
if (lastAccepted != null && tx.ts - lastAccepted < COOLDOWN_MS) continue; // skip
lastAcceptedBySender.set(sender, tx.ts);
```

### Every Transaction Valid
For apps like chat, logs, or feeds, you may not need conflict resolution at all — every transaction is simply appended:

```js
messages.push({ from: tx.from, text: memo.text, ts: tx.ts });
```

> **Important**: If your app does have rules, always enforce them when *reading* (rebuilding state from transactions), not just when writing. A client-side check before `sendTransaction` is a UX convenience; the authoritative enforcement happens during `getTransactions` parsing.

---

## 6. UI Patterns

### Single HTML File Structure (Default)

The default and simplest approach is a single self-contained HTML file with inline CSS and JS — no build step, no modules. This is optional; you can use multiple files, a framework, or a build pipeline if the user prefers. But single-file is the starting point.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>My Dapp</title>
  <script src="/usernode-bridge.js"></script>
  <style>/* ... */</style>
</head>
<body>
  <!-- HTML structure -->
  <script>
    (function () {
      // All JS in one IIFE — no modules, no build step
    })();
  </script>
</body>
</html>
```

### Dark/Light Theme

Use CSS custom properties with `prefers-color-scheme`:

```css
:root {
  color-scheme: light dark;
  --bg: #0b0f16; --fg: #e7edf7; --muted: #a8b3c7;
  --card: #141b26; --border: rgba(255,255,255,0.12);
  --accent: #6ea8fe; --danger: #ff6b6b; --ok: #5dd39e;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f7f8fb; --fg: #0b1220; --muted: #4b5568;
    --card: #ffffff; --border: rgba(15,23,42,0.12);
    --accent: #2563eb; --danger: #c81e1e; --ok: #0f766e;
  }
}
```

### Full-Height Mobile Layout

Use a fixed header + scrollable content area (matches the Usernode app chrome):

```css
body { margin: 0; height: 100vh; height: 100dvh; }
main { height: 100vh; height: 100dvh; display: flex; padding: 16px; box-sizing: border-box; }
.appCard { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.header { flex: 0 0 auto; z-index: 2; background: var(--card); }
.content { flex: 1 1 auto; overflow-y: auto; min-height: 0; }
```

### Navigation Between Screens

Use `show(el, bool)` to toggle `.hide` class. No routing library needed.

```js
function show(el, on) { el.classList.toggle("hide", !on); }
function navigateToList() {
  currentId = null;
  show(listScreen, true);
  show(detailScreen, false);
}
function navigateToDetail(id) {
  currentId = id;
  show(listScreen, false);
  show(detailScreen, true);
}
```

### Transaction Progress Bar

Blockchain transactions can take 30–90+ seconds. A simple spinner gives users no feedback about whether things are progressing or stuck. All dapps in this repo use a **time-based progress bar with escalating warnings** instead — this should be the default for every new dapp.

**HTML** (place next to your send button):

```html
<div class="tx-progress hide" id="txProgress">
  <div class="tx-progress-track"><div class="tx-progress-fill"></div></div>
  <div class="tx-progress-label">Sending...</div>
</div>
```

**CSS**:

```css
.tx-progress { width: 100%; margin: 8px 0 4px; }
.tx-progress .tx-progress-track {
  width: 100%; height: 6px; border-radius: 3px;
  background: var(--border); overflow: hidden;
}
.tx-progress .tx-progress-fill {
  height: 100%; width: 0%; border-radius: 3px;
  background: var(--accent);
  transition: width 0.4s ease-out, background-color 0.4s ease;
}
.tx-progress .tx-progress-fill.ok   { background: #6ef0a8; }
.tx-progress .tx-progress-fill.warn { background: #e6a817; }
.tx-progress .tx-progress-fill.err  { background: var(--danger); }
.tx-progress .tx-progress-label {
  font-size: 12px; color: var(--muted); margin-top: 4px;
}
.tx-progress .tx-progress-label.warn { color: #e6a817; }
.tx-progress .tx-progress-label.err  { color: var(--danger); }
.tx-progress.hide { display: none; }
```

**JS controller** — three time thresholds drive the bar color and label:

```js
const TX_PB_EXPECTED_S = 30;  // bar reaches ~95% here (normal case)
const TX_PB_WARN_S    = 45;  // bar turns amber + "Taking longer than expected"
const TX_PB_ERR_S     = 90;  // bar turns red + "check Discord"
let _pbRaf = null, _pbStart = 0;

// Eased curve: cubic ease-out to 95%, then asymptotic approach to 100%
function pbPercent(s) {
  if (s <= TX_PB_EXPECTED_S) {
    const t = s / TX_PB_EXPECTED_S;
    return 95 * (1 - Math.pow(1 - t, 3));
  }
  return 95 + 5 * (1 - Math.exp(-(s - TX_PB_EXPECTED_S) / 120));
}

function pbApply(pct, s) {
  const el = document.getElementById("txProgress");
  if (!el) return;
  const fill  = el.querySelector(".tx-progress-fill");
  const label = el.querySelector(".tx-progress-label");
  if (fill) {
    fill.style.width = pct + "%";
    fill.className = "tx-progress-fill" +
      (s >= TX_PB_ERR_S ? " err" : s >= TX_PB_WARN_S ? " warn" : "");
  }
  if (label) {
    if (s >= TX_PB_ERR_S)      { label.textContent = "Taking longer than it should; check Discord"; label.className = "tx-progress-label err"; }
    else if (s >= TX_PB_WARN_S) { label.textContent = "Taking longer than expected"; label.className = "tx-progress-label warn"; }
    else                        { label.textContent = "Sending..."; label.className = "tx-progress-label"; }
  }
}

function startProgressBar() {
  stopProgressBar();
  const el = document.getElementById("txProgress");
  if (el) {
    el.classList.remove("hide");
    const fill  = el.querySelector(".tx-progress-fill");
    const label = el.querySelector(".tx-progress-label");
    if (fill)  { fill.style.width = "0%"; fill.className = "tx-progress-fill"; }
    if (label) { label.textContent = "Sending..."; label.className = "tx-progress-label"; }
  }
  _pbStart = performance.now();
  (function tick() {
    const s = (performance.now() - _pbStart) / 1000;
    pbApply(pbPercent(s), s);
    _pbRaf = requestAnimationFrame(tick);
  })();
}

function completeProgressBar() {
  stopProgressBar();
  const el = document.getElementById("txProgress");
  if (!el) return;
  const fill  = el.querySelector(".tx-progress-fill");
  const label = el.querySelector(".tx-progress-label");
  if (fill)  { fill.className = "tx-progress-fill ok"; fill.style.width = "100%"; }
  if (label) { label.textContent = "Confirmed!"; label.className = "tx-progress-label"; }
  setTimeout(() => el.classList.add("hide"), 1200);
}

function stopProgressBar() {
  if (_pbRaf) { cancelAnimationFrame(_pbRaf); _pbRaf = null; }
}
```

**Usage** — wrap every `sendTransaction` call:

```js
startProgressBar();
try {
  await sendTransaction(APP_PUBKEY, 1, memo, TX_SEND_OPTS);
  completeProgressBar();
} catch (e) {
  stopProgressBar();
  showError("Send failed: " + (e.message || e));
}
```

Also disable interactive elements during the send so users can't double-submit:

```js
function setSending(v) {
  sending = !!v;
  document.querySelectorAll("button, input, select").forEach(el => { el.disabled = !!v; });
  if (v) startProgressBar();
}
```

### Sticky Error Display

If your dapp has periodic status updates (FPS counter, WebSocket reconnect, polling indicator), error messages will be instantly overwritten. Use a holdoff timer so errors stay visible:

```js
let errorStickyUntil = 0;
const ERROR_HOLD_MS = 8000;

function showError(msg) {
  statusEl.className = "err";
  statusEl.textContent = msg;
  errorStickyUntil = performance.now() + ERROR_HOLD_MS;
}

function canOverwriteStatus() {
  return performance.now() >= errorStickyUntil;
}

// In your periodic status updater:
if (canOverwriteStatus()) {
  statusEl.className = "ok";
  statusEl.textContent = "Connected";
}
```

### Rubber-Band Scroll

For a native-feeling pull gesture at the edges of the scroll area, implement a pointer-event-based rubber-band effect. See the `attachRubberBand()` function in `examples/cis/usernode_cis.html` for the full implementation.

### Building DOM Safely (No innerHTML for User Content)

Always use `document.createElement` + `textContent` for user-generated content to prevent XSS:

```js
const title = document.createElement("div");
title.textContent = survey.title; // Safe — no HTML injection
```

Never use `innerHTML` with user-provided strings (survey titles, usernames, option labels, etc.).

---

## 7. Polling & Real-Time Updates

### Background Refresh Loop

A simple default is to poll `getTransactions` every ~4 seconds to keep the UI current. The interval is up to you — adjust based on how real-time your app needs to feel:

```js
async function refreshLoop() {
  const txs = await getAppTransactions();
  rebuildState(txs);
  renderUI();
}
await refreshLoop();
setInterval(refreshLoop, 4000); // Adjust interval as needed
```

### Fast Ticker for Countdowns

For time-sensitive displays (countdown timers under 1 hour), add a 1-second interval:

```js
setInterval(() => {
  document.querySelectorAll("[data-expires]").forEach(el => {
    el.textContent = formatCountdown(Number(el.dataset.expires));
  });
}, 1000);
```

### Post-Action Refresh

After every `sendTransaction`, immediately call `refreshLoop()` so the UI updates without waiting for the next poll cycle:

```js
await sendTransaction(APP_PUBKEY, 1, memo, TX_SEND_OPTS);
await refreshLoop(); // Immediate update
```

---

## 8. Username System

A standard pattern for dapps that want user identity:

1. **Default**: `user_<last 6 chars of pubkey>`.
2. **Custom**: User picks a base name; the suffix `_<last6>` is always appended and non-editable.
3. **Storage**: `{ app: "myapp", type: "set_username", username: "alice_a1b2c3" }` sent via `sendTransaction`.
4. **Resolution**: Latest `set_username` tx per sender wins.
5. **UI**: A clickable pill in the header opens an inline form with a non-editable suffix display.

```html
<div class="inputAffix">
  <input id="usernameInput" class="inputAffixField" maxlength="24" />
  <span id="usernameSuffix" class="inputAffixSuffix">_a1b2c3</span>
</div>
```

---

## 9. Survey / Voting Pattern (One Example — Not the Only One)

The CIS example (`examples/cis/usernode_cis.html`) implements a complete survey/voting system as a reference. This is just one type of app — users will want to build all kinds of things: games, chat apps, marketplaces, collaborative tools, etc. Study this example for the patterns, then adapt to whatever the user wants to build.

Key transaction types in the CIS example:

| `type` | Payload | Rule |
|--------|---------|------|
| `create_survey` | `{ survey: { id, title, question, options, active_duration_ms } }` | One per sender per 24h (enforced on read) |
| `vote` | `{ survey: "id", choice: "option_key" }` | Latest per sender per survey wins |
| `add_option` | `{ survey: "id", option: { key, label } }` | One per sender per survey, oldest wins |
| `set_username` | `{ username: "name_suffix" }` | Latest per sender wins |

### Survey Lifecycle
- **Active**: `Date.now() < createdAtMs + activeDurationMs`
- **Archived**: `Date.now() >= createdAtMs + activeDurationMs` → read-only, no voting/editing.

### Countdown Timers
- `≥ 1 hour remaining`: show `DDd HHh MMm` format
- `< 1 hour remaining`: show `MM:SS` format, update every second
- `≤ 0`: show "Completed"
- Archived surveys show `Archived <Mon Day>` (or `Archived <Mon Day, Year>` if not current year)

---

## 10. Explorer API Proxy

Every server in the project (root `server.js` and each sub-app server) must proxy `/explorer-api/*` requests to the upstream block explorer. This is needed because clients running in a WebView or from a different origin cannot call the explorer directly due to CORS.

The convention:

```js
const EXPLORER_UPSTREAM      = "alpha2.usernodelabs.org";
const EXPLORER_UPSTREAM_BASE = "/explorer/api";
const EXPLORER_PROXY_PREFIX  = "/explorer-api/";
```

When the server receives a request starting with `/explorer-api/`, it rewrites the path and forwards it to `https://alpha2.usernodelabs.org/explorer/api/...`, then pipes the response back to the client.

Client-side code uses this proxy transparently:

```js
const EXPLORER_BASE = window.location.origin + "/explorer-api";

async function explorerFetch(path, opts) {
  const resp = await fetch(`${EXPLORER_BASE}${path}`, opts);
  if (!resp.ok) throw new Error(`Explorer ${resp.status}`);
  return resp.json();
}

async function discoverChainId() {
  const data = await explorerFetch("/active_chain");
  return data.chain_id;
}

async function queryTransactions(body) {
  if (!chainId) return { items: [] };
  return explorerFetch(`/${chainId}/transactions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}
```

> **Every new sub-app server must include this proxy.** Copy the proxy handler from `server.js` or `examples/falling-sands/server.js`.

---

## 11. Server-Side Chain Polling

For dapps with a backend server that needs to react to on-chain transactions (e.g., the falling-sands simulation server applies drawing strokes from real transactions), implement server-side chain polling.

### Pattern Overview

1. **Discover the chain ID** — `GET /active_chain` → `data.chain_id`
2. **Poll transactions** — `POST /{chainId}/transactions` with `{ account: APP_PUBKEY }`
3. **Deduplicate** — track seen transaction IDs in a `Set`
4. **Apply** — parse memo, apply to your app state

### Key Details

- **Filter field**: use `account: APP_PUBKEY` (not `receiver` — the explorer API uses `account`)
- **Transaction ID field**: the explorer API returns `tx_id` (see normalization in Section 3)
- **Cursor-based pagination**: the API response includes a `cursor` field; loop up to N pages to catch all relevant transactions past reward transactions
- **`APP_PUBKEY` must match** between server and client

### Minimal Implementation

```js
const CHAIN_POLL_INTERVAL_MS = 3000;
let chainId = null;
const seenTxIds = new Set();

async function discoverChainId() {
  const data = await httpsJson("GET",
    `https://${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}/active_chain`);
  if (data && data.chain_id) chainId = data.chain_id;
}

async function pollChainTransactions() {
  if (!chainId) { await discoverChainId(); if (!chainId) return; }
  const baseUrl = `https://${EXPLORER_UPSTREAM}${EXPLORER_UPSTREAM_BASE}/${chainId}`;
  let cursor = undefined;
  const MAX_PAGES = 10;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = { account: APP_PUBKEY, limit: 50 };
    if (cursor) body.cursor = cursor;
    const data = await httpsJson("POST", `${baseUrl}/transactions`, body);
    const items = data.items || [];
    if (items.length === 0) break;

    let allSeen = true;
    for (const tx of items) {
      const txId = tx.tx_id || tx.id || tx.txid || tx.hash;
      if (!txId || seenTxIds.has(txId)) continue;
      allSeen = false;
      seenTxIds.add(txId);
      // Parse tx.memo and apply to your app state
      try {
        if (tx.memo) applyMemo(JSON.parse(tx.memo));
      } catch (_) {}
    }
    cursor = data.cursor;
    if (allSeen || !cursor) break;
  }
}

discoverChainId();
setInterval(pollChainTransactions, CHAIN_POLL_INTERVAL_MS);
```

### `httpsJson` Helper

A lightweight Node.js HTTPS request wrapper (no dependencies):

```js
const https = require("https");

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
        if (res.statusCode < 200 || res.statusCode >= 300)
          return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}
```

---

## 12. Generating App Public Keys

Each dapp should have its **own unique address** — don't reuse genesis block keys or share addresses between apps. Use the included `scripts/generate-keypair.js` to generate them.

### Usage

```bash
# Generate one keypair:
node scripts/generate-keypair.js

# Generate three at once (e.g., for index.html, CIS, and falling-sands):
node scripts/generate-keypair.js --count 3 --json

# Specify a custom node URL or CLI path:
node scripts/generate-keypair.js --node-url http://localhost:3000 --cli-path /path/to/usernode
```

### How It Works

The script tries two methods in order:

1. **Node RPC** — `POST /wallet/account` on a running node (default `http://localhost:3000`)
2. **CLI binary** — runs `usernode misc generate-account --json`, searching for the binary in:
   - `../usernode/target/release/usernode` (sibling repo layout)
   - `../usernode/target/debug/usernode`
   - `usernode` in `PATH`

### Output

Each keypair contains `secret_key`, `public_key`, and `address`. Use the `address` value as your `APP_PUBKEY`:

```js
const APP_PUBKEY = "ut1zvhmxlhmv95cgzaph6cpv0rrcrn29gr4xkdj9fuykc6648hmvgksmkfua6";
```

> **Keep the `secret_key` safe** — it controls funds sent to the address.

---

## 13. Sub-App Server Pattern

When a dapp example has its own backend server (like falling-sands), it follows a consistent pattern:

### Server Requirements

1. **Explorer API proxy** — must include the same `/explorer-api/*` proxy (see Section 10)
2. **`APP_PUBKEY`** — define at the top level, matching the client's value
3. **Flexible bridge path** — resolve `usernode-bridge.js` locally first, then fall back to root:

```js
const BRIDGE_PATH = (() => {
  const local = path.join(__dirname, "usernode-bridge.js");
  if (fs.existsSync(local)) return local;
  return path.join(__dirname, "..", "..", "usernode-bridge.js");
})();
```

4. **Mock transaction store** — same `/__mock/*` endpoints as the root server for local-dev mode
5. **Chain polling** — if the server reacts to on-chain data, implement the pattern from Section 11

### Dockerfile & Docker Compose

Each sub-app has its **own Dockerfile and docker-compose.yml** in its own directory, using local build context. This keeps apps independent — adding a new app doesn't affect existing ones.

The shared `usernode-bridge.js` is copied from the repo root before building (the deploy workflow handles this automatically):

```dockerfile
# examples/my-app/Dockerfile — uses local context
COPY server.js index.html ./
COPY usernode-bridge.js ./
```

```yaml
# examples/my-app/docker-compose.yml
services:
  my-app:
    build: .
    container_name: my-app
    environment:
      PORT: "3333"
      VIRTUAL_HOST: "myapp.usernodelabs.org"
      VIRTUAL_PORT: "3333"
    expose:
      - "3333"
    networks:
      - proxy-network

networks:
  proxy-network:
    external: true
```

For local testing, also create a `docker-compose.local.yml` override with port mappings:

```yaml
# examples/my-app/docker-compose.local.yml
services:
  my-app:
    ports:
      - "3333:3333"
    networks:
      - default

networks:
  proxy-network:
    external: false
```

### Deploy Workflow

The deploy workflow (`.github/workflows/deploy.yml`) copies `usernode-bridge.js` into each sub-app directory then runs `docker compose up` independently:

```bash
cd "$REPO_DIR/examples/my-app"
cp "$REPO_DIR/usernode-bridge.js" .
docker compose down
docker compose up -d --build
```

---

## 14. File Organization

```
├── index.html                # Main dapp page (replace with your dapp)
├── usernode-bridge.js        # The bridge — shared by all dapps, DO NOT EDIT per-dapp
├── server.js                 # Root dev server + mock API + explorer proxy
├── scripts/
│   └── generate-keypair.js   # Generate unique APP_PUBKEY addresses
├── examples/
│   ├── cis/
│   │   └── usernode_cis.html # Reference: Collective Intelligence Service
│   └── falling-sands/
│       ├── server.js              # Standalone server (WASM simulation + WS + chain polling)
│       ├── index.html             # Client UI
│       ├── Dockerfile             # Multi-stage build (Rust WASM + Node runtime)
│       ├── docker-compose.yml     # Production: own service + nginx-proxy network
│       ├── docker-compose.local.yml # Local override: port mapping
│       ├── wasm-loader.js         # WASM module loader
│       └── sandspiel/             # Rust WASM source (git submodule)
├── Dockerfile                     # Production container (root server)
├── docker-compose.yml             # Production: root dapp-starter service only
├── docker-compose.local.yml       # Local override: port mapping
├── Makefile                  # make up / make down / make logs
└── README.md
```

### Building Your App

For a real app, work at the **root level** — edit `index.html` (or replace it entirely) with your dapp. The `examples/` directory is for reference implementations only.

1. Edit `index.html` with your dapp (or create a new `.html` file at root).
2. Include the bridge: `<script src="/usernode-bridge.js"></script>`.
3. Define your `APP_PUBKEY`.
4. Implement your memo schema, state logic, and UI.
5. Access it at `http://localhost:8000/` (or `http://localhost:8000/your_file.html`).

All static files under the repo root are automatically served by `server.js`.

---

## 15. Local Development

```bash
# Start with mock APIs enabled:
node server.js --local-dev

# Then open in browser:
open http://localhost:8000/examples/my_dapp.html
```

The mock server:
- Stores transactions **in memory** (reset on restart).
- Adds a **5-second delay** before recording sent transactions (simulates network latency).
- Returns all transactions where the sender or recipient matches the queried pubkey.

### Overriding the Mock Address

```js
localStorage.setItem("usernode:mockAddress", "ut1_custom_address");
```

### Overriding the App Pubkey

```js
localStorage.setItem("myapp:app_pubkey", "ut1_my_custom_pubkey");
```

---

## 16. Docker Deployment

### Production

```bash
make up      # Build and start
make logs    # Tail logs
make down    # Stop and remove
```

The Dockerfile copies all HTML files and the `examples/` directory. If you add new files to `examples/`, they're included automatically.

### Local Testing

Each service runs independently. The production `docker-compose.yml` files use an external `proxy-network` (nginx-proxy) and only `expose` ports. For local testing, use the override files that add host port mappings.

**Root dapp-starter** (`http://localhost:8000`):

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

**Falling-sands** (`http://localhost:3333`):

```bash
cd examples/falling-sands
cp ../../usernode-bridge.js .
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

Stop either with `Ctrl+C`, then `docker compose -f docker-compose.yml -f docker-compose.local.yml down`.

> **Note**: The falling-sands build compiles Rust to WASM in a multi-stage Docker build, so the first build takes several minutes. Subsequent builds are fast due to layer caching.

---

## 17. Checklist for Building a New Dapp

This is a starting-point checklist based on the patterns above. Not every item applies to every app — adapt based on what the user wants to build.

**Setup:**
- [ ] Generate a unique `APP_PUBKEY` via `node scripts/generate-keypair.js`
- [ ] Include `<script src="/usernode-bridge.js"></script>` in your HTML
- [ ] Define `APP_PUBKEY` constant (same value in client and server if applicable)
- [ ] Define memo schema: `{ app, type, ...payload }`

**Data layer:**
- [ ] Write a `parseAppTx(rawTx)` helper to normalize + filter transactions (include `tx_id` in ID extraction)
- [ ] Implement state-rebuild functions that scan transactions (with whatever conflict resolution your app needs, if any)
- [ ] If your app has rules (rate limits, uniqueness, etc.), enforce them during **reads**, not just writes

**Transaction sending:**
- [ ] Use `TX_SEND_OPTS` with `timeoutMs: 90000` and `pollIntervalMs: 1500`
- [ ] Show the transaction progress bar during sends (not a simple spinner)
- [ ] Disable interactive elements while sending to prevent double-submit
- [ ] Refresh state after every `sendTransaction` for immediate UI updates

**UI:**
- [ ] Use `textContent` / `createElement` for user-generated content (no `innerHTML`)
- [ ] Support dark/light themes via CSS custom properties
- [ ] Implement sticky error display if you have periodic status updates

**Server (if your app has its own backend):**
- [ ] Include the explorer API proxy (`/explorer-api/*`)
- [ ] Implement chain polling with dedup if the server reacts to on-chain data
- [ ] Use flexible bridge path resolution for `usernode-bridge.js`
- [ ] Create own `Dockerfile` + `docker-compose.yml` + `docker-compose.local.yml` in the app directory
- [ ] Add deploy step to `.github/workflows/deploy.yml` (copy bridge.js + docker compose up)

**Testing:**
- [ ] Test with `node server.js --local-dev`
- [ ] Test Docker: `cp ../../usernode-bridge.js . && docker compose -f docker-compose.yml -f docker-compose.local.yml up --build`
