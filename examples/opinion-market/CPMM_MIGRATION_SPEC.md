# Opinion Market — Migration from DPM to Linked Binary CPMM

## Current State (as of March 2025)

**DPM I is implemented** as a stopgap. We use Pennock's DPM I variant (refund-first): winning wagers are refunded their net contribution first, then only the losers' money is redistributed as profit. This guarantees every correct bet at least ~0.95x return (net stake back after fee), eliminating the sub-1x problem. See `MARKET_MECHANISM_TRADEOFFS.md` for the full analysis.

DPM I does **not** fix payout uncertainty (displayed vs actual still shifts with subsequent bets) or provide natural "buy NO." The CPMM migration remains the target for full resolution.

---

## Motivation

The original Dynamic Parimutuel Market (DPM II) had a known flaw: late buyers of popular options receive sub-1x returns even when the option hasn't reached 100% probability. This happens because the DPM share formula `shares = net * (totalPool / optionPool)` issues more shares per credit to early buyers, permanently diluting late entrants. Manifold Markets encountered the same problem and migrated away from DPM for this reason.

The replacement is a **linked set of independent binary CPMMs** (constant product market makers), following the approach Manifold shipped in June 2023. Each option becomes its own Yes/No CPMM market, linked via just-in-time arbitrage so probabilities sum to 100%. Share payouts are fixed at purchase time — no dilution from later activity.

## Key Properties of the New Model

1. **Fixed payouts**: When you buy YES shares of an option, each share pays exactly 1 credit if that option wins and 0 if it loses. Your return is known at purchase time and cannot be diluted.
2. **Dynamic pricing**: The CPMM moves the price as trades come in. Popular options cost more per share, underdogs cost less. Early buyers get better prices (more shares per credit) than late buyers, but late buyers still get a fair deal — buying at 80% implied probability gives a 1.25x return if correct.
3. **Linked liquidity**: Buying YES on one option automatically sells NO on all others (via arbitrage), so liquidity is shared across options. A bet on any option moves all prices.
4. **Probabilities sum to 100%**: Enforced by the arbitrage mechanism after every trade.
5. **New options mid-market**: Supported. A new binary CPMM pool is created, and the arbitrage rebalances all probabilities.

## CPMM Mechanics

### Per-Option Pool State

Each option `k` in a survey has an independent binary CPMM pool:

```
pool[k] = { yes: Y_k, no: N_k }
```

The **constant product invariant** is: `Y_k * N_k = K_k` (preserved after each trade within that pool).

The **implied probability** of option `k` is:

```
prob(k) = N_k / (Y_k + N_k)
```

Intuition: more NO shares in the pool means the market thinks YES is more likely (people have been buying YES and depositing NO).

### Share Identity

The fundamental identity linking all options:

> **1 YES share in every option = 1 credit**

Because exactly one option will resolve YES, and that 1 YES share pays 1 credit.

Equivalently:

> **1 NO share in option k = 1 YES share in every other option**

These identities enable the arbitrage that keeps probabilities summing to 100%.

### Buying YES Shares

When a user spends `m` credits to buy YES on option `k`:

1. **Mint**: `m` credits create `m` YES shares + `m` NO shares of option `k` (from the identity: 1 credit = 1 YES + 1 NO)
2. **Deposit NO**: Add the `m` NO shares to pool `k`
3. **Withdraw YES**: The pool releases YES shares to maintain the constant product:
   - Before: `Y_k * N_k = K`
   - After adding `m` NO: `Y_k' * (N_k + m) = K`
   - So `Y_k' = K / (N_k + m) = Y_k * N_k / (N_k + m)`
   - YES shares released from pool: `Y_k - Y_k' = Y_k * m / (N_k + m)`
4. **Total YES received**: `m + Y_k * m / (N_k + m) = m * (Y_k + N_k + m) / (N_k + m)`
5. **Effective price per share**: `m / shares_received`

If option `k` wins, each YES share pays 1 credit. The return is `shares_received / m`, which is always `> 1` when `prob(k) < 1`.

### Selling YES Shares (Cash Out)

When a user sells `s` YES shares of option `k`:

