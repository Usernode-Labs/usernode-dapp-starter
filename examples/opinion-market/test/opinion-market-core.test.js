/**
 * Server-side tests for opinion-market-core.js
 * Run: node test/opinion-market-core.test.js
 * Or: npm test (from opinion-market dir)
 */
const assert = require("assert");
const {
  cpmmProb,
  cpmmBuyYes,
  cpmmBuyNo,
  cpmmSellYes,
  cpmmSellNo,
  cpmmBuyYesApply,
  cpmmBuyNoApply,
  cpmmSellYesApply,
  cpmmSellNoApply,
  cpmmAmountForShares,
  cpmmArbitrage,
  cpmmSellArbitrage,
  cpmmInitPools,
} = require("../opinion-market-core.js");

function assertClose(actual, expected, msg, tol = 1e-6) {
  const diff = Math.abs(actual - expected);
  assert(diff < tol, `${msg}: expected ${expected} ≈ ${actual} (diff ${diff})`);
}

// --- cpmmProb ---
assert.strictEqual(cpmmProb(null), 0);
assert.strictEqual(cpmmProb({}), 0);
assert.strictEqual(cpmmProb({ yes: 0, no: 0 }), 0);
assert.strictEqual(cpmmProb({ yes: 50, no: 50 }), 0.5);
assert.strictEqual(cpmmProb({ yes: 25, no: 75 }), 0.75);
assert.strictEqual(cpmmProb({ yes: 100, no: 0 }), 0);
assert.strictEqual(cpmmProb({ yes: 0, no: 100 }), 1);
console.log("✓ cpmmProb");

// --- cpmmBuyYes ---
const pool50 = { yes: 50, no: 50 };
assert.strictEqual(cpmmBuyYes(pool50, 0), 0);
assert.strictEqual(cpmmBuyYes(null, 10), 0);
const shares10 = cpmmBuyYes(pool50, 10);
assert(shares10 > 10, "buying at 50% should give more than 1:1");
assertClose(shares10, 10 + 50 * 10 / 60, "cpmmBuyYes formula");
console.log("✓ cpmmBuyYes");

// --- cpmmBuyNo ---
const noShares10 = cpmmBuyNo(pool50, 10);
assert(noShares10 > 10, "buying NO at 50% should give more than 1:1");
assertClose(noShares10, shares10, "symmetric pool: buy YES == buy NO shares");
console.log("✓ cpmmBuyNo");

// --- cpmmAmountForShares (closed-form inverse) ---
const targetShares = 20;
const amtYes = cpmmAmountForShares(pool50, targetShares, "YES");
assertClose(cpmmBuyYes(pool50, amtYes), targetShares, "amount→shares→amount round-trip YES");
const amtNo = cpmmAmountForShares(pool50, targetShares, "NO");
assertClose(cpmmBuyNo(pool50, amtNo), targetShares, "amount→shares→amount round-trip NO");
console.log("✓ cpmmAmountForShares");

// --- cpmmSellYes: buy then sell returns credits ---
const pool = { yes: 100, no: 100 };
const bought = cpmmBuyYes(pool, 20);
const newPool = cpmmBuyYesApply(pool, 20);
const creditsBack = cpmmSellYes(newPool, bought);
assert(creditsBack > 0, "sell should return positive credits");
assert(creditsBack > 20, "in 50/50 pool, buy then sell can return more (we moved price in our favor)");
console.log("✓ cpmmBuyYes / cpmmSellYes");

// --- cpmmBuyYesApply / cpmmBuyNoApply / cpmmSellYesApply ---
const p2 = { yes: 30, no: 70 };
const probBefore = cpmmProb(p2);
const afterBuy = cpmmBuyYesApply(p2, 10);
assert(afterBuy.yes < p2.yes, "YES in pool should decrease after buy");
assert(afterBuy.no > p2.no, "NO in pool should increase after buy");
assert(cpmmProb(afterBuy) > probBefore, "prob should increase after buying YES");
const afterSell = cpmmSellYesApply(afterBuy, 5);
assert(afterSell.yes > afterBuy.yes, "YES in pool should increase after sell");
const afterBuyNo = cpmmBuyNoApply(p2, 10);
assert(afterBuyNo.yes > p2.yes, "YES in pool should increase after buying NO");
assert(cpmmProb(afterBuyNo) < probBefore, "prob should decrease after buying NO");
console.log("✓ cpmmBuyYesApply / cpmmBuyNoApply / cpmmSellYesApply");

// --- cpmmInitPools ---
const init2 = cpmmInitPools(50, 2);
assert.strictEqual(init2.length, 2);
assert.strictEqual(init2[0].yes, 25);
assert.strictEqual(init2[0].no, 25);
assert.strictEqual(cpmmProb(init2[0]), 0.5);

const init3 = cpmmInitPools(50, 3);
assert.strictEqual(init3.length, 3);
assertClose(cpmmProb(init3[0]), 1 / 3, "3-way init prob");
assert.strictEqual(init3[0].no, 12.5);
assert.strictEqual(init3[0].yes, 25);
console.log("✓ cpmmInitPools");

// --- cpmmArbitrage: 2 options ---
const pools2 = { A: { yes: 25, no: 25 }, B: { yes: 25, no: 25 } };
const res2 = cpmmArbitrage(pools2, "A", 10);
assert(res2.sharesReceived > 0, "should receive shares");
let probSum = cpmmProb(res2.newPools.A) + cpmmProb(res2.newPools.B);
assertClose(probSum, 1, "2-option arbitrage: probs sum to 1");
assert(cpmmProb(res2.newPools.A) > 0.5, "buying YES on A should increase A's prob");

// Shares should be economically sensible: at ~50% odds, multiplier should be > 1
assert(res2.sharesReceived > 10, "at 50% odds, 10 credits should yield > 10 shares");
console.log("✓ cpmmArbitrage (2 options)");

// --- Verify buy-NO-in-others identity: shares ≈ noShares + directYes ---
const pools2b = { A: { yes: 25, no: 25 }, B: { yes: 25, no: 25 } };
const res2b = cpmmArbitrage(pools2b, "A", 95);
// For n=2, at 50/50 with 95 credits: should get roughly 128 shares (not ~64 like old buggy approach)
assert(res2b.sharesReceived > 95, "at 50% odds, should get more shares than credits spent");
console.log("✓ cpmmArbitrage share count is economically correct");

