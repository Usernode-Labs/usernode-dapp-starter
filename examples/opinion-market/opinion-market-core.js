/**
 * Opinion Market Core — pure CPMM logic for prediction markets.
 * Usable in browser (script tag) and Node (require). No DOM or browser APIs.
 *
 * Uses Manifold-style linked binary CPMM with buy-NO-in-others arbitrage
 * and closed-form share pricing (p=0.5).
 *
 * @example Browser: <script src="opinion-market-core.js"></script> → window.OpinionMarketCore
 * @example Node: const { cpmmProb, cpmmBuyYes, cpmmSellYes } = require('./opinion-market-core.js');
 */
(function (global) {
  "use strict";

  /**
   * Implied probability of YES for a binary CPMM pool.
   * prob = N / (Y + N)
   */
  function cpmmProb(pool) {
    if (!pool || typeof pool.yes !== "number" || typeof pool.no !== "number") return 0;
    const sum = pool.yes + pool.no;
    return sum <= 0 ? 0 : pool.no / sum;
  }

  /**
   * YES shares received when spending `amount` credits to buy YES.
   * Invariant: y * n = k. Credits enter the NO side, YES shares leave.
   */
  function cpmmBuyYes(pool, amount) {
    if (!pool || amount <= 0) return 0;
    const { yes, no } = pool;
    if (no <= 0) return amount;
    return amount + yes - (yes * no) / (no + amount);
  }

  /**
   * NO shares received when spending `amount` credits to buy NO.
   * Credits enter the YES side, NO shares leave.
   */
  function cpmmBuyNo(pool, amount) {
    if (!pool || amount <= 0) return 0;
    const { yes, no } = pool;
    if (yes <= 0) return amount;
    return amount + no - (yes * no) / (yes + amount);
  }

  /**
   * Credits received when selling `shares` YES shares back to the pool.
   */
  function cpmmSellYes(pool, shares) {
    if (!pool || shares <= 0) return 0;
    const { yes, no } = pool;
    if (yes <= 0) return 0;
    const newYes = yes + shares;
    return no - (yes * no) / newYes;
  }

  /** Pool state after buying YES with `amount` credits. */
  function cpmmBuyYesApply(pool, amount) {
    if (!pool || amount <= 0) return { ...pool };
    const { yes, no } = pool;
    if (no <= 0) return { yes: yes + amount, no };
    const newNo = no + amount;
    return { yes: (yes * no) / newNo, no: newNo };
  }

  /** Pool state after buying NO with `amount` credits. */
  function cpmmBuyNoApply(pool, amount) {
    if (!pool || amount <= 0) return { ...pool };
    const { yes, no } = pool;
    if (yes <= 0) return { yes, no: no + amount };
    const newYes = yes + amount;
    return { yes: newYes, no: (yes * no) / newYes };
  }

  /**
   * Credits received when selling `shares` NO shares back to the pool.
   * NO enters pool, credits (from YES side) exit.
   * Same pool transition as cpmmBuyYes but economically reversed.
   */
  function cpmmSellNo(pool, shares) {
    if (!pool || shares <= 0) return 0;
    const { yes, no } = pool;
    if (no <= 0) return 0;
    return yes * shares / (no + shares);
  }

  /** Pool state after selling `shares` NO shares back. */
  function cpmmSellNoApply(pool, shares) {
    if (!pool || shares <= 0) return { ...pool };
    const { yes, no } = pool;
    const newNo = no + shares;
    return { yes: (yes * no) / newNo, no: newNo };
  }

  /** Pool state after selling `shares` YES shares back. */
  function cpmmSellYesApply(pool, shares) {
    if (!pool || shares <= 0) return { ...pool };
    const { yes, no } = pool;
    if (yes <= 0) return pool;
    const newYes = yes + shares;
    return { yes: newYes, no: (yes * no) / newYes };
  }

  /**
   * Closed-form: credits needed to buy `shares` of `outcome` in a p=0.5 CPMM.
   * Derived from Manifold's calculateAmountToBuySharesFixedP.
   */
  function cpmmAmountForShares(pool, shares, outcome) {
    if (!pool || shares <= 0) return 0;
    const { yes: y, no: n } = pool;
    const d = y + n - shares;
    const other = outcome === "YES" ? n : y;
    return (shares - y - n + Math.sqrt(4 * other * shares + d * d)) / 2;
  }

  /**
   * Multi-option arbitrage using Manifold's buy-NO-in-others approach.
   *
   * Strategy: buy noShares NO in each other answer, then buy YES in target
   * with remaining budget. The sums-to-one identity grants:
   *   noShares YES in target + noShares * (n-2) mana redemption.
   *
   * Binary search finds noShares such that all probabilities sum to 1.
   */
  function cpmmArbitrage(pools, targetOptKey, credits) {
    const keys = Object.keys(pools);
    if (keys.length === 0 || credits <= 0) return { sharesReceived: 0, newPools: { ...pools } };
    if (!pools[targetOptKey]) return { sharesReceived: 0, newPools: { ...pools } };

    if (keys.length === 1) {
      const pool = pools[targetOptKey];
      return {
        sharesReceived: cpmmBuyYes(pool, credits),
        newPools: { [targetOptKey]: cpmmBuyYesApply(pool, credits) },
      };
    }

    const otherKeys = keys.filter(function (k) { return k !== targetOptKey; });
    var n = keys.length;
    var TOL = 1e-9;

    var noPriceSum = 0;
    for (var i = 0; i < otherKeys.length; i++) {
      noPriceSum += 1 - cpmmProb(pools[otherKeys[i]]);
    }
    var effCost = Math.max(noPriceSum - Math.max(0, n - 2), 0.001);
    var maxNo = (credits / effCost) * 3;

    var lo = 0, hi = maxNo;
    for (var iter = 0; iter < 80; iter++) {
      var mid = (lo + hi) / 2;
      var totalNoCost = 0, valid = true;
      var working = {};

      for (var j = 0; j < otherKeys.length; j++) {
        var k = otherKeys[j];
        var amt = cpmmAmountForShares(pools[k], mid, "NO");
        if (!Number.isFinite(amt) || amt < 0) { valid = false; break; }
        totalNoCost += amt;
        working[k] = cpmmBuyNoApply(pools[k], amt);
      }
      if (!valid) { hi = mid; continue; }

      var redemption = mid * Math.max(0, n - 2);
      var yb = credits - (totalNoCost - redemption);
      if (yb < -TOL) { hi = mid; continue; }

      working[targetOptKey] = cpmmBuyYesApply(pools[targetOptKey], Math.max(0, yb));

      var pSum = 0;
      for (var m = 0; m < keys.length; m++) pSum += cpmmProb(working[keys[m]]);

      if (Math.abs(pSum - 1) < TOL) { lo = hi = mid; break; }
      if (pSum > 1) lo = mid;
      else hi = mid;
    }

    var noShares = (lo + hi) / 2;
    var finalNoCost = 0;
    var newPools = {};
    for (var j2 = 0; j2 < otherKeys.length; j2++) {
      var k2 = otherKeys[j2];
      var a = cpmmAmountForShares(pools[k2], noShares, "NO");
      finalNoCost += a;
      newPools[k2] = cpmmBuyNoApply(pools[k2], a);
    }
    var finalRedemption = noShares * Math.max(0, n - 2);
    var yesBudget = Math.max(0, credits - (finalNoCost - finalRedemption));
    var directYes = cpmmBuyYes(pools[targetOptKey], yesBudget);
    newPools[targetOptKey] = cpmmBuyYesApply(pools[targetOptKey], yesBudget);

    return { sharesReceived: noShares + directYes, newPools: newPools };
  }

  /**
   * Multi-option sell-arbitrage (Manifold algorithm):
   *
   * To sell `sharesToSell` YES shares of the target answer:
   *   1. Binary search over `noShares` (0..sharesToSell)
   *   2. Buy `noShares` NO in the TARGET pool (costs `noAmount` credits)
   *   3. Buy `yesSharesInOthers` YES in EACH other pool (costs yesAmounts)
   *   4. Redeem pairs: noShares (NO_target + YES_target) + yesSharesInOthers
   *      complete sets across all pools → sharesToSell credits total
   *   5. Net credits = sharesToSell - noAmount - totalYesAmounts
   *
   * This gives a fair round-trip (no value extraction from pools).
   *
   * @returns {{ creditsReceived: number, newPools: Record<string, {yes: number, no: number}> }}
   */
  function cpmmSellArbitrage(pools, targetOptKey, sharesToSell) {
    var keys = Object.keys(pools);
    if (keys.length === 0 || sharesToSell <= 0) return { creditsReceived: 0, newPools: clonePools(pools) };
    if (!pools[targetOptKey]) return { creditsReceived: 0, newPools: clonePools(pools) };

    if (keys.length === 1) {
      var g = cpmmSellYes(pools[targetOptKey], sharesToSell);
      var sp = {};
      sp[targetOptKey] = cpmmSellYesApply(pools[targetOptKey], sharesToSell);
      return { creditsReceived: g, newPools: sp };
    }

    var otherKeys = [];
    for (var i = 0; i < keys.length; i++) { if (keys[i] !== targetOptKey) otherKeys.push(keys[i]); }
    var TOL = 1e-9;

    var lo = 0, hi = sharesToSell;
    for (var iter = 0; iter < 80; iter++) {
      var noShares = (lo + hi) / 2;
      var yesSharesInOthers = sharesToSell - noShares;

      var noAmount = cpmmAmountForShares(pools[targetOptKey], noShares, "NO");
      if (!Number.isFinite(noAmount) || noAmount < 0) { hi = noShares; continue; }

      var working = {};
      working[targetOptKey] = cpmmBuyNoApply(pools[targetOptKey], noAmount);

      var valid = true;
      for (var j = 0; j < otherKeys.length; j++) {
        var yesAmt = cpmmAmountForShares(pools[otherKeys[j]], yesSharesInOthers, "YES");
        if (!Number.isFinite(yesAmt) || yesAmt < 0) { valid = false; break; }
        working[otherKeys[j]] = cpmmBuyYesApply(pools[otherKeys[j]], yesAmt);
      }
      if (!valid) { lo = noShares; continue; }

      var pSum = 0;
      for (var m = 0; m < keys.length; m++) pSum += cpmmProb(working[keys[m]]);

      if (Math.abs(pSum - 1) < TOL) { lo = hi = noShares; break; }
      if (pSum > 1) lo = noShares;
      else hi = noShares;
    }

    var finalNoShares = (lo + hi) / 2;
    var finalYesInOthers = sharesToSell - finalNoShares;

    var finalNoAmount = cpmmAmountForShares(pools[targetOptKey], finalNoShares, "NO");
    var newPools = {};
    newPools[targetOptKey] = cpmmBuyNoApply(pools[targetOptKey], finalNoAmount);

    var totalYesAmount = 0;
    for (var j2 = 0; j2 < otherKeys.length; j2++) {
      var k2 = otherKeys[j2];
      var ya = cpmmAmountForShares(pools[k2], finalYesInOthers, "YES");
      totalYesAmount += ya;
      newPools[k2] = cpmmBuyYesApply(pools[k2], ya);
    }

    var creditsReceived = sharesToSell - finalNoAmount - totalYesAmount;
    return { creditsReceived: Math.max(0, creditsReceived), newPools: newPools };
  }

  function clonePools(pools) {
    var out = {};
    for (var k in pools) { if (pools.hasOwnProperty(k)) out[k] = { yes: pools[k].yes, no: pools[k].no }; }
    return out;
  }

  /**
   * Initialize CPMM pools for N options at equal probability 1/N.
   * Creator ante is spread across all pools. Creator receives no shares.
   */
  function cpmmInitPools(ante, n) {
    if (n < 2 || ante <= 0) return [];
    var N_k = ante / (2 * (n - 1));
    var Y_k = (n - 1) * N_k;
    var pools = [];
    for (var i = 0; i < n; i++) pools.push({ yes: Y_k, no: N_k });
    return pools;
  }

  var api = {
    cpmmProb: cpmmProb,
    cpmmBuyYes: cpmmBuyYes,
    cpmmBuyNo: cpmmBuyNo,
    cpmmSellYes: cpmmSellYes,
    cpmmSellNo: cpmmSellNo,
    cpmmBuyYesApply: cpmmBuyYesApply,
    cpmmBuyNoApply: cpmmBuyNoApply,
    cpmmSellYesApply: cpmmSellYesApply,
    cpmmSellNoApply: cpmmSellNoApply,
    cpmmAmountForShares: cpmmAmountForShares,
    cpmmArbitrage: cpmmArbitrage,
    cpmmSellArbitrage: cpmmSellArbitrage,
    cpmmInitPools: cpmmInitPools,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.OpinionMarketCore = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
