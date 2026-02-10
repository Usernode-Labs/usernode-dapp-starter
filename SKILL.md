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
| `opts.timeoutMs` | number | Max wait for inclusion (default 20s) |
| `opts.pollIntervalMs` | number | Poll interval (default 750ms) |
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
    id:     tx.id || tx.txid || tx.hash || null,
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

### Loading / Disabled States

When sending a transaction, gray out all interactive elements and show a spinner:

```js
function setSending(v) {
  sending = !!v;
  show(spinnerEl, sending);
  // Disable all buttons/inputs during send
  allInteractiveEls.forEach(el => { el.disabled = sending; });
}
```

Spinner HTML:
```html
<div class="loadingRow hide" id="pending">
  <span class="spinner"></span>
  <span>Registering vote...</span>
</div>
```

```css
.spinner {
  width: 14px; height: 14px; border-radius: 999px;
  border: 2px solid color-mix(in oklab, var(--accent) 35%, var(--border));
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
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

## 10. File Organization

```
├── index.html            # Your app's main page (replace with your dapp)
├── usernode-bridge.js    # The bridge — DO NOT EDIT per-dapp; shared by all dapps
├── server.js             # Dev server + mock API — DO NOT EDIT per-dapp
├── examples/
│   └── cis/
│       └── usernode_cis.html # Reference example: Collective Intelligence Service
├── Dockerfile            # Production container
├── docker-compose.yml
├── Makefile              # make up / make down / make logs
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

## 11. Local Development

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

## 12. Docker Deployment

```bash
make up      # Build and start
make logs    # Tail logs
make down    # Stop and remove
```

The Dockerfile copies all HTML files and the `examples/` directory. If you add new files to `examples/`, they're included automatically.

---

## 13. Checklist for Building a New Dapp

This is a starting-point checklist based on the patterns above. Not every item applies to every app — adapt based on what the user wants to build.

- [ ] Include `<script src="/usernode-bridge.js"></script>` in your HTML
- [ ] Define an `APP_PUBKEY` constant
- [ ] Define memo schema: `{ app, type, ...payload }`
- [ ] Write a `parseAppTx(rawTx)` helper to normalize + filter transactions
- [ ] Implement state-rebuild functions that scan transactions (with whatever conflict resolution your app needs, if any)
- [ ] If your app has rules (rate limits, uniqueness, etc.), enforce them during **reads**, not just writes
- [ ] Use `sendTransaction` with `TX_SEND_OPTS` for consistent timeout/polling behavior
- [ ] Refresh state after every `sendTransaction` for immediate UI updates
- [ ] Show loading indicators and disable UI during sends
- [ ] Use `textContent` / `createElement` for user-generated content (no `innerHTML`)
- [ ] Support dark/light themes via CSS custom properties
- [ ] Test with `node server.js --local-dev`