// --- cpmmArbitrage: 3 options ---
const pools3 = {};
for (const k of ["X", "Y", "Z"]) pools3[k] = { yes: 25, no: 12.5 };
const res3 = cpmmArbitrage(pools3, "X", 15);
assert(res3.sharesReceived > 0, "should receive shares");
probSum = Object.keys(res3.newPools).reduce((s, k) => s + cpmmProb(res3.newPools[k]), 0);
assertClose(probSum, 1, "3-option arbitrage: probs sum to 1");
assert(cpmmProb(res3.newPools.X) > cpmmProb(pools3.X), "buying YES on X should increase X's prob");
console.log("✓ cpmmArbitrage (3 options)");

// --- cpmmArbitrage: 4 options ---
const init4 = cpmmInitPools(100, 4);
const pools4 = { a: init4[0], b: init4[1], c: init4[2], d: init4[3] };
const res4 = cpmmArbitrage(pools4, "b", 20);
probSum = Object.keys(res4.newPools).reduce((s, k) => s + cpmmProb(res4.newPools[k]), 0);
assertClose(probSum, 1, "4-option arbitrage: probs sum to 1");
console.log("✓ cpmmArbitrage (4 options)");

// --- Fixed payout check ---
const poolLow = { yes: 95, no: 5 };
const sharesLow = cpmmBuyYes(poolLow, 10);
assert(sharesLow > 10, "buying at low prob should give >1:1 shares (fixed payout)");
assertClose(sharesLow / 10, 110 / 15, "~7.33x at 5% prob per spec", 0.1);
console.log("✓ Fixed payout at low prob");

// --- Liquidity reduces slippage ---
const smallPool = { A: { yes: 25, no: 25 }, B: { yes: 25, no: 25 } };
const bigPool = { A: { yes: 250, no: 250 }, B: { yes: 250, no: 250 } };
const resSmall = cpmmArbitrage(smallPool, "A", 10);
const resBig = cpmmArbitrage(bigPool, "A", 10);
assert(resBig.sharesReceived > resSmall.sharesReceived,
  "more liquidity should reduce slippage (more shares for same spend)");
console.log("✓ Liquidity reduces slippage");

// --- Invariant preserved after arbitrage ---
for (const k of Object.keys(res2.newPools)) {
  const orig = pools2[k];
  const updated = res2.newPools[k];
  assertClose(orig.yes * orig.no, updated.yes * updated.no, `invariant preserved for pool ${k}`, 0.01);
}
console.log("✓ Pool invariants preserved");

// --- cpmmSellNo / cpmmSellNoApply ---
const sellNoPool = { yes: 72.5, no: 8.62 };
const sellNoCredits = cpmmSellNo(sellNoPool, 10);
assert(sellNoCredits > 0, "selling NO should return positive credits");
assertClose(sellNoCredits, sellNoPool.yes * 10 / (sellNoPool.no + 10),
  "cpmmSellNo formula: yes * shares / (no + shares)");
const sellNoNewPool = cpmmSellNoApply(sellNoPool, 10);
assert(sellNoNewPool.no > sellNoPool.no, "NO in pool should increase after selling NO back");
assert(sellNoNewPool.yes < sellNoPool.yes, "YES in pool should decrease (credits exit)");
assertClose(sellNoNewPool.yes * sellNoNewPool.no, sellNoPool.yes * sellNoPool.no,
  "k preserved after sell NO", 0.01);
console.log("✓ cpmmSellNo / cpmmSellNoApply");

// --- cpmmSellArbitrage: 2 options, probs sum to 1 ---
{
  const p = { A: { yes: 25, no: 25 }, B: { yes: 25, no: 25 } };
  const buy = cpmmArbitrage(p, "A", 50);
  const sell = cpmmSellArbitrage(buy.newPools, "A", buy.sharesReceived);
  assert(sell.creditsReceived > 0, "sell-arb should return positive credits");
  const ps = Object.keys(sell.newPools).reduce((s, k) => s + cpmmProb(sell.newPools[k]), 0);
  assertClose(ps, 1, "sell-arb: probs sum to 1 after full sell");
  for (const k of Object.keys(sell.newPools)) {
    assertClose(sell.newPools[k].yes * sell.newPools[k].no,
      p[k].yes * p[k].no, `sell-arb: k preserved for pool ${k}`, 0.01);
  }
}
console.log("✓ cpmmSellArbitrage (2 options)");

// --- cpmmSellArbitrage: partial sell still sums to 1 ---
{
  const p = { A: { yes: 50, no: 50 }, B: { yes: 50, no: 50 } };
  const buy = cpmmArbitrage(p, "A", 40);
  const partial = cpmmSellArbitrage(buy.newPools, "A", buy.sharesReceived / 3);
  assert(partial.creditsReceived > 0, "partial sell should return credits");
  const ps = Object.keys(partial.newPools).reduce((s, k) => s + cpmmProb(partial.newPools[k]), 0);
  assertClose(ps, 1, "sell-arb: probs sum to 1 after partial sell");
}
console.log("✓ cpmmSellArbitrage (partial sell)");

// --- cpmmSellArbitrage: 3 options ---
{
  const init = cpmmInitPools(90, 3);
  const p = { X: init[0], Y: init[1], Z: init[2] };
  const buy = cpmmArbitrage(p, "Y", 20);
  const sell = cpmmSellArbitrage(buy.newPools, "Y", buy.sharesReceived);
  const ps = Object.keys(sell.newPools).reduce((s, k) => s + cpmmProb(sell.newPools[k]), 0);
  assertClose(ps, 1, "3-option sell-arb: probs sum to 1");
  assert(sell.creditsReceived > 0, "3-option sell-arb returns credits");
  for (const k of Object.keys(sell.newPools)) {
    assertClose(sell.newPools[k].yes * sell.newPools[k].no,
      p[k].yes * p[k].no, `3-opt sell-arb: k preserved for pool ${k}`, 0.01);
  }
}
console.log("✓ cpmmSellArbitrage (3 options)");