1. The pool absorbs the YES shares: `Y_k' = Y_k + s`
2. NO shares are released to maintain constant product: `N_k' = K / (Y_k + s)`
3. NO shares released: `N_k - N_k' = N_k - Y_k * N_k / (Y_k + s) = s * N_k / (Y_k + s)`
4. The released NO shares + the YES shares being sold combine: `s` YES + `s * N_k / (Y_k + s)` NO. Using the share identity, convert pairs of (1 YES + 1 NO) → 1 credit. The number of complete pairs is the NO count: `s * N_k / (Y_k + s)`.
5. **Credits received** (before fees): `s * N_k / (Y_k + s)`
6. Remaining YES shares (`s - pairs` = `s * Y_k / (Y_k + s)`) go back into the pool.

Wait — this is getting circular. Simpler formulation:

To sell `s` YES shares back to the CPMM:
- Before: pool is `(Y_k, N_k)` with invariant `Y_k * N_k = K`
- User adds `s` YES to pool: `Y_k' = Y_k + s`
- Pool releases NO to maintain invariant: `N_k' = K / (Y_k + s)`
- NO released: `delta_N = N_k - N_k' = N_k * s / (Y_k + s)`
- Convert `delta_N` NO shares to credits (via identity: 1 NO of k = 1 YES of every other option; but simpler — the user effectively receives `delta_N` credits, since the pool is paying out)
- **Credits received before fees**: `N_k * s / (Y_k + s)`

### Arbitrage (Linking the Options)

After a user buys YES on option `k`, prob(`k`) increases but the other probabilities haven't changed, so they no longer sum to 100%. The arbitrage step fixes this:

1. After the primary buy, calculate the probability excess: `sum(prob(i)) - 1`
2. Buy NO on all options in equal amounts until `sum(prob(i)) = 1`
3. Equal NO shares across all options can be **redeemed** for credits (from the identity: 1 NO in every option except one = 1 YES in one option; more precisely, 1 YES in all options = 1 credit)
4. Use the redeemed credits to buy more YES of option `k`
5. Repeat until convergence (typically 10-20 iterations, converges quickly)

In practice this is implemented as a numerical loop (binary search or Newton's method) that finds the final pool states such that:
- Each pool's constant product invariant holds
- All probabilities sum to 1
- The user receives the maximum YES shares for their `m` credits

### Redemption

Users may accumulate YES shares across multiple options (from buying multiple outcomes, or from the arbitrage process). Any time a user holds `r` YES shares in every option, those can be redeemed for `r` credits. Similarly, `r` NO shares in two or more options can be partially redeemed.

In practice, redemption is triggered automatically after each trade to keep user positions clean.

## Initialization

### Market Creation (Creator Ante)

When a survey is created with `N` options, the creator pays `MARKET_ANTE` credits. These are used to initialize the CPMM pools.

For each option `k`, initialize the pool to equal probability `1/N`:

```
prob(k) = 1/N = N_k / (Y_k + N_k)
```

Given the ante `A = MARKET_ANTE`:

```
A = N * Y_k_init + (N-1) * N_k_init    (from Manifold's formula)
prob = N_k / (Y_k + N_k) = 1/N
```

Solving: `Y_k = (N-1) * N_k`. With `A` distributed:

```
Y_k_init = A * (N-1) / N
N_k_init = A / N
```

Wait — this doesn't scale correctly because each pool needs to be independent. Simpler approach (Manifold's): with `p = 0.5` fixed for all pools, and `ante` total:

```
ante = Y_k_init + (N - 1) * N_k_init
1/N = N_k_init / (Y_k_init + N_k_init)
```

For a 2-option survey with ante 50:
- `Y_k = 25`, `N_k = 25` per option → `prob = 25/50 = 50%` each ✓

For a 3-option survey with ante 50:
- Each option: `prob = 1/3`
- `N_k / (Y_k + N_k) = 1/3` → `Y_k = 2 * N_k`
- `ante = Y_k + 2 * N_k = 2*N_k + 2*N_k = 4*N_k` → `N_k = 50/4 = 12.5`, `Y_k = 25`
- Check: `prob = 12.5 / 37.5 = 1/3` ✓

General formula for N options:
```
N_k_init = MARKET_ANTE / (N * (N - 1) + N)   ... needs derivation
```

The exact initialization formula should be derived carefully during implementation. The key constraint is: all pools start at `prob = 1/N` and the total ante equals `MARKET_ANTE`.

