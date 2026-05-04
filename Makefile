.PHONY: up down start stop restart logs ps build examples-up examples-up-local examples-down examples-logs node node-full node-status fetch-archive bootstrap-prod-archive usernode-image usernode-image-amd64

USERNODE_BIN        ?= ../usernode/target/release/usernode
USERNODE_REPO       ?= ../usernode
USERNODE_TAG        ?= usernode:local
USERNODE_TAG_AMD64  ?= $(USERNODE_TAG)-amd64
GENESIS_URL         ?= https://static.usernodelabs.org/testnet/genesis.json
SEEDLIST_URL        ?= https://static.usernodelabs.org/testnet/seedlist.txt
NODE_PORT           ?= 3000
ARCHIVE_DIR         ?= $(HOME)/.usernode/archive
ARCHIVE_SEED_HOST   ?= testnet-seed1

build:
	docker compose build

up:
	docker compose up -d --build

down:
	docker compose down

start:
	docker compose start

stop:
	docker compose stop

restart:
	docker compose restart

logs:
	docker compose logs -f --tail=200

ps:
	docker compose ps

# Run usernode natively (required for Mac local dev; Docker P2P can't sync on Mac).
# Build first: cd ../usernode && cargo build --release -p usernode-cli
#
# Auto-tracks every `ut1...` ADDRESS in .env, regardless of variable name —
# `APP_PUBKEY`, `ECHO_APP_PUBKEY`, `TOKEN_ADDR`, etc. all work. We filter by
# value prefix (`ut1`) instead of variable suffix so we correctly skip:
#   - secret keys (`utsk1...`)
#   - raw public keys (`utpk1...` — wrong format for /wallet RPCs)
#   - blank values (e.g. `OM_ADMIN_PUBKEY=`)
# Override with WALLET_OWNERS="ut1... ut1..." if you need a different set.
WALLET_OWNERS ?= $(shell grep -shE '^[A-Z0-9_]+=ut1[a-z0-9]+$$' .env | cut -d= -f2 | sort -u)
WALLET_OWNER_FLAGS = $(foreach o,$(WALLET_OWNERS),--wallet-owner $(o))

node:
	$(USERNODE_BIN) node \
		--genesis-url $(GENESIS_URL) \
		--peer-list-url $(SEEDLIST_URL) \
		--port $(NODE_PORT) \
		--enable-recent-tx-stream \
		$(WALLET_OWNER_FLAGS)

# Run the node in true full-ledger mode by loading a remote archive snapshot.
#
# Why this exists: PARTIAL_LEDGER_RECENT_TX_SOURCE_BUG.md describes the
# `RecentTxEntry.source = null` failure that hits dapps reading the
# recent-tx stream off a partial-ledger node. The fix is to run the node
# with the full UTXO tree present, so `collect_block_input_owners_at_root`
# can resolve every input commitment (not just tracked-wallet ones).
#
# Plain `make node` does NOT give you a full ledger:
#   * `--wallet-owner` triggers the wallet-seed shortcut, which hydrates a
#     PARTIAL UTXO overlay via UtxosWithMerkleProofByOwner instead of
#     syncing from genesis.
#   * Removing `--wallet-owner` would force a multi-hour genesis sync, and
#     also breaks /wallet/send (no tracked owner).
#
# This target uses tizoc/PR-759: fetch a packaged archive snapshot from a
# seed node, then start with `--archive-load-only` so the node hydrates the
# FULL UTXO tree from the snapshot in seconds. From that root forward,
# every block is applied in full mode and source resolution is authoritative.
#
# Prereq (one-time):
#   ~/.ssh/config entries for testnet-seed1 / testnet-seed2 with
#   IdentityFile pointing at the right key. See PARTIAL_LEDGER_RECENT_TX_SOURCE_BUG.md.
#
# Auto-fetches the archive on first run if $(ARCHIVE_DIR) is missing or empty.
# To refresh an existing archive, run `make fetch-archive` explicitly.
#
# Verify it's actually full mode (in another terminal):
#   make node-status                                   # poll /status until Synced
#   grep -m1 'kind = "UtxoDb.InitFromArchive"' node.log   # archive load happened
#   grep -c   'apply_mode = "full"'    node.log
#   grep -c   'apply_mode = "partial"' node.log         # should stay flat after boot
node-full:
	@if [ -z "$$(ls -A '$(ARCHIVE_DIR)' 2>/dev/null)" ]; then \
		echo "==> Archive missing or empty at $(ARCHIVE_DIR) — fetching from $(ARCHIVE_SEED_HOST)"; \
		$(MAKE) fetch-archive; \
	fi
	@echo "=========================================="
	@echo "  make node-full -- starting at: $$(date '+%Y-%m-%d %H:%M:%S')"
	@echo "  Archive: $(ARCHIVE_DIR)"
	@echo "  Logs:    ./node.log"
	@echo "  In another terminal:"
	@echo "    make node-status                                    # poll /status"
	@echo "    grep -c 'apply_mode = \"partial\"' node.log         # should stay flat"
	@echo "=========================================="
	@$(USERNODE_BIN) node \
		--archive-load-only \
		--archive-path $(ARCHIVE_DIR) \
		--genesis-url $(GENESIS_URL) \
		--peer-list-url $(SEEDLIST_URL) \
		--port $(NODE_PORT) \
		--enable-recent-tx-stream \
		$(WALLET_OWNER_FLAGS) 2>&1 \
		| tee node.log \
		| grep --line-buffered -E 'apply_mode|UtxoDb\.(InitFromArchive|ApplyError)'