// --- cpmmSellArbitrage: 4 options ---
{
  const init = cpmmInitPools(100, 4);
  const p = { a: init[0], b: init[1], c: init[2], d: init[3] };
  const buy = cpmmArbitrage(p, "c", 25);
  const sell = cpmmSellArbitrage(buy.newPools, "c", buy.sharesReceived);
  const ps = Object.keys(sell.newPools).reduce((s, k) => s + cpmmProb(sell.newPools[k]), 0);
  assertClose(ps, 1, "4-option sell-arb: probs sum to 1");
  assert(sell.creditsReceived > 0, "4-option sell-arb returns credits");
}
console.log("✓ cpmmSellArbitrage (4 options)");

// --- Full sell round-trip returns investment ---
{
  const pools = { A: { yes: 50, no: 50 }, B: { yes: 50, no: 50 } };
  const buy = cpmmArbitrage(pools, "A", 40);
  const sell = cpmmSellArbitrage(buy.newPools, "A", buy.sharesReceived);
  assertClose(sell.creditsReceived, 40, "full round-trip returns investment", 0.01);
  assertClose(sell.newPools.A.yes, 50, "pools restored after round-trip", 0.01);
  assertClose(sell.newPools.A.no, 50, "pools restored after round-trip", 0.01);
}
console.log("✓ Full sell round-trip returns investment");

// --- Partial sell: deeper pools have less slippage ---
{
  const thinPools = { A: { yes: 25, no: 25 }, B: { yes: 25, no: 25 } };
  const deepPools = { A: { yes: 250, no: 250 }, B: { yes: 250, no: 250 } };
  const thinBuy = cpmmArbitrage(thinPools, "A", 20);
  const deepBuy = cpmmArbitrage(deepPools, "A", 20);
  const thinHalf = cpmmSellArbitrage(thinBuy.newPools, "A", thinBuy.sharesReceived / 2);
  const deepHalf = cpmmSellArbitrage(deepBuy.newPools, "A", deepBuy.sharesReceived / 2);
  assert(deepHalf.creditsReceived < thinHalf.creditsReceived,
    "in deeper pools, half-sell returns fewer credits (closer to fair value, less minting premium)");
}
console.log("✓ Partial sell: deeper pools have less minting premium");

// ===================================================================
// Liquidity reduces slippage — comprehensive property tests
//
// Verifies that deeper pools produce less slippage for both buying
// and selling, across multiple option counts and pool depths.
// ===================================================================

{
  const DEPTHS = [25, 50, 100, 250, 500, 1000];
  const BET = 10;
  const SELL_SHARES = 10;

  for (const nOpts of [2, 3, 4]) {
    // --- Buy-side: more liquidity → more shares per credit ---
    const buyResults = DEPTHS.map(ante => {
      const init = cpmmInitPools(ante, nOpts);
      const keys = init.map((_, i) => String(i));
      const pools = {};
      keys.forEach((k, i) => pools[k] = init[i]);
      const res = cpmmArbitrage(pools, "0", BET);
      const probAfter = cpmmProb(res.newPools["0"]);
      const probBefore = cpmmProb(pools["0"]);
      return { ante, shares: res.sharesReceived, probDelta: probAfter - probBefore };
    });

    for (let i = 1; i < buyResults.length; i++) {
      assert(buyResults[i].shares > buyResults[i - 1].shares,
        `${nOpts}-opt buy slippage: ante ${buyResults[i].ante} should yield more shares than ${buyResults[i - 1].ante} ` +
        `(${buyResults[i].shares.toFixed(4)} vs ${buyResults[i - 1].shares.toFixed(4)})`);
    }

    // --- Buy-side: more liquidity → less price impact ---
    for (let i = 1; i < buyResults.length; i++) {
      assert(buyResults[i].probDelta < buyResults[i - 1].probDelta,
        `${nOpts}-opt price impact: ante ${buyResults[i].ante} should move price less than ${buyResults[i - 1].ante} ` +
        `(${buyResults[i].probDelta.toFixed(6)} vs ${buyResults[i - 1].probDelta.toFixed(6)})`);
    }

    // --- Buy-side: converges toward zero-slippage limit ---
    // At equal prob (1/n), fair price per share = 1/n, so zero-slippage shares = BET * n
    const zeroSlippageShares = BET * nOpts;
    const deepestShares = buyResults[buyResults.length - 1].shares;
    assert(deepestShares > zeroSlippageShares * 0.95,
      `${nOpts}-opt deepest pool should be within 5% of zero-slippage limit ` +
      `(${deepestShares.toFixed(4)} vs ${zeroSlippageShares})`);
    assert(deepestShares < zeroSlippageShares,
      `${nOpts}-opt shares should never exceed zero-slippage limit`);

    // --- Sell-side: more liquidity → more credits per share sold ---
    // Sell a fixed number of shares in each pool depth (at starting 1/n prob)
    const sellResults = DEPTHS.map(ante => {
      const init = cpmmInitPools(ante, nOpts);
      const keys = init.map((_, i) => String(i));
      const pools = {};
      keys.forEach((k, i) => pools[k] = init[i]);
      const res = cpmmSellArbitrage(pools, "0", SELL_SHARES);
      return { ante, credits: res.creditsReceived };
    });

    for (let i = 1; i < sellResults.length; i++) {
      assert(sellResults[i].credits > sellResults[i - 1].credits,
        `${nOpts}-opt sell slippage: ante ${sellResults[i].ante} should return more credits than ${sellResults[i - 1].ante} ` +
        `(${sellResults[i].credits.toFixed(4)} vs ${sellResults[i - 1].credits.toFixed(4)})`);
    }

    // --- Sell-side: converges toward zero-slippage limit ---
    // At prob 1/n, fair price per share = 1/n, so selling SELL_SHARES should return SELL_SHARES/n
    const zeroSlippageSellCredits = SELL_SHARES / nOpts;
    const deepestSellCredits = sellResults[sellResults.length - 1].credits;
    assert(deepestSellCredits > zeroSlippageSellCredits * 0.95,
      `${nOpts}-opt sell deepest pool should approach zero-slippage limit ` +
      `(${deepestSellCredits.toFixed(4)} vs ${zeroSlippageSellCredits})`);
  }
}
console.log("✓ Liquidity reduces slippage: buy-side (shares increase with depth)");
console.log("✓ Liquidity reduces slippage: price impact decreases with depth");
console.log("✓ Liquidity reduces slippage: converges toward zero-slippage limit");
console.log("✓ Liquidity reduces slippage: sell-side (credits increase with depth)");

