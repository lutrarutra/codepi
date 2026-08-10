# CodePi — build & packaging Makefile
#
# Convenience wrapper around the npm scripts plus packaging (vsce),
# install/uninstall into VS Code, verification, and cleanup.
#
# The package version follows the latest git tag (e.g. v0.2.0 -> 0.2.0):
# `make build` / `make vsix` / `make install` sync both the root package.json
# and webview-ui/package.json (plus their lockfiles) to the tag before
# building (output lands in dist/), falling back to the package.json version
# when no tag is reachable.
#
# Usage: `make help` lists all rules.

SHELL := /bin/bash

# Package version taken from package.json (drives the .vsix filename).
VERSION := $(shell node -p "require('./package.json').version")

# Latest git tag with the leading "v" stripped (e.g. v0.2.0 -> 0.2.0); empty
# when no tag exists. Picks the most recently created tag (by ref creation
# date) rather than git-describe: that stays correct even when several tags
# point at the same commit (describe picks one arbitrarily in that case).
# On a creatordate tie (lightweight tags on the same commit share the commit
# date) the -refname tiebreak prefers the highest tag name.
GIT_VERSION := $(shell git for-each-ref --sort=-creatordate --sort=-refname --format='%(refname:short)' refs/tags 2>/dev/null | head -1 | sed 's/^v//')

# Packaging tool. `vsce` (classic) or `@vscode/vsce` (maintained) both work;
# falls back to an on-demand npx install when neither is on PATH.
VSCE ?= $(or $(shell command -v vsce 2>/dev/null),npx --yes @vscode/vsce)

.PHONY: help all build build-webview build-extension check-types lint test unit \
	watch dev smoke verify package vsix install uninstall clean version _sync-version \
	deps deps-root deps-webview

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

## ── Build ───────────────────────────────────────────────────

all: build ## Alias for `build`

build: deps _sync-version build-webview build-extension ## Full production build (webview + extension); version synced from the latest git tag

build-webview: ## Build the webview UI (vite, tsc, terminal, fonts)
	@npm --prefix webview-ui run build

build-extension: check-types ## Build the extension host bundle (esbuild, production)
	@node esbuild.mjs --production

check-types: ## Type-check the extension host (tsc --noEmit)
	@npx tsc -p ./tsconfig.json --noEmit

lint: check-types ## Alias for `check-types`

watch: ## Watch mode: webview + tsc + esbuild rebuild on change
	@npm run watch

dev: watch ## Alias for `watch`

## ── Verify ──────────────────────────────────────────────────

test: unit ## Alias for `unit`
unit: ## Run the vitest suite
	@npx vitest run

smoke: ## Load the bundled extensions in isolation (smoke test)
	@node resources/extensions/__tests__/smoke-load.mjs

verify: check-types unit smoke ## Full pre-release check (types + tests + smoke)

## ── Package ─────────────────────────────────────────────────

package: vsix ## Alias for `vsix`
vsix: ## Build the .vsix into dist/ at the latest git tag version (vsce runs the prepublish build first)
	@$(MAKE) _sync-version
	@mkdir -p dist; \
	v=$$(node -p "require('./package.json').version"); \
	vsix="dist/codepi-$$v.vsix"; \
	echo "Packaging $$vsix …"; \
	$(VSCE) package -o "$$vsix"; \
	echo "Packaged: $$vsix"

_sync-version: ## Sync package.json + webview-ui/package.json versions to the latest git tag (internal)
	@if [ -z "$(GIT_VERSION)" ]; then \
		echo "No git tag reachable from HEAD — keeping package.json version $(VERSION)"; \
	elif [ "$(GIT_VERSION)" = "$(VERSION)" ]; then \
		echo "Version $(VERSION) already matches latest tag v$(GIT_VERSION)"; \
	elif ! echo "$(GIT_VERSION)" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+([.-].+)?$$'; then \
		echo "Tag v$(GIT_VERSION) is not valid semver — keeping package.json version $(VERSION)"; \
	else \
		echo "Syncing package.json version $(VERSION) -> $(GIT_VERSION) (git tag v$(GIT_VERSION))"; \
		npm version "$(GIT_VERSION)" --no-git-tag-version --allow-same-version; \
	fi
	@if [ -z "$(GIT_VERSION)" ]; then \
		echo "No git tag reachable from HEAD — keeping webview-ui version $$(node -p "require('./webview-ui/package.json').version")"; \
	elif [ "$(GIT_VERSION)" = "$$(node -p "require('./webview-ui/package.json').version")" ]; then \
		echo "webview-ui version $$(node -p "require('./webview-ui/package.json').version") already matches latest tag v$(GIT_VERSION)"; \
	elif ! echo "$(GIT_VERSION)" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+([.-].+)?$$'; then \
		echo "Tag v$(GIT_VERSION) is not valid semver — keeping webview-ui version $$(node -p "require('./webview-ui/package.json').version")"; \
	else \
		echo "Syncing webview-ui version $$(node -p "require('./webview-ui/package.json').version") -> $(GIT_VERSION) (git tag v$(GIT_VERSION))"; \
		npm --prefix webview-ui version "$(GIT_VERSION)" --no-git-tag-version --allow-same-version; \
	fi

release: verify package ## Verify everything, then produce the .vsix

## ── Install ─────────────────────────────────────────────────

# install: uninstalls any older version first (stale side-by-side installs
# can shadow the new build — VS Code resolves one version per extension id),
# then installs the freshly built .vsix from dist/.
install: vsix ## Build and install the .vsix into VS Code (replaces older installs)
	@code --uninstall-extension lutrarutra.codepi >/dev/null 2>&1 || true
	@code --install-extension "dist/codepi-$$(node -p "require('./package.json').version").vsix" --force
	@echo "Installed: lutrarutra.codepi $$(node -p "require('./package.json').version") — reload your VS Code window"

uninstall: ## Uninstall CodePi from VS Code
	code --uninstall-extension lutrarutra.codepi

## ── Dependencies ───────────────────────────────────────────

deps: deps-root deps-webview ## Install all dependencies (root + webview-ui)

deps-root: ## Install root dependencies
	@npm install

deps-webview: ## Install webview-ui dependencies
	@npm --prefix webview-ui install

## ── Cleanup ─────────────────────────────────────────────────

clean: ## Remove build outputs and packaged .vsix files
	rm -rf dist webview-ui/dist dist/*.vsix

## ── Misc ────────────────────────────────────────────────────

version: ## Print the effective version (latest git tag when present, else package.json)
	@echo "root:       $(if $(GIT_VERSION),$(GIT_VERSION)  (from git tag v$(GIT_VERSION)),$(VERSION)  (from package.json))"
	@echo "webview-ui: $$(node -p "require('./webview-ui/package.json').version")  (package.json)"