# Refresh the local archive snapshot from a seed node. Wipes $(ARCHIVE_DIR)
# and replaces it with whatever's current on the seed (--replace).
#
# Override the seed:  make fetch-archive ARCHIVE_SEED_HOST=testnet-seed2
fetch-archive:
	@echo "==> Fetching archive from $(ARCHIVE_SEED_HOST) → $(ARCHIVE_DIR)"
	$(USERNODE_REPO)/scripts/fetch-archive-snapshot.sh $(ARCHIVE_SEED_HOST) $(ARCHIVE_DIR) --replace

# Manual fallback for when GitHub Actions can't fetch the prod archive
# (seed unreachable, secrets misconfigured, etc.). Streams whatever's in
# $(ARCHIVE_DIR) — typically populated by `make node-full` — directly into
# the `examples_node-archive` docker volume on prod over SSH. No
# intermediate tarball lives on the prod box.
#
# The `examples_node-archive` volume name is the compose-derived default
# (project = `examples`, service-volume = `node-archive`). Update if you
# ever override COMPOSE_PROJECT_NAME.
#
# Usage:
#   make bootstrap-prod-archive PROD_SSH_HOST=user@prod.example.com
#
# Or set up a `~/.ssh/config` alias and:
#   make bootstrap-prod-archive PROD_SSH_HOST=usernode-prod
PROD_SSH_HOST ?= usernode-prod

bootstrap-prod-archive:
	@if [ -z "$$(ls -A '$(ARCHIVE_DIR)' 2>/dev/null)" ]; then \
		echo "ERROR: $(ARCHIVE_DIR) is empty. Run 'make fetch-archive' first."; \
		exit 1; \
	fi
	@echo "==> Streaming $(ARCHIVE_DIR) → $(PROD_SSH_HOST):examples_node-archive"
	@tar -czf - -C '$(ARCHIVE_DIR)' . | ssh '$(PROD_SSH_HOST)' \
		'docker run --rm -i -v examples_node-archive:/archive alpine sh -c "rm -rf /archive/* && tar -xzf - -C /archive && echo \"==> Volume populated: \$$(du -sh /archive | cut -f1)\""'

# Polls /status once per second and prints sync state, our best-tip height,
# the highest height seen across connected peers, and connected-peer count.
# Stops automatically once node_sync_status reports "Synced" and prints the
# elapsed wall-clock time since the poll started, so you can use this to
# measure how long `make node-full` takes to catch up.
#
# Requires `jq` (brew install jq).
#
# Schema (RpcStatusResp; see crates/node/src/rpc/rpcs/status.rs):
#   .node_sync_status              -> bare enum string ("Synced" / "Syncing" / ...)
#   .blockchain.best_tip.height    -> our local tip height
#   .peers[].best_tip_height       -> per-peer tip height
#   .peers[].connection_status     -> "Connected" / "Connecting" / ...
node-status:
	@if ! command -v jq >/dev/null 2>&1; then \
		echo "jq not found. Install with: brew install jq"; exit 1; \
	fi
	@start=$$(date +%s); \
	echo "Polling http://localhost:$(NODE_PORT)/status every 1s; will stop on Synced."; \
	while :; do \
		resp=$$(curl -fsS "http://localhost:$(NODE_PORT)/status" 2>/dev/null || echo ""); \
		if [ -z "$$resp" ]; then \
			printf "[%4ds] node not reachable yet on :%s\n" $$(( $$(date +%s) - start )) "$(NODE_PORT)"; \
		else \
			status=$$(echo "$$resp"  | jq -r '.node_sync_status // "?"' 2>/dev/null); \
			height=$$(echo "$$resp"  | jq -r '.blockchain.best_tip.height // "?"' 2>/dev/null); \
			peer_h=$$(echo "$$resp"  | jq -r '[(.peers // [])[] | (.best_tip_height // 0)] | max // 0' 2>/dev/null); \
			peers=$$(echo "$$resp"   | jq -r '[(.peers // [])[] | select(.connection_status == "Connected")] | length' 2>/dev/null); \
			printf "[%4ds] status=%-12s height=%s/%s connected_peers=%s\n" $$(( $$(date +%s) - start )) "$$status" "$$height" "$$peer_h" "$$peers"; \
			if [ "$$status" = "Synced" ]; then \
				echo "==> Synced after $$(( $$(date +%s) - start )) seconds."; \
				break; \
			fi; \
		fi; \
		sleep 1; \
	done

