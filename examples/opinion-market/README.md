# Opinion Market

A prediction-market-powered survey platform where users **vote** (expressing
genuine belief) and **bet credits** (predicting what the crowd will choose) —
all stored on-chain as transaction memos.

See [OPINION_MARKET_SPEC.md](OPINION_MARKET_SPEC.md) for the full
product spec.

## What's in this folder

```
examples/opinion-market/
├── opinion-market.html           # The dapp UI (single HTML file)
├── OPINION_MARKET_SPEC.md        # Product spec
└── README.md                     # This file
```

## Running locally

From the **repo root** (`usernode-dapp-starter/`):

```bash
node server.js --local-dev
```

Open http://localhost:8000/opinion-market in your browser.

You can:
- **Join** — first visit grants 1000 credits.
- **Set your username** — click the name in the top-right header.
- **Create a question** — configure duration, reveal interval, and options.
- **Vote** — tap any option to cast your vote (hidden until reveal checkpoint).
- **Bet** — spend credits to buy shares on any option at current market odds.
- **Sell shares** — exit a position at current market rate.
- **Leaderboard** — see lifetime earnings from correct predictions.
