/**
 * usernode-bridge.js
 *
 * Included by dapps to access Usernode-provided APIs when running inside the
 * mobile app WebView. When running in a normal browser, it provides stubbed
 * implementations so local development still works.
 *
 * Mock-mode detection: when the server runs with --local-dev, it exposes
 * /__mock/enabled. If that endpoint responds 200, ALL transaction calls go
 * through mock endpoints — even inside the Flutter WebView. This lets
 * developers test dapps on-device without hitting the real chain.
 */

(function () {
  window.usernode = window.usernode || {};
  // "dapp mode" (inside the Flutter WebView) exposes a JS channel object named
  // `Usernode` with a `postMessage` function.
  window.usernode.isNative =
    !!window.Usernode && typeof window.Usernode.postMessage === "function";

  // Shared promise bridge for native calls (Flutter resolves via
  // `window.__usernodeResolve(id, value, error)`).
  window.__usernodeBridge = window.__usernodeBridge || { pending: {} };
  window.__usernodeResolve = function (id, value, error) {
    const entry = window.__usernodeBridge.pending[id];
    if (!entry) return;
    delete window.__usernodeBridge.pending[id];
    if (error) entry.reject(new Error(error));
    else entry.resolve(value);
  };

  function callNative(method, args) {
    const id = String(Date.now()) + "-" + Math.random().toString(16).slice(2);
    return new Promise((resolve, reject) => {
      window.__usernodeBridge.pending[id] = { resolve, reject };
      if (!window.usernode.isNative) {
        delete window.__usernodeBridge.pending[id];
        reject(new Error("Usernode native bridge not available"));
        return;
      }
      window.Usernode.postMessage(JSON.stringify({ method, id, args: args || {} }));
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeTransactionsResponse(resp) {
    if (Array.isArray(resp)) return resp;
    if (!resp || typeof resp !== "object") return [];
    if (Array.isArray(resp.items)) return resp.items;
    if (Array.isArray(resp.transactions)) return resp.transactions;
    if (resp.data && Array.isArray(resp.data.items)) return resp.data.items;
    return [];
  }

  function extractTxId(sendResult) {
    if (!sendResult) return null;
    const candidates = [];
    if (typeof sendResult === "string") candidates.push(sendResult);
    if (typeof sendResult === "object") {
      candidates.push(
        sendResult.txid,
        sendResult.txId,
        sendResult.hash,
        sendResult.tx_hash,
        sendResult.txHash,
        sendResult.id
      );
      if (sendResult.tx && typeof sendResult.tx === "object") {
        candidates.push(
          sendResult.tx.id,
          sendResult.tx.txid,
          sendResult.tx.txId,
          sendResult.tx.hash,
          sendResult.tx.tx_hash,
          sendResult.tx.txHash
        );
      }
    }
    for (const v of candidates) {
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  }

  function extractTxTimestampMs(tx) {
    if (!tx || typeof tx !== "object") return null;
    const candidates = [
      tx.timestamp_ms,
      tx.created_at,
      tx.createdAt,
      tx.timestamp,
      tx.time,
      tx.seen_at,
      tx.seenAt,
    ];
    for (const v of candidates) {
      if (typeof v === "number" && Number.isFinite(v)) {
        return v < 10_000_000_000 ? v * 1000 : v;
      }
      if (typeof v === "string" && v.trim()) {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) return t;
      }
    }
    return null;
  }

  function pickFirst(obj, keys) {
    for (const k of keys) {
      if (obj[k] != null) return obj[k];
    }
    return null;
  }

  function txMatches(tx, expected) {
    if (!tx || typeof tx !== "object") return false;

    if (expected.txId) {
      const txIdCandidates = [
        tx.id,
        tx.txid,
        tx.txId,
        tx.tx_id,
        tx.hash,
        tx.tx_hash,
        tx.txHash,
      ]
        .filter((v) => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean);
      if (txIdCandidates.includes(expected.txId)) return true;
    }

    if (typeof expected.minCreatedAtMs === "number") {
      const txTime = extractTxTimestampMs(tx);
      if (typeof txTime === "number") {
        const SKEW_MS = 5_000;
        if (txTime < expected.minCreatedAtMs - SKEW_MS) return false;
      }
    }

    if (expected.memo != null) {
      const memo = tx.memo == null ? null : String(tx.memo);
      if (memo !== expected.memo) return false;
    }
    if (expected.destination_pubkey != null) {
      const raw = pickFirst(tx, ["destination_pubkey", "destination", "to"]);
      const dest = raw == null ? null : String(raw);
      if (dest !== expected.destination_pubkey) return false;
    }
    if (expected.from_pubkey != null) {
      const raw = pickFirst(tx, ["from_pubkey", "source", "from"]);
      const from = raw == null ? null : String(raw);
      if (from !== expected.from_pubkey) return false;
    }
    return true;
  }

  async function waitForTransactionVisible(expected, opts) {
    const timeoutMs =
      opts && typeof opts.timeoutMs === "number" ? opts.timeoutMs : 20_000;
    const pollIntervalMs =
      opts && typeof opts.pollIntervalMs === "number" ? opts.pollIntervalMs : 750;
    const limit = opts && typeof opts.limit === "number" ? opts.limit : 50;
    const filterOptions =
      (opts && opts.filterOptions && typeof opts.filterOptions === "object"
        ? opts.filterOptions
        : null) || {};

    const query = { limit, ...filterOptions };
    if (expected.from_pubkey && !query.sender && !query.account) {
      query.sender = expected.from_pubkey;
    }

    const startedAt = Date.now();
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt++;
      const resp = await window.getTransactions(query);
      const items = normalizeTransactionsResponse(resp);
      const found = items.find((tx) => txMatches(tx, expected));
      if (found) {
        console.log("[usernode-bridge] tx found after", attempt, "polls,", Date.now() - startedAt, "ms");
        return found;
      }

      if (attempt <= 3 || attempt % 10 === 0) {
        console.log("[usernode-bridge] waitForTx poll #" + attempt + ", " + items.length + " items, no match yet");
      }

      if (Date.now() - startedAt >= timeoutMs) {
        const details = [
          expected.txId ? `txId=${expected.txId}` : null,
          expected.memo != null ? `memo=${expected.memo}` : null,
        ]
          .filter(Boolean)
          .join(", ");
        console.warn("[usernode-bridge] waitForTx timed out. expected:", JSON.stringify(expected));
        if (items.length > 0) {
          console.warn("[usernode-bridge] last poll sample (first item):", JSON.stringify(items[0]));
        }
        throw new Error(
          `Timed out waiting for transaction to appear in getTransactions (${timeoutMs}ms, ${attempt} polls${details ? `, ${details}` : ""
          })`
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  function randomHex(bytes) {
    const a = new Uint8Array(bytes);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(a);
    } else {
      for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function getOrCreateMockPubkey() {
    const key = "usernode:mockPubkey";
    let v = window.localStorage.getItem(key);
    if (!v) {
      v = `mockpk_${randomHex(16)}`;
      window.localStorage.setItem(key, v);
    }
    return v;
  }

  // ── Mock-mode detection ────────────────────────────────────────────────
  // Probes /__mock/enabled once on first use; caches the result. When the
  // server runs --local-dev, this returns true and ALL send/get calls route
  // to mock endpoints — even inside the Flutter WebView.
  let _mockEnabledResult = null;

  async function isMockEnabled() {
    if (_mockEnabledResult !== null) return _mockEnabledResult;
    try {
      const resp = await fetch("/__mock/enabled", { method: "GET" });
      _mockEnabledResult = resp.ok;
    } catch (_) {
      _mockEnabledResult = false;
    }
    if (_mockEnabledResult) {
      console.log("[usernode-bridge] mock API detected — using local-dev endpoints");
    }
    return _mockEnabledResult;
  }

  window.usernode.isMockEnabled = isMockEnabled;

  /**
   * getNodeAddress — returns the user's public key.
   * In the WebView: calls native bridge. In browser: returns a mock key.
   * Note: this always uses native when available (even in mock mode) so
   * that the real user address appears in mock transactions.
   */
  if (typeof window.getNodeAddress !== "function") {
    if (window.usernode.isNative) {
      window.getNodeAddress = function getNodeAddress() {
        return callNative("getNodeAddress");
      };
    } else {
      window.getNodeAddress = async function getNodeAddress() {
        return (
          window.localStorage.getItem("usernode:mockAddress") ||
          getOrCreateMockPubkey()
        );
      };
    }
  }

  /**
   * sendTransaction — sends a transaction via mock or native path.
   *
   * Priority: mock API (if server is --local-dev) > native bridge > mock fallback.
   * This ensures on-device testing uses mock endpoints when available.
   */
  if (typeof window.sendTransaction !== "function") {
    async function mockSendTransaction(destination_pubkey, amount, memo, opts) {
      const startedAt = Date.now();
      const resp = await fetch("/__mock/sendTransaction", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from_pubkey: await window.getNodeAddress(),
          destination_pubkey,
          amount,
          memo,
        }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        if (resp.status === 404) {
          throw new Error(
            "Mock API not enabled. Start server with `node server.js --local-dev`."
          );
        }
        throw new Error(
          `Mock sendTransaction failed (${resp.status}): ${text}`
        );
      }
      const sendResult = await resp.json();
      const sendFailed = sendResult && (sendResult.error || sendResult.queued === false);
      const shouldWait =
        !sendFailed && (!opts || opts.waitForInclusion == null ? true : !!opts.waitForInclusion);
      if (shouldWait) {
        const from_pubkey = await window
          .getNodeAddress()
          .then((v) => (v == null ? null : String(v).trim()))
          .catch(() => null);
        const txId = extractTxId(sendResult);
        await waitForTransactionVisible(
          {
            txId,
            minCreatedAtMs: startedAt,
            memo: memo == null ? null : String(memo),
            destination_pubkey:
              destination_pubkey == null ? null : String(destination_pubkey),
            from_pubkey: from_pubkey ? from_pubkey : null,
            amount,
          },
          opts
        );
      }
      return sendResult;
    }

    async function nativeSendTransaction(destination_pubkey, amount, memo, opts) {
      const startedAt = Date.now();
      const from_pubkey = await window
        .getNodeAddress()
        .then((v) => (v == null ? null : String(v).trim()))
        .catch(() => null);
      const sendResult = await callNative("sendTransaction", {
        destination_pubkey,
        amount,
        memo,
      });
      const sendError = sendResult && sendResult.error;
      if (sendError) {
        throw new Error(String(sendError));
      }
      const sendFailed = sendResult && sendResult.queued === false;
      const shouldWait =
        !sendFailed && (!opts || opts.waitForInclusion == null ? true : !!opts.waitForInclusion);
      if (shouldWait) {
        const txId = extractTxId(sendResult);
        await waitForTransactionVisible(
          {
            txId,
            minCreatedAtMs: startedAt,
            memo: memo == null ? null : String(memo),
            destination_pubkey:
              destination_pubkey == null ? null : String(destination_pubkey),
            from_pubkey: from_pubkey ? from_pubkey : null,
            amount,
          },
          opts
        );
      }
      return sendResult;
    }

    window.sendTransaction = async function sendTransaction(
      destination_pubkey, amount, memo, opts
    ) {
      const useMock = await isMockEnabled();
      if (useMock) return mockSendTransaction(destination_pubkey, amount, memo, opts);
      if (window.usernode.isNative) return nativeSendTransaction(destination_pubkey, amount, memo, opts);
      return mockSendTransaction(destination_pubkey, amount, memo, opts);
    };
  }

  /**
   * getTransactions(filterOptions)
   *
   * Priority: mock API (if server is --local-dev) > native/explorer > mock fallback.
   */
  if (typeof window.getTransactions !== "function") {
    async function mockGetTransactions(filterOptions) {
      const ownerPubkey = (filterOptions && filterOptions.account)
        ? filterOptions.account
        : await window.getNodeAddress();
      const resp = await fetch("/__mock/getTransactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner_pubkey: ownerPubkey,
          filterOptions: filterOptions || {},
        }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        if (resp.status === 404) {
          throw new Error(
            "Mock API not enabled. Start server with `node server.js --local-dev`."
          );
        }
        throw new Error(`Mock getTransactions failed (${resp.status}): ${text}`);
      }
      return await resp.json();
    }

    async function nativeGetTransactions(filterOptions) {
      const base = window.usernode.transactionsBaseUrl;
      if (!base) {
        throw new Error(
          "transactionsBaseUrl not configured (set window.usernode.transactionsBaseUrl)"
        );
      }
      const resp = await fetch(`${base}/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(filterOptions || {}),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`getTransactions failed (${resp.status}): ${text}`);
      }
      return await resp.json();
    }

    window.getTransactions = async function getTransactions(filterOptions) {
      const useMock = await isMockEnabled();
      if (useMock) return mockGetTransactions(filterOptions);
      if (window.usernode.isNative) return nativeGetTransactions(filterOptions);
      return mockGetTransactions(filterOptions);
    };
  }
})();