The creator receives no shares from the ante — it is pure liquidity provision. This is different from DPM where the creator got shares. The creator's reward comes from the `CREATOR_REWARD_RATE` fee.

### Adding a New Option Mid-Market

When a user submits a custom option via `add_option`:

1. **Cost**: 10 credits. The submitter pays this; it seeds the new pool's liquidity. **The submitter receives the initial YES shares** — they effectively bet 10 credits on their new option at the seed price.
2. **Initial probability**: Seed the new option at low probability to incentivize adding plausible underdogs:
   ```
   p_init = min(5%, max(1/(N*4), 1%))
   ```
   where N = number of options after adding (i.e., existing + 1). Examples: N=5 → 5%; N=10 → 2.5%; N=25 → 1%. The 1% floor prevents absurdly tiny odds; the 5% cap prevents new options from starting too high when there are few options.
3. Create the new binary CPMM pool with 10 credits of liquidity, initialized so `prob = p_init`.
4. Run the arbitrage to rebalance all existing pools so probabilities sum to 100% — this slightly reduces every existing option's probability to make room.
5. If the survey has `allow_custom_options: false`, this step never happens.

**Payout incentive**: At 5% initial probability, the option pays ~20x if it wins; at 2.5%, ~40x. Because the submitter receives these shares, they have skin in the game — a strong incentive to add plausible underdog options that the market might be undervaluing.

## Fee Structure

Fees are charged on the **profit** from a trade, not the gross amount. This is simpler and fairer than the current DPM approach of charging on gross.

- **Fee rate**: `FEE_RATE` (currently 5%, tunable)
- **On buy**: Fee is charged on profit at settlement, not at purchase. Alternatively, fee can be charged on the gross purchase amount and diverted to the voter fee pool (current approach). For simplicity, keep the current approach: deduct fee from the purchase amount before it enters the pool.
- **On sell (cash out)**: Fee is charged on the gross credits received before payout.
- **Voter dividend**: The fee pool is still distributed equally among all voters at settlement.
- **Creator reward**: `CREATOR_REWARD_RATE` up to `CREATOR_REWARD_CAP`, same as today.

### Fee Implementation Choice

**Option A — Fee on gross (simpler, current approach)**: When user spends `m` credits, `fee = m * FEE_RATE` goes to voter/creator pools, and `m - fee` enters the CPMM as the effective purchase. This reduces the shares received but keeps the CPMM math clean.

