# Opinion Market — Product Spec

## Core Concept

**Opinion Market** is a prediction-market-powered survey platform. Each question is a single object where users **vote** (expressing their genuine belief) and **bet credits** (predicting what the crowd will choose). Voting and betting are separate actions — you can vote for option A but bet on option B. The delta between vote share and market share is itself a signal about collective intelligence.

Questions gain a **reveal mechanism**: votes are submitted on-chain but hidden in the UI until periodic reveal checkpoints. The prediction market settles at question expiry based on which option received the most votes.

## Credit System

- **Initial grant**: 1000 credits on first `join` transaction (one-time per pubkey, derived from chain history)
- **All memo-tracked**: Credits are virtual. All txs still use `amount = 1` on-chain. Credit quantities live in memo fields.
- **Balance derivation**: `1000 - antes - grossBets + netSells + payouts + dividends + creatorRewards`. Recomputed from full tx history on each refresh.
- **Credits cannot go negative**: UI validates sufficient balance before allowing a bet.

---

## Prediction Market — Linked Binary CPMM

Uses Manifold Markets' **linked binary CPMM** approach (p=0.5) for multi-option prediction markets. Originally used DPM (Dynamic Parimutuel Market); migrated to CPMM for fixed payouts, natural buy/sell, and linked multi-option arbitrage.