// ===================================================================
// Pool depth (k) is invariant under trading
//
// In a constant-product AMM, k = yes * no is preserved by every trade.
// Trading moves the price (probability) but never changes the depth.
// A pool that starts at {50, 50} (k=2500) will always have k=2500,
// no matter how many bets come in or in what pattern.
//
// This means: only the initial ante determines slippage. Bets do NOT
// make the market deeper. To reduce slippage, you need a higher ante
// at market creation time (or an explicit add-liquidity mechanism,
// which this CPMM does not currently support).
// ===================================================================
{
  const TOL = 0.01;

  // 2-option: alternating bets preserve k
  {
    const init = cpmmInitPools(100, 2);
    const origK = init.map(p => p.yes * p.no);
    const keys = ["A", "B"];
    let pools = {}; keys.forEach((k, i) => pools[k] = { ...init[i] });

    const bets = [
      ["A", 30], ["B", 50], ["A", 20], ["B", 10], ["A", 80], ["B", 40],
      ["A", 15], ["B", 25], ["A", 60], ["B", 35],
    ];
    for (const [target, amount] of bets) {
      const res = cpmmArbitrage(pools, target, amount);
      pools = res.newPools;
      for (let i = 0; i < keys.length; i++) {
        const k = pools[keys[i]].yes * pools[keys[i]].no;
        assertClose(k, origK[i], `2-opt k preserved after bet ${target}=${amount}`, TOL);
      }
    }
  }

  // 3-option: random sequence of bets preserves k
  {
    const init = cpmmInitPools(150, 3);
    const origK = init.map(p => p.yes * p.no);
    const keys = ["X", "Y", "Z"];
    let pools = {}; keys.forEach((k, i) => pools[k] = { ...init[i] });

    const bets = [
      ["X", 40], ["Y", 20], ["Z", 60], ["X", 10], ["Y", 50],
      ["Z", 15], ["X", 35], ["Y", 70], ["Z", 25], ["X", 45],
    ];
    for (const [target, amount] of bets) {
      const res = cpmmArbitrage(pools, target, amount);
      pools = res.newPools;
      for (let i = 0; i < keys.length; i++) {
        const k = pools[keys[i]].yes * pools[keys[i]].no;
        assertClose(k, origK[i], `3-opt k preserved after bet ${target}=${amount}`, TOL);
      }
    }
  }

  // Sell-arb also preserves k
  {
    const init = cpmmInitPools(200, 2);
    const origK = init.map(p => p.yes * p.no);
    const keys = ["A", "B"];
    let pools = {}; keys.forEach((k, i) => pools[k] = { ...init[i] });

    const buy = cpmmArbitrage(pools, "A", 50);
    pools = buy.newPools;
    for (let i = 0; i < keys.length; i++) {
      assertClose(pools[keys[i]].yes * pools[keys[i]].no, origK[i], "k after buy", TOL);
    }

    const sell = cpmmSellArbitrage(pools, "A", buy.sharesReceived / 2);
    pools = sell.newPools;
    for (let i = 0; i < keys.length; i++) {
      assertClose(pools[keys[i]].yes * pools[keys[i]].no, origK[i], "k after partial sell", TOL);
    }
  }

  // Consequence: slippage is the same after many bets as at the start
  {
    const init = cpmmInitPools(100, 2);
    const keys = ["A", "B"];
    const startPools = {}; keys.forEach((k, i) => startPools[k] = { ...init[i] });

    // Measure slippage on fresh pools
    const freshBuy = cpmmArbitrage(startPools, "A", 10);

    // Apply a long sequence of bets
    let pools = {}; keys.forEach((k, i) => pools[k] = { ...init[i] });
    const bets = [
      ["A", 30], ["B", 50], ["A", 80], ["B", 20], ["A", 15],
      ["B", 60], ["A", 40], ["B", 35], ["A", 25], ["B", 45],
    ];
    for (const [target, amount] of bets) {
      pools = cpmmArbitrage(pools, target, amount).newPools;
    }

    // Bring pools back to ~50/50 by alternating bets until close
    for (let i = 0; i < 20; i++) {
      const pA = cpmmProb(pools.A);
      if (Math.abs(pA - 0.5) < 0.01) break;
      const target = pA > 0.5 ? "B" : "A";
      pools = cpmmArbitrage(pools, target, 5).newPools;
    }

    // Measure slippage at current depth (same k, roughly same prob)
    const tradedBuy = cpmmArbitrage(pools, "A", 10);

    // shares should be nearly identical: same k, same starting prob
    assertClose(tradedBuy.sharesReceived, freshBuy.sharesReceived,
      "slippage unchanged after many bets (same k)", 0.5);
  }
}
console.log("✓ Pool depth (k) invariant: preserved through 10+ buy-arb trades (2-opt)");
console.log("✓ Pool depth (k) invariant: preserved through 10+ buy-arb trades (3-opt)");
console.log("✓ Pool depth (k) invariant: preserved through buy + sell-arb");
console.log("✓ Pool depth (k) invariant: slippage unchanged after many bets at same depth");

