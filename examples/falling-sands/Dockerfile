# ── Stage 1: Build the WASM module ───────────────────────────────────────────
FROM rust:1.83-slim AS wasm-builder

RUN apt-get update && apt-get install -y curl pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

WORKDIR /build
COPY sandspiel/ sandspiel/
RUN cd sandspiel && wasm-pack build crate --target nodejs

# ── Stage 2: Node.js runtime ────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js wasm-loader.js index.html ./
COPY usernode-bridge.js ./

# Copy only the built WASM package (not the full sandspiel source)
COPY --from=wasm-builder /build/sandspiel/crate/pkg/ sandspiel/crate/pkg/

EXPOSE 3333

CMD ["node", "server.js"]
