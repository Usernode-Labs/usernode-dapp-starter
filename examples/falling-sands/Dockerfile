# Build context: examples/ (set via docker-compose context: ..)
#
# ── Stage 1: Build the WASM module ───────────────────────────────────────────
FROM rust:1.83-slim AS wasm-builder

RUN apt-get update && apt-get install -y curl pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

WORKDIR /build
COPY falling-sands/sandspiel/ sandspiel/
RUN cd sandspiel && wasm-pack build crate --target nodejs

# ── Stage 2: Node.js runtime ────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

COPY falling-sands/package.json falling-sands/package-lock.json* ./falling-sands/
RUN cd falling-sands && { [ -f package-lock.json ] && npm ci --omit=dev || npm install --omit=dev; }

# Shared library (so require('../lib/dapp-server') resolves)
COPY lib/ lib/

# Falling-sands server, engine, loaders (node + browser), client
COPY falling-sands/server.js falling-sands/engine.js falling-sands/wasm-loader.js falling-sands/wasm-browser.js falling-sands/index.html ./falling-sands/
COPY falling-sands/usernode-bridge.js ./falling-sands/

# Built WASM package
COPY --from=wasm-builder /build/sandspiel/crate/pkg/ falling-sands/sandspiel/crate/pkg/

EXPOSE 3333

WORKDIR /app/falling-sands
CMD ["node", "server.js"]
