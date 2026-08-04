# CodePi — build & packaging Makefile
#
# Convenience wrapper around the npm scripts plus packaging (vsce),
# install/uninstall into VS Code, verification, and cleanup.
#
# The package version follows the latest git tag (e.g. v0.2.0 -> 0.2.0):
# `make vsix` / `make install` sync package.json to the tag before packaging
# (output lands in dist/), falling back to the package.json version when no
# tag is reachable.
#
# Usage: `make help` lists all rules.

SHELL := /bin/bash

# Package version taken from package.json (drives the .vsix filename).
VERSION := $(shell node -p "require('./package.json').version")

# Latest git tag with the leading "v" stripped (e.g. v0.2.0 -> 0.2.0); empty
# when no tag is reachable from HEAD. Packaging syncs package.json to this.
GIT_VERSION := $(shell git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')

# Packaging tool. `vsce` (classic) or `@vscode/vsce` (maintained) both work;
# falls back to an on-demand npx install when neither is on PATH.
VSCE ?= $(or $(shell command -v vsce 2>/dev/null),npx --yes @vscode/vsce)

.PHONY: help all build build-webview build-extension check-types lint test unit \
	watch dev smoke verify package vsix install uninstall clean version _sync-version

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

## ── Build ───────────────────────────────────────────────────

all: build ## Alias for `build`

build: build-webview build-extension ## Full production build (webview + extension)

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

_sync-version: ## Sync package.json version to the latest git tag (internal)
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

release: verify package ## Verify everything, then produce the .vsix

## ── Install ─────────────────────────────────────────────────

# install: vsix ## Install the built .vsix from dist/ into VS Code (force-replaces)
# 	@code --install-extension "dist/codepi-$$(node -p "require('./package.json').version").vsix" --force

uninstall: ## Uninstall CodePi from VS Code
	code --uninstall-extension lutrarutra.codepi

## ── Cleanup ─────────────────────────────────────────────────

clean: ## Remove build outputs and packaged .vsix files
	rm -rf dist webview-ui/dist dist/*.vsix

## ── Misc ────────────────────────────────────────────────────

version: ## Print the effective version (latest git tag when present, else package.json)
	@echo "$(if $(GIT_VERSION),$(GIT_VERSION)  (from git tag v$(GIT_VERSION)),$(VERSION)  (from package.json))"
