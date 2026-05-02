/**
 * usernode-loading.js — Node-readiness overlay for Usernode dapps.
 *
 * When a dapp page loads while the sidecar `usernode` is still booting /
 * joining / syncing, this overlay surfaces the actual state ("Starting
 * node…", "Connecting to network…", "Syncing chain… block X / Y", "Synced")
 * and auto-dismisses once the node is ready.
 *
 * Include after usernode-bridge.js:
 *
 *   <script src="/usernode-bridge.js"></script>
 *   <script src="/usernode-loading.js"></script>
 *   <script>UsernodeLoading.init({ appName: "Echo" });</script>
 *
 * Reads the cached snapshot exposed by `createNodeStatusProbe` in
 * `examples/lib/dapp-server.js` at `GET /__usernode/node_status`. The
 * probe polls the sidecar's `GET /status` server-side; this client just
 * reads the cached snapshot, so N tabs ≠ N sidecar requests.
 *
 * Auto-skips in `--local-dev` (via window.usernode.isMockEnabled). Also
 * stays out of the way when the probe endpoint isn't wired (404) or the
 * snapshot reports `status: "mock"` / `"unknown"` with no NODE_RPC_URL.
 */
(function () {
  "use strict";

  if (window.UsernodeLoading) return;

  var ENDPOINT = "/__usernode/node_status";
  var OVERLAY_ID = "usernode-loading-overlay";
  var STYLE_ID = "usernode-loading-style";

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "#" + OVERLAY_ID + " {",
      "  position: fixed; inset: 0; z-index: 2147483000;",
      "  display: flex; align-items: center; justify-content: center;",
      "  background: #0b0f16; color: #e7edf7;",
      "  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;",
      "  -webkit-font-smoothing: antialiased;",
      "  transition: opacity 300ms ease;",
      "  opacity: 1;",
      "}",
      "@media (prefers-color-scheme: light) {",
      "  #" + OVERLAY_ID + " { background: #f7f8fb; color: #0b1220; }",
      "}",
      "#" + OVERLAY_ID + ".unl-fading { opacity: 0; pointer-events: none; }",
      "#" + OVERLAY_ID + " .unl-card {",
      "  width: min(420px, calc(100% - 32px));",
      "  padding: 24px 24px 20px; border-radius: 16px;",
      "  background: rgba(255,255,255,0.04);",
      "  border: 1px solid rgba(255,255,255,0.10);",
      "  box-shadow: 0 12px 32px rgba(0,0,0,0.35);",
      "}",
      "@media (prefers-color-scheme: light) {",
      "  #" + OVERLAY_ID + " .unl-card {",
      "    background: #ffffff;",
      "    border-color: rgba(15,23,42,0.10);",
      "    box-shadow: 0 12px 32px rgba(15,23,42,0.10);",
      "  }",
      "}",
      "#" + OVERLAY_ID + " .unl-app {",
      "  font-size: 12px; font-weight: 600; letter-spacing: 0.08em;",
      "  text-transform: uppercase; opacity: 0.6; margin-bottom: 6px;",
      "}",
      "#" + OVERLAY_ID + " .unl-title {",
      "  font-size: 18px; font-weight: 600; line-height: 1.3;",
      "  margin: 0 0 14px;",
      "}",
      "#" + OVERLAY_ID + " .unl-track {",
      "  width: 100%; height: 6px; border-radius: 3px;",
      "  background: rgba(255,255,255,0.10); overflow: hidden;",
      "  position: relative;",
      "}",
      "@media (prefers-color-scheme: light) {",
      "  #" + OVERLAY_ID + " .unl-track { background: rgba(15,23,42,0.10); }",
      "}",
      "#" + OVERLAY_ID + " .unl-fill {",
      "  height: 100%; width: 0%; border-radius: 3px;",
      "  background: #6ea8fe;",
      "  transition: width 400ms ease-out;",
      "}",
      "@media (prefers-color-scheme: light) {",
      "  #" + OVERLAY_ID + " .unl-fill { background: #2563eb; }",
      "}",
      "#" + OVERLAY_ID + " .unl-fill.unl-indeterminate {",
      "  width: 40% !important;",
      "  position: absolute; left: 0; top: 0;",
      "  animation: unl-pulse 1.4s ease-in-out infinite;",
      "}",
      "@keyframes unl-pulse {",
      "  0%   { transform: translateX(-100%); }",
      "  100% { transform: translateX(250%); }",
      "}",
      "#" + OVERLAY_ID + " .unl-meta {",
      "  margin-top: 10px; font-size: 12px; opacity: 0.65;",
      "  min-height: 1em;",
      "}",
    ].join("\n");
    document.head.appendChild(style);
  }

  function buildOverlay(appName) {
    var overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-live", "polite");
    overlay.setAttribute("tabindex", "-1");

    var card = document.createElement("div");
    card.className = "unl-card";

    var app = document.createElement("div");
    app.className = "unl-app";
    app.textContent = appName || (document.title || "Usernode");

    var title = document.createElement("div");
    title.className = "unl-title";
    title.textContent = "Starting node…";

    var track = document.createElement("div");
    track.className = "unl-track";

    var fill = document.createElement("div");
    fill.className = "unl-fill unl-indeterminate";
    track.appendChild(fill);

    var meta = document.createElement("div");
    meta.className = "unl-meta";
    meta.textContent = "";

    card.appendChild(app);
    card.appendChild(title);
    card.appendChild(track);
    card.appendChild(meta);
    overlay.appendChild(card);
    return { overlay: overlay, title: title, fill: fill, meta: meta };
  }

  function fetchSnapshot() {
    return fetch(ENDPOINT, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    }).then(function (resp) {
      if (resp.status === 404) {
        // Endpoint isn't wired on this server. Treat as a signal to dismiss
        // the loader rather than spinning forever.
        return { __notWired: true };
      }
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return resp.json();
    });
  }

  function describeStatus(snap) {
    var s = snap && snap.status;
    var ourTip = (snap && typeof snap.bestTipHeight === "number") ? snap.bestTipHeight : null;
    var peerTip = (snap && typeof snap.peerBestTipHeight === "number") ? snap.peerBestTipHeight : null;
    var peers = (snap && typeof snap.peers === "number") ? snap.peers : 0;

    if (s === "Synced") return { title: "Synced", meta: "", percent: 100, indeterminate: false };
    if (s === "Syncing") {
      var title = "Syncing chain…";
      var meta = "";
      var percent = null;
      var indeterminate = true;
      if (ourTip != null && peerTip != null && peerTip > 0) {
        title = "Syncing chain… (block " + ourTip + " / " + peerTip + ")";
        percent = Math.max(0, Math.min(100, (ourTip / peerTip) * 100));
        indeterminate = false;
      } else if (ourTip != null) {
        meta = "Local tip: " + ourTip;
      }
      return { title: title, meta: meta, percent: percent != null ? percent : 0, indeterminate: indeterminate };
    }
    if (s === "Connected") {
      return { title: "Joining network…", meta: peers + " peer" + (peers === 1 ? "" : "s") + " connected", percent: 0, indeterminate: true };
    }
    if (s === "Connecting") {
      return { title: "Connecting to network…", meta: "Looking for peers", percent: 0, indeterminate: true };
    }
    if (s === "unreachable") {
      return { title: "Starting node…", meta: snap && snap.error ? "Sidecar offline" : "", percent: 0, indeterminate: true };
    }
    return { title: "Starting node…", meta: "", percent: 0, indeterminate: true };
  }

  function shouldDismiss(snap, requireSynced) {
    if (!snap) return false;
    if (snap.__notWired) return true;          // probe endpoint missing
    if (snap.status === "mock") return true;    // server is in --local-dev
    if (snap.status === "unknown") return true; // probe disabled (no NODE_RPC_URL)
    if (snap.status === "Synced") return true;
    if (!requireSynced && snap.status === "Connected") return true;
    return false;
  }

  function init(opts) {
    opts = opts || {};
    var appName = opts.appName != null ? String(opts.appName) : (document.title || "Usernode");
    var pollIntervalMs = typeof opts.pollIntervalMs === "number" ? opts.pollIntervalMs : 1500;
    var requireSynced = opts.requireSynced !== false;
    var reShowOnRegression = !!opts.reShowOnRegression;
    var onStatusChange = typeof opts.onStatusChange === "function" ? opts.onStatusChange : null;

    var bridgeMockCheck = (window.usernode && typeof window.usernode.isMockEnabled === "function")
      ? window.usernode.isMockEnabled()
      : Promise.resolve(false);

    var dismissed = false;
    var pollTimer = null;
    var ui = null;
    var lastSnapshotJson = null;

    function ensureOverlayMounted() {
      if (ui) return;
      injectStyle();
      ui = buildOverlay(appName);
      document.body.appendChild(ui.overlay);
      try { ui.overlay.focus({ preventScroll: true }); } catch (_) {}
    }

    function applyDescription(desc) {
      if (!ui) return;
      ui.title.textContent = desc.title;
      ui.meta.textContent = desc.meta || "";
      if (desc.indeterminate) {
        ui.fill.className = "unl-fill unl-indeterminate";
        ui.fill.style.width = "";
      } else {
        ui.fill.className = "unl-fill";
        ui.fill.style.width = (desc.percent || 0) + "%";
      }
    }

    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      if (pollTimer != null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (ui && ui.overlay && ui.overlay.parentNode) {
        ui.overlay.classList.add("unl-fading");
        var overlay = ui.overlay;
        setTimeout(function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 350);
      }
    }

    function fireStatusChange(snap) {
      if (!onStatusChange || !snap) return;
      var key = JSON.stringify({
        s: snap.status,
        p: snap.peers,
        b: snap.bestTipHeight,
        t: snap.peerBestTipHeight,
      });
      if (key === lastSnapshotJson) return;
      lastSnapshotJson = key;
      try { onStatusChange(snap); } catch (e) {
        console.error("[usernode-loading] onStatusChange threw:", e);
      }
    }

    function tick() {
      fetchSnapshot().then(function (snap) {
        fireStatusChange(snap);
        if (shouldDismiss(snap, requireSynced)) {
          dismiss();
          return;
        }
        if (!ui) ensureOverlayMounted();
        applyDescription(describeStatus(snap));
      }).catch(function (err) {
        // Network errors mean we genuinely can't tell — keep the last
        // known render up rather than thrash the UI.
        if (!ui) {
          ensureOverlayMounted();
          applyDescription({
            title: "Starting node…",
            meta: "Waiting for status…",
            percent: 0,
            indeterminate: true,
          });
        }
        // Surface to console once per failure mode — useful when debugging
        // a misconfigured server.
        console.warn("[usernode-loading] status fetch failed:", err && err.message ? err.message : err);
      });
    }

    bridgeMockCheck.then(function (mock) {
      if (mock) {
        // Local-dev: never inject the overlay. The sidecar isn't running
        // and the bridge is using mock endpoints, so there's nothing to
        // wait on.
        return;
      }
      // First read decides whether we even mount the overlay. Unwired
      // endpoints / unknown / mock / Synced → never paint anything.
      fetchSnapshot().then(function (snap) {
        fireStatusChange(snap);
        if (shouldDismiss(snap, requireSynced)) {
          // No overlay, no polling. Optional regression re-show is opt-in
          // (default off) — most dapps would rather not flicker an overlay
          // mid-session if the sidecar reconnects.
          if (reShowOnRegression) {
            pollTimer = setInterval(tick, pollIntervalMs);
          }
          return;
        }
        ensureOverlayMounted();
        applyDescription(describeStatus(snap));
        pollTimer = setInterval(tick, pollIntervalMs);
      }).catch(function (err) {
        // First-call network failure: still show the overlay so the user
        // sees *something* while we keep retrying.
        ensureOverlayMounted();
        applyDescription({
          title: "Starting node…",
          meta: "Waiting for status…",
          percent: 0,
          indeterminate: true,
        });
        console.warn("[usernode-loading] initial status fetch failed:", err && err.message ? err.message : err);
        pollTimer = setInterval(tick, pollIntervalMs);
      });
    });
  }

  window.UsernodeLoading = { init: init };
})();
