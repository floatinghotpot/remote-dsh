# remote-dsh monorepo — common entry points (thin wrapper over pnpm/scripts).
# Usage: `make <target>`; `make help` lists all targets.
#
# Scale-out relay (Go) moved to the private rdsh-cloud repo.
# Single-node self-hosting uses the hub's built-in relay; no Go build here.

.PHONY: help deps build test clean pub pub-check \
        pub-tunnel pub-gateway pub-hub pub-hub-cli pub-cli pub-web-remote

help: ## list all targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN{FS=":.*## "};{printf "  \033[36m%-22s\033[0m %s\n",$$1,$$2}'

deps: ## install dependencies (frozen lockfile)
	pnpm install --frozen-lockfile

build: deps ## build all packages (portal first)
	pnpm build

test: build ## run the full test suite (builds first)
	pnpm test

clean: ## remove all dist directories
	pnpm clean

pub: deps ## publish all npm packages in dependency order (interactive 2FA)
	bash scripts/publish.sh

pub-tunnel: ## publish rdsh-tunnel only
	pnpm --filter "./packages/tunnel" publish --no-git-checks --config.verify-deps-before-run=false

pub-gateway: ## publish rdsh-gateway only
	pnpm --filter "./packages/gateway" publish --no-git-checks --config.verify-deps-before-run=false

pub-hub: ## publish rdsh-hub only
	pnpm --filter "./packages/hub" publish --no-git-checks --config.verify-deps-before-run=false

pub-hub-cli: ## publish rdsh-hub-cli only (needs rdsh-hub + rdsh-gateway published)
	pnpm --filter "./packages/hub-cli" publish --no-git-checks --config.verify-deps-before-run=false

pub-cli: ## publish remote-dsh only
	pnpm --filter "./packages/cli" publish --no-git-checks --config.verify-deps-before-run=false

pub-web-remote: ## publish dsh-web-remote only
	pnpm --filter "./packages/web-remote" publish --no-git-checks --config.verify-deps-before-run=false

pub-check: ## check each package's local version is the one published on npm
	@fail=0; \
	for pkg in tunnel gateway hub hub-cli cli web-remote; do \
	  name=$$(node -p "require('./packages/$$pkg/package.json').name"); \
	  want=$$(node -p "require('./packages/$$pkg/package.json').version"); \
	  have=$$(npm view "$$name" version 2>/dev/null || true); \
	  if [ "$$have" = "$$want" ]; then printf "  \033[32mok  \033[0m %-16s %s\n" "$$name" "$$want"; \
	  else printf "  \033[31mMISS\033[0m %-16s local=%s npm=%s\n" "$$name" "$$want" "$${have:-none}"; fail=1; fi; \
	done; \
	exit $$fail
