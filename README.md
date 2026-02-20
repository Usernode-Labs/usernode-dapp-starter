## Usernode dapp Starter

A minimal, clone-and-go starter for building dapps on the Usernode blockchain. Each dapp is a single self-contained HTML file that runs in **two modes**:

- **Local dev mode**: served by `server.js` at `localhost:8000`, using mock endpoints.
- **Dapp mode**: loaded inside the **Usernode Flutter mobile app** WebView, using the native bridge.

The bridge (`usernode-bridge.js`) abstracts the difference so your dapp code is identical in both modes.

---

## Build a dapp with an AI agent

This repo is designed to work with AI coding assistants (Cursor, Copilot, etc.). The `AGENTS.md` file contains everything an agent needs to build a complete dapp from scratch. This is the fastest way to get started.

### How to prompt your agent

1. **Clone this repo** and open it in your AI-enabled editor.

2. **Describe what you want to build.** Be specific about the user experience. For example:

   > "Build a dapp where users can post short messages (like tweets) that are stored on-chain. Show a feed of all messages sorted by newest first. Each message should show the sender's username and a timestamp. Include a username system."

   > "Build a token tipping dapp. Users can send tips to other users by entering their address and an amount. Show a leaderboard of who has received the most tips."

   > "Build a simple poll dapp where one person can create a yes/no poll and others can vote. Show the results as a bar chart."

3. **Let the agent read `AGENTS.md`.** It contains the quick-start procedure, all three APIs, memo format, UI patterns, transaction progress bars, and the full checklist. The agent will follow those instructions to generate your dapp.

4. **Test locally** with `node server.js --local-dev` and open http://localhost:8000. Use an incognito window to simulate a second user.

### Tips for better results

- **Start simple.** A single-screen app with one transaction type is a good first prompt. You can add features incrementally.
- **Mention if you need server-side logic.** Most dapps are client-only (all state derived from on-chain transactions). If your app needs timers, automated payouts, or a backend database, say so — the agent will modify `server.js` accordingly.
- **Reference the examples.** If your idea is similar to an existing example, mention it: "Similar to the CIS survey app, but for..." — the agent can use it as a starting point.
- **Ask for `.env` generation** if your dapp needs its own on-chain address (most do): "Generate a keypair and `.env` file for this dapp."

---

## Quickstart (manual)

### 1) Run the server

```bash
node server.js --local-dev
```

Then open http://localhost:8000.

The `--local-dev` flag enables in-memory mock transaction endpoints:

- `POST /__mock/sendTransaction`
- `POST /__mock/getTransactions`
- `GET /__mock/enabled` — probed by the bridge to auto-detect mock mode

Without `--local-dev`, those endpoints return **404**.

### 2) Change the port (optional)

```bash
PORT=8001 node server.js --local-dev
```

### 3) Generate an app keypair (optional)

Each dapp needs its own unique address. Use the included script:

```bash
node scripts/generate-keypair.js           # print to stdout
node scripts/generate-keypair.js --env     # write APP_PUBKEY + APP_SECRET_KEY to .env
```

---

## How it works

### Files

- **`index.html`** — a demo dapp UI that shows node address, balance, and transaction history with send capability.
- **`usernode-bridge.js`** — the JS bridge providing `getNodeAddress()`, `sendTransaction()`, and `getTransactions()` with mode-dependent behavior.
- **`server.js`** — serves static files, exposes mock endpoints (when `--local-dev`), and proxies `/explorer-api/*` to the block explorer.

### The three APIs

| Function | Description |
|---|---|
| `getNodeAddress()` | Returns the user's public key / address |
| `sendTransaction(dest, amount, memo, opts?)` | Sends a transaction (waits for on-chain confirmation by default) |
| `getTransactions(filterOptions?)` | Fetches transactions for an account |

### Mock mode auto-detection

When the server runs `--local-dev`, the bridge probes `GET /__mock/enabled` once on first use. If it responds 200, **all** `sendTransaction` and `getTransactions` calls route to mock endpoints — even inside the Flutter WebView. This means you can test dapps on-device without sending real transactions.

- `getNodeAddress` still uses the native bridge when in a WebView (so the real user address appears in mock transactions).
- The probe result is cached for the lifetime of the page.

### Explorer API proxy

The server proxies `/explorer-api/*` to `https://alpha2.usernodelabs.org/explorer/api/*` so clients avoid CORS issues. Note that this proxy works even in `--local-dev` — see `AGENTS.md` Section 17 for how to avoid bypassing mock mode.

### dapp mode (Flutter WebView)

When loaded inside the app, the bridge detects the native environment and routes `sendTransaction` through the WebView native bridge (Flutter handles signing and submission). In local dev the mock auto-detection takes priority over native, so on-device testing with `--local-dev` uses mock endpoints.

---

## Examples

The `examples/` directory contains reference dapps:

| Example | Description |
|---|---|
| [`examples/cis/`](examples/cis/) | Collective Intelligence Service — surveys, voting, and AI bots |
| [`examples/last-one-wins/`](examples/last-one-wins/) | Token game — last sender before the timer expires wins the pot |
| [`examples/falling-sands/`](examples/falling-sands/) | Multiplayer falling-sands simulation with WASM + WebSocket |

Run the combined examples server:

```bash
cd examples
cp ../usernode-bridge.js .
cp ../index.html .
node server.js --local-dev
```

Or run any sub-app independently (e.g., `cd examples/last-one-wins && node server.js --local-dev`).

---

## Building your own dapp (manual)

1. Edit `index.html` (or create a new HTML file at root).
2. Include the bridge: `<script src="/usernode-bridge.js"></script>`.
3. Generate a unique `APP_PUBKEY` with `node scripts/generate-keypair.js`.
4. Define your memo schema and state logic.
5. See `AGENTS.md` for the full guide — architecture patterns, UI patterns, conflict resolution, server-side payouts, and more.

---

## Troubleshooting

### Android emulator: accessing host `localhost`

Inside an **Android emulator**, `localhost` refers to the emulator itself. To reach your host machine's `localhost`, use `http://10.0.2.2:8000`.
