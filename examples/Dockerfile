# ── Stage 1: Build the WASM module ───────────────────────────────────────────
FROM rust:1.83-slim AS wasm-builder

RUN apt-get update && apt-get install -y curl pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

WORKDIR /build
COPY examples/falling-sands/sandspiel/ sandspiel/
RUN cd sandspiel && wasm-pack build crate --target nodejs

# ── Stage 2: Node.js runtime ────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

COPY examples/package.json examples/package-lock.json* ./
RUN [ -f package-lock.json ] && npm ci --omit=dev || npm install --omit=dev

# Shared library modules
COPY examples/lib/ lib/

# Combined server
COPY examples/server.js ./

# Shared bridge and identity module (from repo root)
COPY usernode-bridge.js ./
COPY usernode-usernames.js ./

# HTML files for all apps
COPY index.html ./
COPY examples/opinion-market/opinion-market.html opinion-market/
COPY examples/opinion-market/opinion-market-core.js opinion-market/
COPY examples/opinion-market/vote-encryption.js opinion-market/
COPY examples/falling-sands/index.html falling-sands/
COPY examples/last-one-wins/index.html last-one-wins/
COPY examples/last-one-wins/game-logic.js last-one-wins/
COPY examples/echo/index.html echo/
COPY examples/echo/echo-logic.js echo/

# Falling-sands engine + WASM loaders (node + browser) + built WASM package
COPY examples/falling-sands/engine.js falling-sands/
COPY examples/falling-sands/seed-content.js falling-sands/
COPY examples/falling-sands/wasm-loader.js falling-sands/
COPY examples/falling-sands/wasm-browser.js falling-sands/
COPY --from=wasm-builder /build/sandspiel/crate/pkg/ falling-sands/sandspiel/crate/pkg/

RUN mkdir -p /app/data

EXPOSE 8000

CMD ["node", "server.js"]