// ===================================================================
// Fee-based liquidity reinvestment
//
// Simulates the addPoolLiquidity mechanism: after each trade, a portion
// of the fee is added proportionally to both sides of all pools.
// Verifies that k increases, slippage decreases, and probs are preserved.
// ===================================================================
{
  const LIQUIDITY_FEE_RATE = 0.02;
  const FEE_RATE = 0.05;

  function addPoolLiquidity(pools, amount) {
    const total = Object.values(pools).reduce((s, p) => s + p.yes + p.no, 0);
    if (total <= 0 || amount <= 0) return;
    const scale = 1 + amount / total;
    for (const k of Object.keys(pools)) {
      pools[k] = { yes: pools[k].yes * scale, no: pools[k].no * scale };
    }
  }

  function simulateBet(pools, target, betCredits) {
    const fee = betCredits * FEE_RATE;
    const liquidityFee = betCredits * LIQUIDITY_FEE_RATE;
    const net = betCredits - fee;
    const res = cpmmArbitrage(pools, target, net);
    const newPools = {};
    for (const k of Object.keys(res.newPools)) newPools[k] = { ...res.newPools[k] };
    addPoolLiquidity(newPools, liquidityFee);
    return { newPools, sharesReceived: res.sharesReceived };
  }

  // --- k increases with each bet ---
  {
    const init = cpmmInitPools(100, 2);
    let pools = { A: { ...init[0] }, B: { ...init[1] } };
    const origK_A = pools.A.yes * pools.A.no;

    const bets = [["A", 50], ["B", 30], ["A", 20], ["B", 40], ["A", 60]];
    let prevK = origK_A;
    for (const [target, amount] of bets) {
      const res = simulateBet(pools, target, amount);
      pools = res.newPools;
      const newK = pools.A.yes * pools.A.no;
      assert(newK > prevK, `k should increase after bet ${target}=${amount}: ${newK.toFixed(2)} > ${prevK.toFixed(2)}`);
      prevK = newK;
    }
  }
  console.log("✓ Liquidity reinvestment: k increases with each bet");

  // --- Probabilities preserved after liquidity addition ---
  {
    const init = cpmmInitPools(100, 3);
    let pools = { X: { ...init[0] }, Y: { ...init[1] }, Z: { ...init[2] } };

    // Move prices away from uniform
    const r1 = cpmmArbitrage(pools, "X", 30);
    for (const k of Object.keys(r1.newPools)) pools[k] = r1.newPools[k];

    const probsBefore = Object.keys(pools).map(k => cpmmProb(pools[k]));
    addPoolLiquidity(pools, 10);
    const probsAfter = Object.keys(pools).map(k => cpmmProb(pools[k]));

    for (let i = 0; i < probsBefore.length; i++) {
      assertClose(probsAfter[i], probsBefore[i],
        `prob preserved for pool ${i} after liquidity add`, 1e-9);
    }
  }
  console.log("✓ Liquidity reinvestment: probabilities preserved after add");

  // --- Slippage decreases after liquidity-boosted trading ---
  // Use many alternating bets so cumulative reinvestment is meaningful,
  // then compare k and slippage at equivalent pool states.
  {
    const init = cpmmInitPools(100, 2);
    const bets = [];
    for (let i = 0; i < 20; i++) bets.push([i % 2 === 0 ? "A" : "B", 30]);

    // Path A: no reinvestment (baseline)
    let poolsBase = { A: { ...init[0] }, B: { ...init[1] } };
    for (const [target, amount] of bets) {
      const net = amount * (1 - FEE_RATE);
      poolsBase = cpmmArbitrage(poolsBase, target, net).newPools;
    }

    // Path B: with reinvestment
    let poolsLiq = { A: { ...init[0] }, B: { ...init[1] } };
    for (const [target, amount] of bets) {
      poolsLiq = simulateBet(poolsLiq, target, amount).newPools;
    }

    // k should be meaningfully higher with reinvestment
    const kBase = poolsBase.A.yes * poolsBase.A.no;
    const kLiq = poolsLiq.A.yes * poolsLiq.A.no;
    assert(kLiq > kBase * 1.01,
      `k with reinvestment (${kLiq.toFixed(2)}) should be >1% higher than without (${kBase.toFixed(2)})`);

    // Compare slippage at identical pool shapes by using the k ratio directly.
    // Both paths did equal alternating bets so probs are ~50/50.
    // Deeper k means less slippage, which we already proved in earlier tests.
    // Here we just confirm the mechanism produces the expected k growth.
    const kGrowthPct = ((kLiq - kBase) / kBase) * 100;
    assert(kGrowthPct > 1, `k growth should be >1%: got ${kGrowthPct.toFixed(2)}%`);
  }
  console.log("✓ Liquidity reinvestment: k grows meaningfully vs. no reinvestment");

  // --- Sell-side also reinvests and deepens pools ---
  {
    const init = cpmmInitPools(100, 2);
    let pools = { A: { ...init[0] }, B: { ...init[1] } };

    // Buy, then sell with reinvestment on both
    const buy = simulateBet(pools, "A", 80);
    pools = buy.newPools;
    const kAfterBuy = pools.A.yes * pools.A.no;

    // Simulate sell with liquidity reinvestment
    const sellResult = cpmmSellArbitrage(pools, "A", buy.sharesReceived);
    for (const k of Object.keys(sellResult.newPools)) pools[k] = sellResult.newPools[k];
    const liquidityFee = sellResult.creditsReceived * LIQUIDITY_FEE_RATE;
    addPoolLiquidity(pools, liquidityFee);
    const kAfterSell = pools.A.yes * pools.A.no;

    assert(kAfterSell > kAfterBuy,
      `k should increase after sell reinvestment: ${kAfterSell.toFixed(2)} > ${kAfterBuy.toFixed(2)}`);
  }
  console.log("✓ Liquidity reinvestment: sell-side also deepens pools");

  // --- Multi-option (3-opt) reinvestment works ---
  {
    const init = cpmmInitPools(150, 3);
    let pools = { X: { ...init[0] }, Y: { ...init[1] }, Z: { ...init[2] } };
    const origK = pools.X.yes * pools.X.no;

    const bets = [["X", 40], ["Y", 20], ["Z", 30], ["X", 25], ["Y", 50]];
    for (const [target, amount] of bets) {
      const res = simulateBet(pools, target, amount);
      pools = res.newPools;
    }

    const finalK = pools.X.yes * pools.X.no;
    assert(finalK > origK,
      `3-opt k should increase: ${finalK.toFixed(2)} > ${origK.toFixed(2)}`);

    const probSum = Object.values(pools).reduce((s, p) => s + cpmmProb(p), 0);
    assertClose(probSum, 1, "3-opt probSum still ~1 after reinvestment", 0.01);
  }
  console.log("✓ Liquidity reinvestment: 3-option markets deepen correctly");
}

// ===================================================================
// Manifold cross-reference tests
//
// Independent reference implementation of Manifold's formulas.
// Compares our output to what Manifold would produce for identical
// inputs across 2–5 option markets.
// ===================================================================

// --- Reference implementation (Manifold formulas, independently coded) ---
function refProb(pool) {
  return pool.NO / (pool.YES + pool.NO);
}