**Option B — Fee on profit at settlement (Manifold's approach)**: At settlement, fee = `max(0, payout - cost_basis) * FEE_RATE`. More complex to track (need cost basis per user per option) but fairer.

**Recommendation**: Option A for simplicity. It's what we have today and the CPMM already gives fair pricing — the fee is a known cost at purchase time.

## Data Model Changes

### Current DPM Market State (per survey)

```js
{
  pools: { optKey: creditAmount },        // credit pool per option
  totalShares: { optKey: shareCount },     // total shares per option
  userShares: { pubkey: { optKey: N } },   // shares held per user per option
  feePool: Number,
  totalPool: Number,                       // sum of all option pools
  grossBetsByUser: { pubkey: N },          // tracking for leaderboard
  netSellsByUser: { pubkey: N },
  creatorReward: Number,
  creator: pubkey
}
```

### New CPMM Market State (per survey)

```js
{
  pools: {
    optKey: { yes: Y, no: N }             // binary CPMM pool per option
  },
  userShares: {
    pubkey: { optKey: sharesYes }          // YES shares held per user per option
  },
  feePool: Number,
  grossBetsByUser: { pubkey: N },
  netSellsByUser: { pubkey: N },
  creatorReward: Number,
  creator: pubkey
}
```

Key differences:
- Each option has `{ yes, no }` instead of a single pool amount
- `totalShares` is gone — share counts are implicit in user holdings
- `totalPool` is gone — replaced by the sum of all CPMM liquidities
- Users hold YES shares (a simple count), not DPM shares

### Credit Balance

Same formula:
```
balance = 1000 (if joined)
         - antes
         - grossBets
         + netSells
         + payouts (from settlement)
         + dividends (from voter fees)
         + creatorRewards
```

No change needed to credit flow tracking.

## Settlement

When a survey expires and the winning option is determined (by most votes):

1. **Winner identified**: Option with most votes wins (tie-breaking rules unchanged)
2. **YES share payout**: Each YES share of the winning option is worth **1 credit**. User payout = number of YES shares they hold in the winning option.
3. **Losing options**: YES shares of losing options are worth 0.
4. **Voter dividends**: Fee pool divided equally among all voters (unchanged).
5. **Refund (no winner)**: If no valid winner (zero votes, unresolvable tie), return liquidity proportionally. Each user's YES shares across all options are valued at the current CPMM sell price.

### Why Settlement is Simpler

In DPM, settlement required computing `(userShares / totalShares) * totalPool` — a variable payout depending on the final share distribution. In CPMM, it's just: **count the user's YES shares in the winning option**. Each is worth 1 credit. Done.

The total payout may exceed or fall short of the total liquidity in the pools. This is fine — the CPMM acts as a market maker that can run at a profit or loss. The "house" (initial ante liquidity) absorbs the difference. This is the same tradeoff Manifold makes: the market creator subsidizes liquidity.

**Important**: The total payout to YES holders of the winner = total YES shares outstanding for that option. The total credits in the system (across all pools) may differ. The difference is the market maker's P&L. If the market was well-calibrated, this is small. If it was badly wrong, the creator loses more of their ante.

## Transaction Memo Changes

### `place_bet` — No Change Needed

```json
{ "app": "opinion-market", "type": "place_bet", "survey": "id", "option": "key", "credits": N }
```

The interpretation changes (credits buy YES shares via CPMM + arbitrage instead of DPM shares), but the memo format is identical. Existing `place_bet` transactions from before the migration will be replayed under the new CPMM logic, producing different share counts. This means **market state will change for active surveys** at migration time.

### `sell_shares` — Change Share Semantics

```json
{ "app": "opinion-market", "type": "sell_shares", "survey": "id", "option": "key", "shares": N }
```

Same format, but `shares` now means YES shares (which have a fixed 1-credit payout if the option wins), not DPM shares (which had variable payout). The sell price is determined by the CPMM at the time of the transaction.

### Migration Compatibility

Since all state is derived from transaction replay, the migration happens automatically when the replay logic changes. Old transactions are reinterpreted under CPMM rules. This means:

- Active surveys will see their market state recalculated
- Historical settled surveys will see different settlement amounts (if replayed)
- Users' credit balances may shift

**Recommendation**: Accept this as a clean break. The credit system is virtual (not real tokens), so balance shifts are cosmetic. Alternatively, settle all active markets before deploying, then start fresh.

## Code Changes Required

All changes are in `opinion-market.html`. The sections below reference the current line numbers.

### 1. Constants (lines 730-734)

No changes to `FEE_RATE`, `MARKET_ANTE`, `CREATOR_REWARD_RATE`, `CREATOR_REWARD_CAP`. Remove `EXIT_CAP_RATIO` — CPMM's constant product provides natural sell bounds.

### 2. Phase 5b — Market Initialization (lines 1166-1183)

**Replace entirely.** Instead of seeding one pool per option with `perOpt` credits and shares, create a binary CPMM pool per option:

```js
for (const opt of survey.options) {
  mkt.pools[opt.key] = { yes: Y_init, no: N_init };
}
```

Where `Y_init` and `N_init` are derived from `MARKET_ANTE` and option count so that each option starts at `prob = 1/N`.

### 3. Phase 6 — Market Operations: `place_bet` (lines 1202-1234)

**Replace entirely.** New logic:

1. Deduct fee from credits
2. Buy YES shares of the target option via CPMM (mint YES+NO, deposit NO, withdraw YES)
3. Run arbitrage loop: buy NO on all other options to rebalance probabilities to sum to 100%, redeem cross-option share bundles for credits, use credits to buy more YES
4. Record total YES shares received
5. Update user share holdings and credit flows

### 4. Phase 6 — Market Operations: `sell_shares` (lines 1236-1265)

**Replace entirely.** New logic:

1. Sell YES shares back to the CPMM pool for the option
2. Deduct fee from credits received
3. Run arbitrage to rebalance (selling YES on one option shifts probabilities)
4. Update user share holdings and credit flows

### 5. Phase 7 — Settlement (lines 1268-1349)

**Simplify.** Winner determination is unchanged (most votes wins). Payout is now:

```js
for (const [pubkey, shares] of Object.entries(mkt.userShares)) {
  const s = shares[winner] || 0;
  if (s > 0) settlement.payouts[pubkey] = s;  // 1 credit per YES share
}
```

The `distributeRefund` function (lines 1388-1397) needs updating to use CPMM sell prices instead of DPM pool fractions.

### 6. Buy Preview UI (lines 2446-2469)

**Replace calculation.** Instead of simulating DPM shares, simulate the CPMM purchase:

```js
// Simulate buying m credits of YES on this option
const shares = cpmmBuyYes(pool, m_after_fee);
const payout = shares;  // each share worth 1 credit if wins
const mult = payout / m_gross;
```

The preview can now show a **guaranteed** payout (not "approximately"), since CPMM payouts are fixed.

### 7. Sell Preview UI (lines 2510-2527)

**Replace calculation.** Simulate the CPMM sell to show credits received.

### 8. Position Display (lines 2535-2553)

**Simplify.** Instead of computing ownership percentage and variable payout:

```
You hold: X shares
Payout if wins: X credits (guaranteed)
Cash-out value: [CPMM sell price] credits
```

### 9. Market Display — Probability and Pool (lines 2393-2420)

**Change probability source.** Instead of `pool / totalPool`, use:

```js
const prob = pool.no / (pool.yes + pool.no);
```

Pool display changes from a single credit amount to the CPMM liquidity measure (e.g., `sqrt(Y * N)` or just show the implied probability).

### 10. Fee Info Display (lines 2565-2577)

Update to reflect new pool structure. `totalPool` concept changes — could show total liquidity across all options or total credits bet.

### 11. Settled Market Display (lines 2581-2650+)

Minor changes — payout amounts are now integer YES share counts rather than fractional pool claims.

## New Helper Functions Needed

### `cpmmBuyYes(pool, amount)` → shares received

Given a pool `{ yes, no }` and `amount` credits, compute YES shares received:

```js
function cpmmBuyYes(pool, amount) {
  const { yes, no } = pool;
  const newNo = no + amount;
  const newYes = (yes * no) / newNo;
  return amount + (yes - newYes);  // minted + released from pool
}
```

### `cpmmSellYes(pool, shares)` → credits received

Given a pool and `shares` YES shares to sell, compute credits out:

```js
function cpmmSellYes(pool, shares) {
  const { yes, no } = pool;
  const newYes = yes + shares;
  const newNo = (yes * no) / newYes;
  return no - newNo;  // NO shares released, converted to credits
}
```

### `cpmmProb(pool)` → probability

```js
function cpmmProb(pool) {
  return pool.no / (pool.yes + pool.no);
}
```

### `arbitrage(pools, targetOption, credits)` → { sharesReceived, newPools }

The core arbitrage function. Iteratively:
1. Buy YES on `targetOption`
2. Buy NO on all other options to rebalance
3. Redeem cross-option bundles for credits
4. Repeat until convergence

This is the most complex new function. Manifold's [open-source implementation](https://github.com/manifoldmarkets/manifold/blob/main/common/src/calculate-cpmm-arbitrage.ts) is a reference.

## Engineering Risks and Research Learnings

Independent research evaluation surfaced the following; plan for these when implementing:

### Arbitrage Convergence (Critical)

Manifold's first prototype took **1 full second** for 4 options using nested binary search. They achieved **3ms** only after:
- Community-contributed closed-form solutions (see [Manifold GitHub issue #1553](https://github.com/manifoldmarkets/manifold/issues/1553))
- Fixing `p = 0.5` for all sub-markets (sacrifices some capital efficiency but makes math tractable)

**Action**: Treat closed-form arbitrage as a hard dependency. Do not ship with iterative guess-and-check; benchmark convergence for typical option counts (2–10) before committing.

### Maniswap Is Not Vanilla Constant Product

Manifold uses a parameterized variant: `k = y^p · n^(1−p)` with `p = 0.5` for multi-outcome sub-markets. When `p = 0.5`, this reduces to `sqrt(y*n) = k` (equivalent to `y*n = k²`). Our spec's vanilla `Y*N=K` is compatible; the key is to fix `p=0.5` and not make it tunable.

### Compounded Slippage

Buying YES on one option incurs slippage across all other options' AMMs. Grows with N. For markets with **10+ options**, this becomes noticeable. Consider capping or discouraging very large option sets.

### Limit Orders — Defer

If we support limit orders alongside the AMM, traversal during arbitrage is complex. Manifold community described it as "a nightmare." **Recommendation**: Ship CPMM with AMM-only trading first. Layer on limit orders only after the core mechanism is stable.

### Option Addition Rebalancing

Adding an option mid-market requires creating a new pool and rebalancing all existing pools. Consider requiring a **credit cost** to seed new pools (spam prevention + liquidity bootstrapping).

### Display Complexity

Manifold users reported multi-outcome portfolio views as confusing. Plan for UX work on position display and "your holdings across options" views.

### Migration: Grandfather vs Force-Migrate

- **Grandfather**: Let existing DPM I markets run to expiry; new markets use CPMM. Simpler, less disruptive.
- **Force-migrate**: Recalculate all positions under CPMM rules. User balances and positions change; higher risk of confusion.

**Recommendation**: Grandfather. DPM I is acceptable for in-flight markets; CPMM applies to new markets going forward.

---

## Migration Strategy

1. **Implement CPMM helpers** (`cpmmBuyYes`, `cpmmSellYes`, `cpmmProb`, `arbitrage`) as pure functions, using Manifold's closed-form solutions
2. **Unit test** the helpers with known scenarios (verify fixed payouts, verify arbitrage convergence, verify probabilities sum to 1)
3. **Benchmark** arbitrage convergence for 2, 4, 8, 10 options; target <10ms per trade for client-side replay
4. **Replace Phase 5b** (market initialization) with CPMM pool creation
5. **Replace Phase 6** (market operations) with CPMM buy/sell + arbitrage
6. **Replace Phase 7** (settlement) with fixed-payout logic
7. **Update UI** (buy preview, sell preview, position display, market display)
8. **Test end-to-end** in `--local-dev` mode with multiple users
9. **Grandfather** existing DPM I markets; apply CPMM only to new markets created after deployment

## Open Questions

1. **Ante amount**: Resolved — keep the same `MARKET_ANTE`. CPMM with arbitrage effectively shares liquidity across pools, so the impact of splitting across N pools is small.

2. **New option cost**: Resolved — 10 credits, seeding at `min(5%, max(1/(N*4), 1%))` initial probability. See "Adding a New Option Mid-Market" above.

3. **Surprise metric**: Not used yet, but when implemented, use `cpmmProb(pool)` — i.e. `N_k / (Y_k + N_k)` — for market probability instead of DPM pool fractions. The formula `vote_share - market_probability` is unchanged conceptually.

4. **Sell cap**: Resolved — remove `EXIT_CAP_RATIO` for CPMM. The constant product provides natural bounds; no separate sell cap needed.

5. **Convergence speed**: Resolved by using closed-form arbitrage (Manifold issue #1553). Must benchmark before shipping.

## References

- [Manifold Markets — Dynamic Parimutuel](https://manifoldmarkets.notion.site/Dynamic-Parimutuel-b9b48a09ea1f45b88d991231171730c5) (the model we're replacing)
- [Manifold Markets — Multiple Choice Markets](https://news.manifold.markets/p/multiple-choice-markets) (the model we're adopting)
- [Manifold Markets — Multi Binary Spec](https://manifoldmarkets.notion.site/Multi-set-of-binary-markets-8bd7ad1fde074e67b75bc1dd65f9a59a)
- [Kevin Zielnicki — Mismatched Monetary Motivation](https://kevin.zielnicki.com/2022/02/17/manifold/) (analysis of DPM's broken incentives)
- [Manifold Arbitrage Code (GitHub)](https://github.com/manifoldmarkets/manifold/blob/main/common/src/calculate-cpmm-arbitrage.ts)
- [Manifold GitHub #1553](https://github.com/manifoldmarkets/manifold/issues/1553) — closed-form arbitrage solutions
- [Manifold Above the Fold: Market Mechanics](https://news.manifold.markets/p/above-the-fold-market-mechanics) — DPM→CPMM transition rationale
