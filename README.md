## Usernode dApp Starter

This is a minimal, clone-and-go starter dApp that works in **two modes**:

- **Local dev mode**: you open the app in your normal browser (served from `localhost:8000`).
- **dApp mode**: the same `index.html` is loaded inside the **Usernode Flutter app** in the dApps WebView.

The goal is to keep the dApp code identical across both modes, by exposing a small JS API surface via
`usernode-bridge.js`.

---

## Quickstart

### 1) Run the server

From this directory:

```bash
node server.js
```

Then open:

- `http://localhost:8000`

### 2) Enable local dev mocked APIs (optional)

Some endpoints are **only enabled** when you start the server with a flag:

```bash
node server.js --local-dev
```

This enables the mock endpoints used by the bridge in local dev mode:

- `POST /__mock/sendTransaction`
- `POST /__mock/getTransactions`

If you don’t pass `--local-dev`, those endpoints return **404**.

### 3) Change the port (optional)

```bash
PORT=8001 node server.js --local-dev
```

---

## How it works

### Files

- **`index.html`**: a tiny demo UI that:
  - shows the node address via `getNodeAddress()`
  - can send a demo tx via `sendTransaction(destination_pubkey, amount, memo)`
  - polls `getTransactions(filterOptions)` every 5 seconds and renders the list
- **`usernode-bridge.js`**: a “bridge” script that defines the JS APIs with different behavior depending on mode.
- **`server.js`**: serves `index.html` and `usernode-bridge.js`, and (optionally) exposes mock endpoints when `--local-dev` is enabled.

### Mode behavior

#### Local dev mode (normal browser at `localhost:8000`)

`usernode-bridge.js` will:

- **`getNodeAddress()`**: returns a mock pubkey/address, stable via `localStorage`
- **`sendTransaction(...)`**: calls `POST /__mock/sendTransaction` (requires `node server.js --local-dev`)
- **`getTransactions(filterOptions)`**: calls `POST /__mock/getTransactions` (requires `node server.js --local-dev`)

Mock transactions are stored **in memory** in `server.js` (so they reset when the server restarts).

You can override the mock address value:

```js
localStorage.setItem("usernode:mockAddress", "ut1_...your_mock_address...")
```

If you don’t set that, the bridge generates a random value once and stores it in:

- `localStorage["usernode:mockPubkey"]`

#### dApp mode (loaded inside the Flutter app WebView)

`usernode-bridge.js` will detect the native environment by checking for the WebView channel:

- `window.Usernode.postMessage(...)`

In this mode:

- **`sendTransaction(...)`**: goes through the WebView native bridge (Flutter handles it).
- **`getTransactions(filterOptions)`**: is intended to call a remote URL you’ll configure later via:
  - `window.usernode.transactionsBaseUrl = "https://..."`
  - For now, if it’s not set, it **throws an error**.

---

## Troubleshooting

### Android emulator: accessing host `localhost`

Inside an **Android emulator**, `localhost` refers to the emulator itself. To reach your host machine’s `localhost`,
use:

- **`http://10.0.2.2:8000`**

The Flutter app’s dApps screen already maps `localhost` → `10.0.2.2` when needed.