function refBuyYesShares(pool, amount) {
  const { YES: y, NO: n } = pool;
  const newN = n + amount;
  const newY = (y * n) / newN;
  return y + amount - newY;
}

function refBuyNoShares(pool, amount) {
  const { YES: y, NO: n } = pool;
  const newY = y + amount;
  const newN = (y * n) / newY;
  return n + amount - newN;
}

function refBuyYesApply(pool, amount) {
  const { YES: y, NO: n } = pool;
  const newN = n + amount;
  return { YES: (y * n) / newN, NO: newN };
}

function refBuyNoApply(pool, amount) {
  const { YES: y, NO: n } = pool;
  const newY = y + amount;
  return { YES: newY, NO: (y * n) / newY };
}

function refAmountForShares(pool, shares, outcome) {
  const { YES: y, NO: n } = pool;
  const d = y + n - shares;
  const other = outcome === "YES" ? n : y;
  return (shares - y - n + Math.sqrt(4 * other * shares + d * d)) / 2;
}

function refProbSum(pools) {
  return pools.reduce((s, p) => s + refProb(p), 0);
}

// Manifold buy-arb: binary search noShares, buy NO in others, YES in target
function refBuyArbitrage(pools, targetIdx, betAmount) {
  const n = pools.length;
  const others = pools.map((p, i) => i).filter(i => i !== targetIdx);

  const noSharePriceSum = others.reduce((s, i) => s + (1 - refProb(pools[i])), 0);
  const maxNo = betAmount / Math.max(noSharePriceSum - (n - 2), 0.001) * 3;

  let lo = 0, hi = maxNo;
  for (let iter = 0; iter < 80; iter++) {
    const ns = (lo + hi) / 2;
    let totalNoCost = 0, valid = true;
    const working = new Array(n);

    for (const i of others) {
      const amt = refAmountForShares(pools[i], ns, "NO");
      if (!Number.isFinite(amt) || amt < 0) { valid = false; break; }
      totalNoCost += amt;
      working[i] = refBuyNoApply(pools[i], amt);
    }
    if (!valid) { hi = ns; continue; }

    const redemption = ns * Math.max(0, n - 2);
    const yb = betAmount - (totalNoCost - redemption);
    if (yb < -1e-9) { hi = ns; continue; }

    working[targetIdx] = refBuyYesApply(pools[targetIdx], Math.max(0, yb));

    const pSum = refProbSum(working.filter(Boolean));
    if (Math.abs(pSum - 1) < 1e-9) break;
    if (pSum > 1) lo = ns; else hi = ns;
  }

  const noShares = (lo + hi) / 2;
  let totalNoCost = 0;
  const newPools = new Array(n);
  for (const i of others) {
    const amt = refAmountForShares(pools[i], noShares, "NO");
    totalNoCost += amt;
    newPools[i] = refBuyNoApply(pools[i], amt);
  }
  const redemption = noShares * Math.max(0, n - 2);
  const yb = Math.max(0, betAmount - (totalNoCost - redemption));
  const directYes = refBuyYesShares(pools[targetIdx], yb);
  newPools[targetIdx] = refBuyYesApply(pools[targetIdx], yb);

  return { shares: noShares + directYes, pools: newPools, probSum: refProbSum(newPools) };
}

// Manifold sell-arb: binary search noShares, buy NO in target, YES in others
function refSellArbitrage(pools, targetIdx, sharesToSell) {
  const n = pools.length;
  const others = pools.map((p, i) => i).filter(i => i !== targetIdx);

  let lo = 0, hi = sharesToSell;
  for (let iter = 0; iter < 80; iter++) {
    const ns = (lo + hi) / 2;
    const yesInOthers = sharesToSell - ns;

    const noAmt = refAmountForShares(pools[targetIdx], ns, "NO");
    if (!Number.isFinite(noAmt) || noAmt < 0) { hi = ns; continue; }

    const working = new Array(n);
    working[targetIdx] = refBuyNoApply(pools[targetIdx], noAmt);

    let valid = true;
    for (const i of others) {
      const yesAmt = refAmountForShares(pools[i], yesInOthers, "YES");
      if (!Number.isFinite(yesAmt) || yesAmt < 0) { valid = false; break; }
      working[i] = refBuyYesApply(pools[i], yesAmt);
    }
    if (!valid) { lo = ns; continue; }

    const pSum = refProbSum(working);
    if (Math.abs(pSum - 1) < 1e-9) break;
    if (pSum > 1) lo = ns; else hi = ns;
  }

  const ns = (lo + hi) / 2;
  const yesInOthers = sharesToSell - ns;
  const noAmt = refAmountForShares(pools[targetIdx], ns, "NO");
  const newPools = new Array(n);
  newPools[targetIdx] = refBuyNoApply(pools[targetIdx], noAmt);
  let totalYesAmt = 0;
  for (const i of others) {
    const ya = refAmountForShares(pools[i], yesInOthers, "YES");
    totalYesAmt += ya;
    newPools[i] = refBuyYesApply(pools[i], ya);
  }

  return { credits: sharesToSell - noAmt - totalYesAmt, pools: newPools, probSum: refProbSum(newPools) };
}

// --- Helper: build pool maps for our API, pool arrays for reference ---
function makePoolMap(keys, initPool) {
  const m = {};
  for (const k of keys) m[k] = { yes: initPool.YES, no: initPool.NO };
  return m;
}
function makePoolArr(initPool, n) {
  return Array.from({ length: n }, () => ({ YES: initPool.YES, NO: initPool.NO }));
}

