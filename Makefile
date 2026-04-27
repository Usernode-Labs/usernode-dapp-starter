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
		$(WALLET_OWNER_FLAGS)

# Local dev: start dapp-examples container (connects to native node on host).
# Run `make node` in a separate terminal first.
examples-up:
	cd examples && docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build dapp-examples

examples-down:
	cd examples && docker compose -f docker-compose.yml -f docker-compose.local.yml down

examples-logs:
	cd examples && docker compose -f docker-compose.yml -f docker-compose.local.yml logs -f --tail=200
