# Human Input Market — Product Spec

## Core Concept

The Collective Intelligence Service is renamed to **Human Input Market** (HIM). Each question is a single object where users **vote** (expressing their genuine belief) and **bet credits** (predicting what the crowd will choose). Voting and betting are separate actions — you can vote for option A but bet on option B. The delta between vote share and market share is itself a signal about collective intelligence.

Questions gain a **reveal mechanism**: votes are submitted on-chain but hidden in the UI until periodic reveal checkpoints. The prediction market settles at question expiry based on which option received the most votes.

## Credit System

- **Initial grant**: 1000 credits on first `join` transaction (one-time per pubkey, derived from chain history)
- **All memo-tracked**: Credits are virtual. All txs still use `amount = 1` on-chain. Credit quantities live in memo fields.
- **Balance derivation**: `1000 - sum(active bets) + sum(settled winnings)`. Recomputed from full tx history on each refresh.
- **Credits cannot go negative**: UI validates sufficient balance before allowing a bet.

## Prediction Market — DPM (Dynamic Parimutuel Market) with Shares

Follows the same mechanism Manifold Markets uses for multi-outcome prediction markets. Users buy and sell **shares** of options. Share prices move with every trade, creating continuous price discovery.

### How Buying Works

Each option has a credit pool. When you spend M credits on option A:

```
shares_received = M * (totalPool / poolA)
```

- If A is unpopular (small pool relative to total), you get many shares per credit (cheap entry)
- If A is popular (large pool), you get fewer shares per credit (expensive entry)
- After the purchase, `poolA` increases by M, shifting implied odds

**Example**: Pool is {Blue: 200, White: 800} (total 1000).

- Betting 100 on Blue: `100 * 1000/200 = 500 shares` (buying the underdog)
- Betting 100 on White: `100 * 1000/800 = 125 shares` (buying the favorite)

### How Selling Works

You can sell shares back to the pool at current market rate:

```
credits_received = shares * (poolA / totalSharesA)
```

- **Exit cap**: Sales are capped to prevent extracting more credits than the pool can sustain (same constraint Manifold uses). A sell cannot reduce an option's pool below a minimum threshold (e.g., 1% of total pool or the initial creator subsidy).
- Selling reduces your share count and returns credits to your balance; the pool shrinks accordingly.

### Implied Probability

```
probability(A) = poolA / totalPool
```

Shifts with every buy and sell. This IS the market price.

### Settlement

At survey expiry, the option with the most **votes** wins. The entire pool (all options combined) is distributed to holders of the winning option's shares, proportional to shares held:

```
payout = (myShares / totalWinningShares) * totalPool
```

### Early Bettor Advantage (Built Into the Math)

- Alice bets 100 on Blue early when Blue is 20% of pool → gets 500 shares
- Bob bets 100 on Blue late when Blue is 60% of pool → gets 167 shares
- If Blue wins, Alice earns 3x more than Bob from the same 100-credit bet
- No arbitrary fees needed — the share pricing naturally rewards conviction

### Edge Cases

- **No bets on winning option**: all bets returned (no winner)
- **Zero votes at expiry**: all bets returned (market voided)
- **Tie in votes**: option with more total credits bet wins (tiebreaker); if still tied, all bets returned
- **Survey with 0 bets**: no market, just a regular vote
- **Selling at a loss**: if you bought an option that became unpopular, selling returns fewer credits than you spent (your shares are worth less). This is the natural cost of being wrong.

## Voter Dividend Fee

A small fee is taken from market activity and distributed equally to all voters in that question, regardless of how they voted. This creates a direct incentive to vote — the behavior that drives market resolution.

### Mechanics

- **Fee rate**: 5% on all market transactions (buying and selling shares). Tunable.
- **Fee pool**: Each question accumulates a fee pool from its market activity.
- **Distribution**: At settlement, the fee pool is divided equally among all unique voters (one share per voter, regardless of which option they voted for or when they voted).
- **Effect on DPM**: When a user spends M credits buying shares, `0.95 * M` enters the option pool and `0.05 * M` enters the voter fee pool. Share calculation uses the net amount entering the pool. Similarly for sells: `0.95 * credits_received` goes to the seller, `0.05 * credits_received` goes to the voter fee pool.

