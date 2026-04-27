# Last One Wins

A "last one wins" token game on the Usernode blockchain.

Players send tokens to the game's address. Each send resets a countdown timer (default 24 hours). When the timer expires with no new sends, the last sender wins the entire pot. The server automatically pays out via the node's RPC.

## Quick Start (local dev)

```bash
node server.js --local-dev
# Open http://localhost:3333
```

In local dev mode the timer is 2 minutes so you can test the full cycle quickly.

## How it works

### Transaction flow

1. Player calls `sendTransaction(APP_PUBKEY, amount, memo)` via the bridge
2. Server polls chain / mock store for new transactions to `APP_PUBKEY`
3. Each `{ app: "lastwin", type: "entry" }` transaction resets the timer and adds to the pot (usernames are tracked via `{ app: "lastwin", type: "set_username" }` transactions)
4. When the timer expires, the server sends a payout transaction from `APP_PUBKEY` to the winner
5. The payout memo is `{ app: "lastwin", type: "payout", round: N, winner: "ut1..." }`
6. A new round begins

### Server-side payouts

The server holds `APP_SECRET_KEY` and calls two node RPC endpoints:
- `POST /wallet/signer` — configures the signing key
- `POST /wallet/send` — sends the payout transaction

If the payout fails due to UTXO fragmentation (many small deposits), the server attempts a consolidation self-send before retrying.

### Usernames

Players can set a display name via `{ app: "lastwin", type: "set_username", username: "alice_a1b2c3" }` transactions. The server tracks the latest username per sender and includes the mapping in the game state response. The client shows usernames (with a clickable pill to edit) instead of raw public keys.

### Game state API

`GET /__game/state` returns:

```json
{
  "roundNumber": 1,
  "potBalance": 500,
  "lastSender": "ut1...",
  "lastEntryTs": 1708000000000,
  "timerDurationMs": 86400000,
  "timeRemainingMs": 43200000,
  "timerExpired": false,
  "entries": [...],
  "pastRounds": [...],
  "payoutInProgress": false,
  "appPubkey": "ut1...",
  "usernames": { "ut1...": "alice_a1b2c3" }
}
```

The client polls this endpoint every 4 seconds for UI updates.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3333` | HTTP port |
| `APP_PUBKEY` | — | Game pot address |
| `APP_SECRET_KEY` | — | Secret key for payout signing |
| `NODE_RPC_URL` | `https://alpha1.usernodelabs.org` | Node RPC endpoint |
| `TIMER_DURATION_MS` | `86400000` (24h) | Countdown duration |

## Files

- `index.html` — game UI (single HTML file)
- `server.js` — standalone server (for independent local dev)
- `game-logic.js` — shared game state/payout logic (used by both standalone and combined server)