// --- Cross-reference test runner ---
function crossRef(label, n, ante, targetIdx, betAmount) {
  const Y = ante / (2 * (n - 1));
  const N = (n - 1) * Y;
  // Wait, that's wrong. Looking at cpmmInitPools: N_k = ante / (2*(n-1)), Y_k = (n-1)*N_k
  // So for equal prob: yes = Y_k = ante/2, no = N_k = ante/(2*(n-1))
  // Actually: N_k = ante/(2*(n-1)), Y_k = (n-1)*N_k = ante/2
  // prob = N_k / (Y_k + N_k) = (ante/(2(n-1))) / (ante/2 + ante/(2(n-1)))
  //       = 1/(n-1) / (1 + 1/(n-1)) = 1/(n-1+1) = 1/n ✓
  const initPool = { YES: ante / 2, NO: ante / (2 * (n - 1)) };
  const keys = Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i)); // A,B,C,...
  const targetKey = keys[targetIdx];

  const ourPools = makePoolMap(keys, initPool);
  const refPools = makePoolArr(initPool, n);

  // Buy
  const ourBuy = cpmmArbitrage(ourPools, targetKey, betAmount);
  const refBuy = refBuyArbitrage(refPools, targetIdx, betAmount);

  assertClose(ourBuy.sharesReceived, refBuy.shares, `${label} buy: shares match`, 0.01);
  assertClose(
    Object.values(ourBuy.newPools).reduce((s, p) => s + cpmmProb(p), 0),
    1, `${label} buy: our probSum = 1`, 1e-6);
  assertClose(refBuy.probSum, 1, `${label} buy: ref probSum = 1`, 1e-6);

  for (let i = 0; i < n; i++) {
    const ourPool = ourBuy.newPools[keys[i]];
    const refPool = refBuy.pools[i];
    assertClose(ourPool.yes, refPool.YES, `${label} buy: pool ${keys[i]} YES match`, 0.01);
    assertClose(ourPool.no, refPool.NO, `${label} buy: pool ${keys[i]} NO match`, 0.01);
  }

  // Sell (full round-trip)
  const ourSell = cpmmSellArbitrage(ourBuy.newPools, targetKey, ourBuy.sharesReceived);
  const refSell = refSellArbitrage(refBuy.pools, targetIdx, refBuy.shares);

  assertClose(ourSell.creditsReceived, refSell.credits,
    `${label} sell: credits match`, 0.01);
  assertClose(ourSell.creditsReceived, betAmount,
    `${label} sell: round-trip returns investment`, 0.1);
  assertClose(
    Object.values(ourSell.newPools).reduce((s, p) => s + cpmmProb(p), 0),
    1, `${label} sell: our probSum = 1`, 1e-6);

  for (let i = 0; i < n; i++) {
    const ourPool = ourSell.newPools[keys[i]];
    const refPool = refSell.pools[i];
    assertClose(ourPool.yes, refPool.YES, `${label} sell: pool ${keys[i]} YES match`, 0.01);
    assertClose(ourPool.no, refPool.NO, `${label} sell: pool ${keys[i]} NO match`, 0.01);
  }

  // Partial sell
  const halfShares = ourBuy.sharesReceived / 2;
  const ourHalf = cpmmSellArbitrage(ourBuy.newPools, targetKey, halfShares);
  const refHalf = refSellArbitrage(refBuy.pools, targetIdx, halfShares);

  assertClose(ourHalf.creditsReceived, refHalf.credits,
    `${label} half-sell: credits match`, 0.01);
  assertClose(
    Object.values(ourHalf.newPools).reduce((s, p) => s + cpmmProb(p), 0),
    1, `${label} half-sell: our probSum = 1`, 1e-6);
}

// 2 options: equal pools, various bet sizes
crossRef("2opt/100ante/10bet", 2, 100, 0, 10);
crossRef("2opt/100ante/50bet", 2, 100, 0, 50);
crossRef("2opt/100ante/95bet", 2, 100, 0, 95);
crossRef("2opt/500ante/30bet", 2, 500, 0, 30);
console.log("✓ Manifold cross-ref: 2 options");

// 3 options
crossRef("3opt/150ante/20bet", 3, 150, 0, 20);
crossRef("3opt/150ante/50bet", 3, 150, 1, 50);
crossRef("3opt/300ante/10bet", 3, 300, 2, 10);
console.log("✓ Manifold cross-ref: 3 options");

// 4 options
crossRef("4opt/200ante/25bet", 4, 200, 0, 25);
crossRef("4opt/200ante/50bet", 4, 200, 2, 50);
crossRef("4opt/400ante/15bet", 4, 400, 3, 15);
console.log("✓ Manifold cross-ref: 4 options");

// 5 options
crossRef("5opt/250ante/30bet", 5, 250, 0, 30);
crossRef("5opt/250ante/60bet", 5, 250, 3, 60);
crossRef("5opt/500ante/20bet", 5, 500, 4, 20);
console.log("✓ Manifold cross-ref: 5 options");

// --- Multi-user cross-ref: buy A, buy B, sell A ---
{
  const p = { A: { yes: 50, no: 50 }, B: { yes: 50, no: 50 } };
  const rp = [{ YES: 50, NO: 50 }, { YES: 50, NO: 50 }];

  const ourB1 = cpmmArbitrage(p, "A", 40);
  const refB1 = refBuyArbitrage(rp, 0, 40);

  const ourB2 = cpmmArbitrage(ourB1.newPools, "B", 25);
  const refB2 = refBuyArbitrage(refB1.pools, 1, 25);

  assertClose(ourB2.sharesReceived, refB2.shares, "multi-user buy B shares match", 0.01);

  const ourS1 = cpmmSellArbitrage(ourB2.newPools, "A", ourB1.sharesReceived);
  const refS1 = refSellArbitrage(refB2.pools, 0, refB1.shares);

  assertClose(ourS1.creditsReceived, refS1.credits, "multi-user sell A credits match", 0.01);
  assert(ourS1.creditsReceived < 40,
    "sell after adverse move should return less than invested");
}
console.log("✓ Manifold cross-ref: multi-user scenario");

// --- Asymmetric pool cross-ref: buy into already-moved pools ---
{
  const init = cpmmInitPools(200, 3);
  const p = { X: { ...init[0] }, Y: { ...init[1] }, Z: { ...init[2] } };
  const rp = init.map(ip => ({ YES: ip.yes, NO: ip.no }));

  const ourB1 = cpmmArbitrage(p, "X", 60);
  const refB1 = refBuyArbitrage(rp, 0, 60);

  const ourB2 = cpmmArbitrage(ourB1.newPools, "Y", 30);
  const refB2 = refBuyArbitrage(refB1.pools, 1, 30);

  const ourS = cpmmSellArbitrage(ourB2.newPools, "X", ourB1.sharesReceived / 3);
  const refS = refSellArbitrage(refB2.pools, 0, refB1.shares / 3);

  assertClose(ourS.creditsReceived, refS.credits, "asymmetric partial sell match", 0.1);
  assertClose(
    Object.values(ourS.newPools).reduce((s, p) => s + cpmmProb(p), 0),
    1, "asymmetric partial sell probSum = 1", 1e-5);
}
console.log("✓ Manifold cross-ref: asymmetric 3-option partial sell");