### Why This Works

- **Incentivizes voting**: Voting is free and earns you a share of market fees. Even users who don't want to bet are rewarded for participating.
- **Agnostic to vote choice**: No incentive to vote strategically for fee purposes — you earn the same regardless of which option you picked.
- **Scales with market activity**: Popular, heavily-traded questions generate larger voter dividends, naturally rewarding participation in the questions people care about most.
- **Creates a flywheel**: More voters → more reliable settlement → more bettor confidence → more market activity → more fees → more voter reward → more voters.

### Credit Balance Update

With the fee, credit balance derivation becomes:

```
balance = 1000 (if joined)
        - sum(credits spent buying shares, gross)
        + sum(credits received selling shares, net of fee)
        + sum(settlement payouts)
        + sum(voter dividends from settled questions)
```

## Reveal Mechanism

- Survey creator configures `reveal_interval_ms`: none (single reveal at end), 1 day, 2 days, 3 days, or 7 days
- **Between reveals**: Votes are accepted and recorded on-chain, but the UI does not display tallies. A "vote submitted" confirmation is shown instead of live results.
- **At each reveal checkpoint** (`createTs + i * revealInterval`): cumulative vote tallies become visible in the UI for all votes submitted before that checkpoint.
- **Vote changes**: Users can change their vote at any time during the active period. Only the most recent vote before each checkpoint counts for that checkpoint's tally. Only the most recent vote before expiry counts for final settlement.
- **Bets**: Can be placed (bought) or sold anytime during the active period. DPM share pricing naturally rewards early, correct bets (more shares per credit when the option is cheap).
- **Soft hide for v1**: Votes are visible in raw chain data. The UI simply doesn't render them until the reveal checkpoint passes. True cryptographic commit-reveal is a future enhancement.

## Survey Configuration

The `create_survey` memo gains new fields:

- `reveal_interval_ms` — one of: `null` (single reveal at end), `86400000` (1d), `172800000` (2d), `259200000` (3d), `604800000` (7d)
- `allow_custom_options` — `true`/`false` (replaces implicit current behavior)
- **Allowed durations expanded**: 1 min (testing), 2d-7d (current), plus 14d, 30d, 90d for longer prediction markets

## Transaction Types (Memo Schemas)

| Type            | Memo                                                                                                                                            | Notes                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `join`          | `{ app: "him", type: "join" }`                                                                                                                  | First per pubkey grants 1000 credits                                    |
| `create_survey` | `{ app: "him", type: "create_survey", survey: { id, title, question, options, active_duration_ms, reveal_interval_ms, allow_custom_options } }` | Enhanced config                                                         |
| `vote`          | `{ app: "him", type: "vote", survey: "id", choice: "key" }`                                                                                     | Hidden until reveal; earns voter dividend at settlement                 |
| `add_option`    | `{ app: "him", type: "add_option", survey: "id", option: { key, label } }`                                                                      | Only when `allow_custom_options: true`                                  |
| `place_bet`     | `{ app: "him", type: "place_bet", survey: "id", option: "key", credits: N }`                                                                    | Buy shares: 5% fee to voter pool, remainder buys shares at current odds |
| `sell_shares`   | `{ app: "him", type: "sell_shares", survey: "id", option: "key", shares: N }`                                                                   | Sell shares at market rate; 5% fee to voter pool; exit cap              |
| `set_username`  | `{ app: "him", type: "set_username", username: "name_suffix" }`                                                                                 | Unchanged                                                               |

**Backward compatibility**: `app: "cis"` and `app: "exocortex"` are still accepted during parsing for legacy transactions.

## State Derivation (All Client-Side)

All state is derived by scanning the full transaction history on each refresh (same pattern as today, extended):

