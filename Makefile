.PHONY: up down start stop restart logs ps build examples-up examples-up-local examples-down examples-logs node usernode-image usernode-image-amd64

USERNODE_BIN        ?= ../usernode/target/release/usernode
USERNODE_REPO       ?= ../usernode
USERNODE_TAG        ?= usernode:local
USERNODE_TAG_AMD64  ?= $(USERNODE_TAG)-amd64
GENESIS_URL         ?= https://static.usernodelabs.org/testnet/genesis.json
SEEDLIST_URL        ?= https://static.usernodelabs.org/testnet/seedlist.txt
NODE_PORT           ?= 3000

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