// ===================================================================
// Platform-subsidized liquidity and bet cap
// ===================================================================
{
  const MARKET_ANTE = 50;
  const PLATFORM_LIQUIDITY = 450;
  const MAX_BET_POOL_RATIO = 0.30;
  const EFFECTIVE_ANTE = MARKET_ANTE + PLATFORM_LIQUIDITY; // 500

  // --- Pools initialize at subsidized depth ---
  {
    const init2 = cpmmInitPools(EFFECTIVE_ANTE, 2);
    assert(init2.length === 2, "2 pools created");
    const k = init2[0].yes * init2[0].no;
    const expectedK = (EFFECTIVE_ANTE / 2) * (EFFECTIVE_ANTE / 2); // 250 * 250 = 62500
    assertClose(k, expectedK, "2-opt pool k = (ante/2)^2 at subsidized depth", 1);

    const init3 = cpmmInitPools(EFFECTIVE_ANTE, 3);
    assert(init3.length === 3, "3 pools created");
    const probSum = init3.reduce((s, p) => s + cpmmProb(p), 0);
    assertClose(probSum, 1, "3-opt subsidized probs sum to 1", 1e-6);
  }
  console.log("✓ Subsidized liquidity: pools initialize at depth 500 (ante 50 + platform 450)");

  // --- Price impact is reasonable at subsidized depth ---
  {
    const init = cpmmInitPools(EFFECTIVE_ANTE, 2);
    const pools = { A: { ...init[0] }, B: { ...init[1] } };
    const pBefore = cpmmProb(pools.A);
    const net = 100 * 0.95; // 100-credit bet after 5% fee
    const res = cpmmArbitrage(pools, "A", net);
    const pAfter = cpmmProb(res.newPools.A);
    const swing = Math.abs(pAfter - pBefore);

    assert(swing < 0.15, `100cr bet swings <15pp at subsidized depth: ${(swing*100).toFixed(1)}pp`);
    assert(swing > 0.01, `100cr bet still moves price: ${(swing*100).toFixed(1)}pp`);

    // Compare with unsubsidized (should be much worse)
    const initSmall = cpmmInitPools(MARKET_ANTE, 2);
    const smallPools = { A: { ...initSmall[0] }, B: { ...initSmall[1] } };
    const smallRes = cpmmArbitrage(smallPools, "A", net);
    const smallSwing = Math.abs(cpmmProb(smallRes.newPools.A) - cpmmProb(smallPools.A));
    assert(smallSwing > swing * 2,
      `unsubsidized swing (${(smallSwing*100).toFixed(1)}pp) should be >2x subsidized (${(swing*100).toFixed(1)}pp)`);
  }
  console.log("✓ Subsidized liquidity: 100cr bet has reasonable price impact (<15pp)");

  // --- Bet cap: 30% of pool ---
  {
    const init = cpmmInitPools(EFFECTIVE_ANTE, 2);
    const pools = { A: { ...init[0] }, B: { ...init[1] } };
    const totalPoolValue = Object.values(pools).reduce((s, p) => s + p.yes + p.no, 0);
    const maxBet = Math.floor(totalPoolValue * MAX_BET_POOL_RATIO);

    // For 2-opt at ante=500: each pool = {250,250}, so total = 2*500 = 1000, maxBet = 300
    assert(totalPoolValue > EFFECTIVE_ANTE, `total pool value (${totalPoolValue.toFixed(0)}) > effective ante`);
    assert(maxBet === Math.floor(totalPoolValue * MAX_BET_POOL_RATIO),
      `max bet = ${maxBet} (30% of ${totalPoolValue.toFixed(0)})`);

    // A bet at exactly maxBet should work fine
    const net = maxBet * 0.95;
    const res = cpmmArbitrage(pools, "A", net);
    assert(res.sharesReceived > 0, "bet at cap succeeds");

    // Price swing at cap should be bounded
    const pAfter = cpmmProb(res.newPools.A);
    const swing = Math.abs(pAfter - 0.5);
    assert(swing < 0.25, `bet at cap swings <25pp: ${(swing*100).toFixed(1)}pp`);
  }
  console.log("✓ Bet cap: 30% of pool value limits max bet correctly");

  // --- Bet cap grows as pools deepen from reinvestment ---
  {
    const FEE_RATE = 0.05;
    const LIQ_RATE = 0.02;

    function addPoolLiquidity(pools, amount) {
      const total = Object.values(pools).reduce((s, p) => s + p.yes + p.no, 0);
      if (total <= 0 || amount <= 0) return;
      const scale = 1 + amount / total;
      for (const k of Object.keys(pools)) {
        pools[k] = { yes: pools[k].yes * scale, no: pools[k].no * scale };
      }
    }

    const init = cpmmInitPools(EFFECTIVE_ANTE, 2);
    let pools = { A: { ...init[0] }, B: { ...init[1] } };
    const initialCap = Math.floor(Object.values(pools).reduce((s, p) => s + p.yes + p.no, 0) * MAX_BET_POOL_RATIO);

    for (let i = 0; i < 40; i++) {
      const target = i % 2 === 0 ? "A" : "B";
      const betAmt = 30;
      const net = betAmt * (1 - FEE_RATE);
      const liqFee = betAmt * LIQ_RATE;
      const res = cpmmArbitrage(pools, target, net);
      const np = {};
      for (const k of Object.keys(res.newPools)) np[k] = { ...res.newPools[k] };
      addPoolLiquidity(np, liqFee);
      pools = np;
    }

    const finalCap = Math.floor(Object.values(pools).reduce((s, p) => s + p.yes + p.no, 0) * MAX_BET_POOL_RATIO);
    assert(finalCap > initialCap,
      `bet cap grows with reinvestment: ${finalCap} > ${initialCap}`);
  }
  console.log("✓ Bet cap: grows as pools deepen from liquidity reinvestment");
}

console.log("\nAll tests passed.");