Reference: [manifoldmarkets/manifold](https://github.com/manifoldmarkets/manifold) — `common/src/calculate-cpmm.ts`, `common/src/calculate-cpmm-arbitrage.ts`

### Key Properties

1. **Fixed payouts**: Each YES share pays 1 credit if that option wins, 0 if it loses. Return known at purchase.
2. **Dynamic pricing**: CPMM moves price with trades. Popular options cost more per share.
3. **Linked liquidity**: Buying YES on one option arbitrages NO on others. Probabilities sum to 100%.
4. **New options mid-market**: Supported. New pool created; arbitrage rebalances.

### Single-Pool Math

- **Invariant**: `k = yes * no` (constant product, equivalent to Manifold's `y^0.5 * n^0.5`)
- **Probability**: `no / (yes + no)`
- **Buy/sell**: closed-form formulas from the constant-product invariant
- **Inverse** (`cpmmAmountForShares`): closed-form from Manifold's `calculateAmountToBuySharesFixedP`

**Pool state**: Each option `k` has `pool[k] = { yes: Y_k, no: N_k }` with invariant `Y_k * N_k = K_k`.

**Share identity**: 1 YES share in every option = 1 credit. 1 NO share in option k = 1 YES share in every other option.

**Buying YES** (spend `m` credits):
- Mint `m` YES + `m` NO. Deposit NO to pool. Pool releases YES to maintain invariant.
- YES received: `m + Y_k * m / (N_k + m) = m * (Y_k + N_k + m) / (N_k + m)`.

**Selling YES** (sell `s` shares): Credits received = `N_k * s / (Y_k + s)`.

### Multi-Option Buy-Arbitrage

Matches Manifold's `calculateCpmmMultiArbitrageBetYes` — **buy-NO-in-others** strategy:

1. Binary search over `noShares` (NO shares to buy in each other answer)
2. For each other answer: compute credits needed via `cpmmAmountForShares` (closed-form)
3. Apply sums-to-one identity: `noShares` NO in all others = `noShares` YES in target + `noShares * (n-2)` mana redemption
4. Remaining budget buys YES directly in target
5. Total shares = `noShares` (from identity) + direct YES shares
6. Constraint: `sum(probabilities) = 1`

### Multi-Option Sell-Arbitrage

Matches Manifold's `calculateCpmmMultiArbitrageSellYes` — **buy-NO-in-target + buy-YES-in-others + redeem** strategy:

1. Binary search over `noShares` (0..sharesToSell)
2. Buy `noShares` NO in the **target** pool (costs `noAmount` credits)
3. Buy `yesSharesInOthers = sharesToSell - noShares` YES in **each other** pool (costs `yesAmounts`)
4. Redeem pairs: `noShares` (NO\_target + YES\_target) form pairs → `noShares` credits; remaining YES form complete sets → `yesSharesInOthers` credits
5. Net credits = `sharesToSell - noAmount - totalYesAmounts`
6. Constraint: `sum(probabilities) = 1`

**Key property**: A full round-trip (buy then sell all) returns exactly the original investment with no value extraction from pools. When the market moves between buy and sell, the user gains or loses accordingly.

### Initialization

**Creator ante** (`MARKET_ANTE` = 50 credits): For N options at `prob = 1/N`:
```
N_k = ante / (2*(n-1)),  Y_k = (n-1)*N_k
```
Creator receives no shares from ante. Pools are initialized at `MARKET_ANTE + PLATFORM_LIQUIDITY` = 500 effective depth (see Platform-Subsidized Liquidity below).

### Data Model

```js
pools: { optKey: { yes, no } }
userShares: { pubkey: { optKey: sharesYes } }
```

Settlement: 1 credit per YES share of winner.

### Implementation

CPMM logic lives in `opinion-market-core.js` (UMD module, works in browser + Node). Tests in `test/opinion-market-core.test.js`. Run `npm test`.

---

## Fee Structure

A 5% fee is taken from all market activity (buying and selling shares).

| Component | Rate | Description |
|-----------|------|-------------|
| Total fee | 5% (`FEE_RATE`) | Per bet or sell |
| Creator cut | 0.5% (`CREATOR_REWARD_RATE`), capped at 100/market | Rewards question creator |
| Liquidity reinvestment | 2% (`LIQUIDITY_FEE_RATE`) | Reinvested into pools (increases k) |
| Voter dividends | ~2.5% (remainder) | Distributed to voters at settlement |

### Voter Dividends

The voter dividend portion of fees creates a direct incentive to vote — the behavior that drives market resolution.

- **Fee pool**: Each question accumulates voter fees from its market activity.
- **Distribution**: At settlement, the fee pool is divided equally among all unique voters (one share per voter, regardless of which option they voted for or when they voted).
- **Agnostic to vote choice**: No incentive to vote strategically for fee purposes.
- **Flywheel**: More voters → more reliable settlement → more bettor confidence → more market activity → more fees → more voter reward → more voters.

### Liquidity Reinvestment

After each trade (buy or sell), `addPoolLiquidity` scales all pools proportionally by the liquidity fee amount. This preserves current probabilities while increasing the `k` invariant (`yes * no`), which deepens the market and reduces slippage for future trades. Popular markets with many transactions automatically become more liquid over time.

Follows the same design pattern as Manifold's `liquidityFee` + `addCpmmLiquidity` architecture (though Manifold currently has all fee rates set to zero).

### Creator Rewards

Question creators earn 0.5% of all trading volume in their market, capped at 100 credits per market. This incentivizes creating engaging questions that drive trading activity.

---

## Platform-Subsidized Liquidity

Creator pays `MARKET_ANTE` (50 credits) to create a market. The platform adds `PLATFORM_LIQUIDITY` (450 credits) of free virtual liquidity, so pools initialize at an effective depth of 500. This reduces price impact from a 100-credit bet at 50/50 from ~39pp (at ante=50) to ~9pp (at ante=500).

Manifold solves this differently — they give creators subsidized mana and allow third-party liquidity provision. Our approach is simpler: the subsidy is automatic and invisible to users.

## Bet Cap

Individual bets are capped at `MAX_BET_POOL_RATIO` (30%) of total pool value. This prevents any single bet from moving the price more than ~21pp even at max size. The cap grows over time as pools deepen from liquidity reinvestment.

Enforced in three places: state rebuild (rejects over-cap bets), `placeBetFlow` pre-send check (throws error), and UI input max (limits the input field).

---

## Differences from Manifold

| Aspect | Manifold | Opinion Market |
|--------|----------|----------------|
| **Fees** | Taker fee, creator fee, liquidity fee; iterative (currently all 0) | 5% flat (0.5% creator, 2% liquidity, ~2.5% voters) |
| **Initial liquidity** | Creator-funded + third-party LPs + platform subsidies | Creator pays 50, platform adds 450 automatically |
| **Bet limits** | No hard cap (limit orders provide price protection) | 30% of total pool value |
| **Limit orders** | `computeFills` matches against limit orders | None |
| **Liquidity injection** | `addCpmmLiquidity`; adjusts `p` | Proportional scaling via fee reinvestment (preserves `p`) |
| **Settlement** | Admin/creator resolves | Automatic: most votes wins at expiry |

### Future Improvements

1. **Parametrized CPMM**: Support `p ≠ 0.5` for binary markets with asymmetric seeding.
2. **Fee refinement**: Iterative fee calculation on effective probability.
3. **Limit orders**: Allow users to set price targets.

---

## Reveal Mechanism

- Survey creator configures `reveal_interval_ms`: none (single reveal at end), 1 day, 2 days, 3 days, or 7 days
- **Between reveals**: Votes are encrypted on-chain (ECDH P-256 + AES-GCM). Neither the UI nor chain scrapers can see vote choices until the server publishes the decryption key.
- **At each reveal checkpoint** (`createTs + i * revealInterval`): the server publishes the private key for that interval as an on-chain `reveal_key` transaction. Clients decrypt votes and display cumulative tallies.
- **Vote changes**: Users can change their vote at any time during the active period. Only the most recent decryptable vote counts for each checkpoint's tally. Only the most recent decryptable vote before expiry counts for final settlement.
- **Bets**: Can be placed (bought) or sold anytime during the active period. Share pricing naturally rewards early, correct bets.
- **Legacy plaintext fallback**: If encryption keys are unavailable (server down, misconfigured), votes fall back to plaintext `choice` field for backward compatibility.

### Encryption Architecture

Each survey interval gets a unique P-256 ECDH key pair derived deterministically from a master seed (`VOTE_ENCRYPT_SEED`). The server:
1. Watches for `create_survey` transactions on-chain
2. Publishes all public keys for the survey in a `publish_pubkeys` transaction (batched if >10 intervals)
3. At each reveal checkpoint, publishes the private key scalar in a `reveal_key` transaction

The client:
1. Reads public keys from on-chain `publish_pubkeys` txs (falls back to `GET /__om/pubkeys/:id`)
2. Encrypts the vote choice with an ephemeral ECDH key pair + AES-GCM, producing an opaque `ev` blob
3. At reveal time, reads `reveal_key` txs and decrypts votes locally using Web Crypto

### Trust Model

The encryption server holds the master seed and can decrypt votes at any time. This prevents casual chain scraping but does not provide cryptographic guarantees against a malicious server operator. True commit-reveal (where the server cannot see votes) is a future enhancement pending device-scheduled task APIs.

## Survey Configuration

The `create_survey` memo gains new fields:

- `reveal_interval_ms` — one of: `null` (single reveal at end), `86400000` (1d), `172800000` (2d), `259200000` (3d), `604800000` (7d)
- `allow_custom_options` — `true`/`false` (replaces implicit current behavior)
- **Allowed durations expanded**: 1 min (testing), 2d-7d (current), plus 14d, 30d, 90d for longer prediction markets

## Transaction Types (Memo Schemas)

| Type            | Memo                                                                                                                                            | Notes                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `join`          | `{ app: "opinion-market", type: "join" }`                                                                                                                  | First per pubkey grants 1000 credits                                    |
| `create_survey` | `{ app: "opinion-market", type: "create_survey", survey: { id, title, question, options, active_duration_ms, reveal_interval_ms, allow_custom_options } }` | Enhanced config                                                         |
| `vote`          | `{ app: "opinion-market", type: "vote", survey: "id", ev: "base64", ki: N }` (or legacy: `{ ..., choice: "key" }`)                                         | Encrypted until reveal; earns voter dividend at settlement              |
| `publish_pubkeys` | `{ app: "opinion-market", type: "publish_pubkeys", survey: "id", keys: { "0": "base64pub", ... } }`                                                      | Server publishes ECDH public keys for each interval                     |
| `reveal_key`    | `{ app: "opinion-market", type: "reveal_key", survey: "id", ki: N, d: "base64url_scalar" }`                                                                | Server reveals private key at checkpoint; clients decrypt votes          |
| `add_option`    | `{ app: "opinion-market", type: "add_option", survey: "id", option: { key, label } }`                                                                      | Only when `allow_custom_options: true`                                  |
| `place_bet`     | `{ app: "opinion-market", type: "place_bet", survey: "id", option: "key", credits: N }`                                                                    | 5% fee (split: 0.5% creator, 2% liquidity, ~2.5% voters), remainder buys shares |
| `sell_shares`   | `{ app: "opinion-market", type: "sell_shares", survey: "id", option: "key", shares: N }`                                                                   | Sell shares at market rate; same fee split                              |
| `set_username`  | `{ app: "opinion-market", type: "set_username", username: "name_suffix" }`                                                                                 | Legacy (global usernames via `usernode-usernames.js` preferred)         |


## State Derivation (All Client-Side)

All state is derived by scanning the full transaction history on each refresh:

- **Usernames**: Global usernames via `UsernodeUsernames` module; legacy per-app `set_username` as fallback
- **Surveys**: `create_survey` txs with rate limiting
- **Votes**: latest `vote` per sender per survey (display gated by reveal checkpoints)
- **Custom options**: oldest `add_option` per sender per survey (gated by `allow_custom_options`)
- **Credit balances**: `1000 (if joined) - antes - grossBets + netSells + payouts + dividends + creatorRewards`
- **Market state per survey** (derived via sequential tx replay):
  - Per option: `{ pool: { yes, no } }` (CPMM pool)
  - Per user per option: `{ shares: N }`
  - Implied probability: `no / (yes + no)` per pool
  - Fee pool: voter dividend portion of fees from all buy/sell transactions
- **Sequential replay**: `place_bet` and `sell_shares` transactions must be processed in chronological order because each transaction's share price depends on the pool state at that moment. Every client replays the same sequence and arrives at the same deterministic state.
- **Settlement**: For expired surveys: (1) identify winning option (most votes), (2) each winning YES share pays 1 credit, (3) distribute fee pool equally among all unique voters.
- **Voter set**: The set of unique pubkeys with a `vote` transaction for that survey. One dividend share per voter regardless of vote count or timing.

## Leaderboard

- **Metric**: Lifetime credits earned from correct predictions (winnings minus original stake returned)
- **Derivation**: Sum all net winnings across all settled markets per user
- **Display**: Ranked list with username, total earnings, win rate (markets won / markets bet on)
- **Global**: Not per-survey. Persists across all surveys.

## UI Screens

### Modified Screens

1. **Header**: Add credit balance display (coin icon + number). Add leaderboard button.
2. **Survey List**: Add badges for "next reveal in Xh" and "N credits in market". Active/archived split unchanged.
3. **Survey Detail** — restructured into sections:
  - **Question + Countdown**: Survey title, question, time to next reveal, time to expiry
  - **Your Vote**: Option picker with "submitted, hidden until reveal" confirmation. Shows your current vote if already cast.
  - **Results** (only for passed reveal checkpoints): Vote bar chart, same as today but only showing data up to the last reveal
  - **Market**: For each option — implied probability (%), pool depth, share price. Your position (shares held, current value). Buy/sell controls. Shows "your potential payout if this wins."
  - **Settled Market** (archived surveys only): Final results + winning option + payout amounts per shareholder + surprise index per option ("White was 12% more popular than the market predicted")

### New Screens

1. **Leaderboard**: Ranked table — rank, username, lifetime earnings, markets participated, win rate
2. **Join/Onboarding**: First-visit flow — "Welcome, you have 1000 credits" with explanation of voting vs betting

## Example Questions

Questions fall into a few natural categories. Each category exercises different features of the platform.

### Fun / Viral

**"Which color is the dress? Blue or white?"**

- `allow_custom_options: false`, `reveal_interval_ms: 86400000` (daily), duration: 3 days
- 3 reveals. Simple binary bet. Low stakes, high engagement. Good onboarding question.

**"Is the current market a bull trap?"**

- Options: Yes / No / Too early to tell
- `allow_custom_options: false`, `reveal_interval_ms: null` (single reveal at end), duration: 7 days
- Timely, opinionated, drives engagement. Single reveal at end maximizes suspense and blind betting.
- Interesting surprise metric candidate: does the market over- or under-predict confidence?

### Community Recognition

**"Best crypto podcast?"**

- `allow_custom_options: true`, `reveal_interval_ms: 172800000` (2 days), duration: 7 days
- Users submit their picks as custom options. Market reveals which podcasts the community bets on vs. which they actually vote for — the gap is interesting (beauty contest: "what's popular" vs. "what's actually good").

**"Who was the most helpful community member this month?"**

- `allow_custom_options: true`, `reveal_interval_ms: null` (single reveal at end), duration: 14 days
- Nominations via custom options. Single reveal at end prevents bandwagon voting. Beauty contest is the point here — popularity IS the metric.

### Informative / Truth-Seeking

**"What AI setup is best for deep online research?"**

- `allow_custom_options: true`, `reveal_interval_ms: 86400000` (daily), duration: 7 days
- Users add their own setups as options. Market dynamics more complex because new options can appear mid-survey. Strong surprise metric candidate — the "surprisingly popular" answer might be the hidden gem setup that experts know about.

**"What will METR task doubling look like end of 2026?"**

- `allow_custom_options: true`, `reveal_interval_ms: 604800000` (weekly), duration: 90 days
- Long-running prediction market. Weekly reveals. The long duration and infrequent reveals create sustained engagement. Prime candidate for truth-seeking mode if implemented.

**"What percentage of crypto Twitter accounts are bots?"**

- Options: <10%, 10-25%, 25-50%, 50-75%, >75%
- `allow_custom_options: false`, `reveal_interval_ms: null` (single reveal at end), duration: 14 days
- Estimation question with range buckets. Single reveal keeps it honest — no anchoring to early results. The market probability distribution across buckets IS the collective estimate. Fascinating surprise metric: does the "true" answer outperform the market?

### Crypto Debates

**"Is Solana a legitimate Ethereum competitor or a VC chain?"**

- Options: Legitimate competitor / VC chain / Both / Neither
- `allow_custom_options: false`, `reveal_interval_ms: 86400000` (daily), duration: 5 days
- Tribal question — strong priors on both sides. Market dynamics will be volatile as reveals shift sentiment. The vote/bet split is particularly revealing here: people might bet on "Legitimate competitor" (pragmatic prediction) while voting "VC chain" (genuine belief).

### CT Mirror Questions (Launch Content Strategy)

**"[Whatever CT poll is trending today] — same question, verified humans only."**

Take the exact question from a trending Crypto Twitter poll, run the identical question on Opinion Market, and post the comparison: "Twitter says X. Here's what verified humans say."

- Mirror the original poll's options exactly (usually `allow_custom_options: false`)
- Short duration matching the CT poll's energy: 2-3 days
- `reveal_interval_ms: null` (single reveal at end) to maximize the "big reveal" moment for the comparison post
- The contrast between bot-polluted CT results and verified-human Opinion Market results IS the launch content
- Every CT mirror question is a marketing event: post the result comparison back to CT with the surprise metric ("CT said 72% Yes. Verified humans said 41% Yes. The market predicted 55%.")
- Repeatable: new trending poll = new mirror question = new comparison content = new reason to visit Opinion Market

## Open Design Questions

1. **Can you buy shares in multiple options in the same survey?** Yes. This lets users hedge and creates richer market dynamics.
2. **Can you buy more shares after an initial purchase?** Yes, via a new `place_bet` tx (each purchase is independent, priced at current odds). Shares accumulate.
3. **Can you sell shares?** Yes, via `sell_shares` tx. Shares sold at current market rate via sell-arbitrage.
4. **New options mid-survey**: When someone adds a custom option to a survey with an active market, a new pool is created and arbitrage rebalances probabilities.

## Surprise Metric (v1 — Display Only)

After a question settles, compute and display the **Surprise Index** for each option:

```
surprise(option) = actual_vote_share - final_market_probability
```

Where `actual_vote_share` is the option's fraction of total votes at expiry, and `final_market_probability` is the CPMM implied probability at the moment voting closed.

- Positive surprise: "White was 12% more popular than the market predicted" — the crowd knew something the market hadn't priced in.
- Negative surprise: "Blue was 8% less popular than expected" — the market overestimated this option.
- Near-zero surprise: the market was well-calibrated.

**Display**: Show surprise scores on the settled question screen alongside final results. No effect on payouts or settlement — purely informational. This builds user intuition and generates the data needed to evaluate truth-seeking mode later.

**Per-user tracking**: Optionally track each user's cumulative "surprise alignment" — how often their vote landed on the surprisingly popular side. This could feed into the leaderboard as a secondary metric ("truth-seeker score") but is not used for payouts in v1.

## Future: Truth-Seeking Settlement Mode (NOT implementing — for tracking only)

> This section documents a potential future enhancement. It is not part of the v1 implementation. We include it here so the design is on record and we can revisit once we have real data from the surprise metric.

### The Problem: Keynesian Beauty Contest

When markets settle on "most votes wins," voters are incentivized to vote for what they think *others* will vote for, not what they genuinely believe. This is fine for community recognition questions ("who's the best community member?") where popularity IS the goal, but suboptimal for truth-seeking questions ("what AI setup is actually best?") where you want honest expert input.

### The Mechanism: Surprisingly Popular Settlement

Drawing from Bayesian Truth Serum (Prelec, 2004), an alternative settlement mode would use the **"Surprisingly Popular" (SP) algorithm**:

- At settlement, compute each option's surprise score: `actual_vote_share - market_implied_probability`
- The option with the highest surprise score wins the market (instead of the option with the most votes)

**Why this incentivizes honesty**: Voting for the popular option can't generate surprise — the market already predicts it's popular. Only honest votes that reveal information the market hasn't fully captured produce positive surprise. Strategic coordination to vote with your bets is self-defeating because the market would predict that coordination, making it unsurprising.

### Design Considerations

- **Per-question setting**: Question creators would choose between Majority mode (default, beauty contest is fine) and Truth-seeking mode (SP settlement, for questions with "better" answers).
- **Market snapshot**: SP calculation requires a fixed market state snapshot. Options: (a) market state at the start of the final reveal period, (b) a time-weighted average over the last N hours, or (c) the market state at the moment of question creation (earliest, most "blind"). Needs experimentation.
- **Reveal interaction**: Each reveal partially exposes votes, giving traders real data. The surprise metric becomes less informative as more reveals occur. Truth-seeking mode may work best with fewer reveals (or a single reveal at end).
- **Circularity risk**: If traders know settlement uses SP, they'll try to predict which option will be surprisingly popular — which could change what's surprising. In theory, this converges to an equilibrium, but the dynamics are complex and need empirical validation.
- **User comprehension**: "The most popular option didn't win" is initially confusing. Would need clear UI explanation and education.

### Validation Path

1. Ship v1 with majority settlement + surprise metric display (informational only)
2. Collect data: how often does the surprisingly popular option differ from the majority winner?
3. Analyze: do questions where SP diverges from majority tend to have "better" answers (by some external measure)?
4. If the data supports it, add truth-seeking mode as an opt-in settlement type

## Naming

**Opinion Market**. Captures the fusion of surveys (human input) and prediction markets. The app identifier in memos is `"opinion-market"`. Each question is simultaneously a survey and a market.
