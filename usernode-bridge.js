/**
 * usernode-bridge.js
 *
 * Included by dapps to access Usernode-provided APIs when running inside the
 * mobile app WebView. When running in a normal browser, it provides stubbed
 * implementations so local development still works.
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
      // Not a real chain key; just a stable-per-browser-session mock identifier.
      v = `mockpk_${randomHex(16)}`;
      window.localStorage.setItem(key, v);
    }
    return v;
  }

  /**
   * Stubbed in-browser implementation.
   * - You can set a mock address via localStorage:
   *     localStorage.setItem("usernode:mockAddress", "ut1...");
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
   * Stubbed transaction sender for local browser development.
   * In the mobile app WebView, the native bridge overrides this with a real
   * implementation.
   */
  if (typeof window.sendTransaction !== "function") {
    if (window.usernode.isNative) {
      // dapp mode: go through the WebView native bridge.
      window.sendTransaction = function sendTransaction(
        destination_pubkey,
        amount,
        memo
      ) {
        return callNative("sendTransaction", {
          destination_pubkey,
          amount,
          memo,
        });
      };
    } else {
      // local dev mode: go through server.js mock endpoints (requires --local-dev flag).
      window.sendTransaction = async function sendTransaction(
        destination_pubkey,
        amount,
        memo
      ) {
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
        return await resp.json();
      };
    }
  }

  /**
   * getTransactions(filterOptions)
   *
   * - Native/WebView: calls out to a server URL you’ll configure shortly via:
   *     window.usernode.transactionsBaseUrl = "https://..."
   *
   * - Local browser dev: calls server.js mock endpoint (requires --mock-api).
   */
  if (typeof window.getTransactions !== "function") {
    window.getTransactions = async function getTransactions(filterOptions) {
      if (window.usernode.isNative) {
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

      const resp = await fetch("/__mock/getTransactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          owner_pubkey: await window.getNodeAddress(),
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
    };
  }
})();