# Local dev: start dapp-examples container (connects to native node on host).
# Run `make node` in a separate terminal first.
#
# `--env-file ../.env` is required because compose-file interpolation
# (e.g. `${APP_PUBKEY}` for the node sidecar's --wallet-owner flags)
# looks up vars in the working directory's `.env` by default. The Makefile
# `cd examples` puts us next to the compose file, so without this flag
# Compose silently substitutes empty strings and breaks /wallet/send.
# (The `env_file: ../.env` inside the compose file only handles per-service
# *runtime* envs, not parse-time interpolation — different mechanism.)
EXAMPLES_COMPOSE = docker compose --env-file ../.env -f docker-compose.yml -f docker-compose.local.yml

examples-up:
	cd examples && $(EXAMPLES_COMPOSE) up -d --build dapp-examples

# Build a usernode image from the local checkout at USERNODE_REPO. Tags it
# USERNODE_TAG so it doesn't stomp on `usernodelabs/usernode:latest`. Use
# this to test a usernode feature branch end-to-end against the dapps —
# whatever's checked out in $(USERNODE_REPO) is what gets built.
#
# Builds for the host architecture. On Apple Silicon that means linux/arm64,
# which won't run on a typical x86 prod server — use `usernode-image-amd64`
# for shippable artifacts.
usernode-image:
	cd $(USERNODE_REPO) && docker build -t $(USERNODE_TAG) .

# Cross-build a usernode image for linux/amd64. Required when shipping to
# an x86 prod server from an Apple Silicon host. Loads the result into the
# local docker daemon so you can `docker push` (or `docker save`) it.
#
# On Apple Silicon this builds under qemu emulation of x86, which is slow
# (~30–60 min cold; minutes on rebuilds thanks to the Dockerfile's cargo
# cache mounts). On a native amd64 Linux host it's just a normal build.
#
# To push to a registry: override the tag, then `docker push` after build.
#   USERNODE_TAG_AMD64=ghcr.io/your-org/usernode:my-branch make usernode-image-amd64
#   docker push ghcr.io/your-org/usernode:my-branch
#
# Then in prod, set USERNODE_IMAGE to that same tag (via .env or the
# USERNODE_IMAGE GitHub Actions secret — see .github/workflows/deploy.yml).
usernode-image-amd64:
	cd $(USERNODE_REPO) && docker buildx build --platform linux/amd64 -t $(USERNODE_TAG_AMD64) --load .

# Like `examples-up`, but uses the locally-built usernode image as the
# sidecar instead of pulling `usernodelabs/usernode:latest`. The compose
# file falls back to the published image when USERNODE_IMAGE is unset, so
# the regular `examples-up` target is unchanged.
#
# Brings up the `node` service alongside `dapp-examples` via the
# `linux-node` profile (the only point of building locally is to test
# *that* node end-to-end). Note: Docker P2P doesn't sync on Mac — this
# target is for Linux / CI. On Mac, build the binary instead and use
# `make node` + `make examples-up`.
examples-up-local: usernode-image
	cd examples && USERNODE_IMAGE=$(USERNODE_TAG) $(EXAMPLES_COMPOSE) --profile linux-node up -d --build

examples-down:
	cd examples && $(EXAMPLES_COMPOSE) down

examples-logs:
	cd examples && $(EXAMPLES_COMPOSE) logs -f --tail=200