- **Usernames**: latest `set_username` per sender (unchanged)
- **Surveys**: `create_survey` txs with rate limiting (unchanged, extended config)
- **Votes**: latest `vote` per sender per survey (unchanged, but display gated by reveal checkpoints)
- **Custom options**: oldest `add_option` per sender per survey (unchanged, gated by `allow_custom_options`)
- **Credit balances**: `1000 (if joined) - sum(gross credits spent buying) + sum(net credits from selling) + sum(settlement payouts) + sum(voter dividends)`
- **Market state per survey** (derived via sequential tx replay):
  - Per option: `{ pool: totalCredits, totalShares: totalOutstanding }`
  - Per user per option: `{ shares: N }`
  - Implied probability: `pool / totalPool`
  - Fee pool: `sum(5% of all buy and sell transactions in this survey)`
- **Sequential replay**: `place_bet` and `sell_shares` transactions must be processed in chronological order because each transaction's share price depends on the pool state at that moment. Every client replays the same sequence and arrives at the same deterministic state.
- **Settlement**: For expired surveys: (1) identify winning option (most votes), (2) distribute total market pool to winning shareholders proportional to shares, (3) distribute fee pool equally among all unique voters.
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
  - **Market**: For each option — implied probability (%), total pool, share price. Your position (shares held, current value). Buy/sell controls. Shows "your potential payout if this wins."
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

Take the exact question from a trending Crypto Twitter poll, run the identical question on Human Input Market, and post the comparison: *"Twitter says X. Here's what verified humans say."*

- Mirror the original poll's options exactly (usually `allow_custom_options: false`)
- Short duration matching the CT poll's energy: 2-3 days
- `reveal_interval_ms: null` (single reveal at end) to maximize the "big reveal" moment for the comparison post
- The contrast between bot-polluted CT results and verified-human HIM results IS the launch content
- Every CT mirror question is a marketing event: post the result comparison back to CT with the surprise metric ("CT said 72% Yes. Verified humans said 41% Yes. The market predicted 55%.")
- Repeatable: new trending poll = new mirror question = new comparison content = new reason to visit HIM

## Open Design Questions (Can Decide During Implementation)

1. **Can you buy shares in multiple options in the same survey?** Recommended: yes. This lets users hedge and creates richer market dynamics.
2. **Can you buy more shares after an initial purchase?** Yes, via a new `place_bet` tx (each purchase is independent, priced at current odds). Shares accumulate.
3. **Can you sell shares?** Yes, via `sell_shares` tx. Shares sold at current market rate. Exit cap prevents draining the pool.
4. **New options mid-survey**: When someone adds a custom option to a survey with an active market, the new option starts with 0 pool and 0 shares. First buyer gets very cheap shares (bootstraps the pool).
5. **Minimum bet**: 1 credit. No maximum (limited only by balance).
6. **Pool bootstrap**: The first bet on any option seeds that option's pool. No initial liquidity required from the system or the survey creator — DPM bootstraps naturally from the first trade.

## Surprise Metric (v1 — Display Only)

After a question settles, compute and display the **Surprise Index** for each option:

```
surprise(option) = actual_vote_share - final_market_probability
```

Where `actual_vote_share` is the option's fraction of total votes at expiry, and `final_market_probability` is the DPM implied probability (`poolA / totalPool`) at the moment voting closed.

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

**Human Input Market** (HIM). Captures the fusion of surveys (human input) and prediction markets. The app identifier in memos is `"him"` (with `"cis"` and `"exocortex"` accepted for backward compatibility). Each question is a "Human Input" — simultaneously a survey and a market.

## Implementation Todos

- [ ] Credit system: join transaction, balance derivation from tx history, UI balance display
- [ ] Extend create_survey with reveal_interval_ms, allow_custom_options, expanded durations
- [ ] Reveal mechanism: checkpoint calculation, vote hiding between reveals, progressive result display
- [ ] DPM with shares: place_bet (credits → shares at current odds), sell_shares (shares → credits at current odds), pool state derivation via sequential tx replay
- [ ] Settlement at expiry: winning option (most votes), share-proportional market payout, voter dividend (fee pool / unique voters), credit distribution
- [ ] Leaderboard: lifetime earnings tracking, ranked display, win rate
- [ ] Restructure survey detail screen into vote/results/market sections; add onboarding flow
