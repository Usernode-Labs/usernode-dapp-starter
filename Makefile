.PHONY: up down start stop restart logs ps build examples-up examples-down examples-logs node

USERNODE_BIN ?= ../usernode/target/release/usernode
GENESIS_URL  ?= https://static.usernodelabs.org/testnet/genesis.json
SEEDLIST_URL ?= https://static.usernodelabs.org/testnet/seedlist.txt
NODE_PORT    ?= 3000

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
# Auto-tracks every PUBKEY-shaped variable in .env (APP_PUBKEY, ECHO_APP_PUBKEY, ...)
# so /wallet/send works for each dapp. Override with WALLET_OWNERS="ut1... ut1..." if needed.
WALLET_OWNERS ?= $(shell grep -sE '^[A-Z0-9_]*PUBKEY=' .env | cut -d= -f2 | sort -u)
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

examples-down:
	cd examples && $(EXAMPLES_COMPOSE) down

examples-logs:
	cd examples && $(EXAMPLES_COMPOSE) logs -f --tail=200
