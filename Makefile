# CodePi — build & packaging Makefile
#
# Convenience wrapper around the npm scripts plus packaging (vsce),
# install/uninstall into VS Code, verification, and cleanup.
#
# Usage: `make help` lists all rules.

SHELL := /bin/bash

# Package version taken from package.json (drives the .vsix filename).
VERSION := $(shell node -p "require('./package.json').version")

# Packaging tool. `vsce` (classic) or `@vscode/vsce` (maintained) both work;
# falls back to an on-demand npx install when neither is on PATH.
VSCE ?= $(or $(shell command -v vsce 2>/dev/null),npx --yes @vscode/vsce)

VSIX := codepi-$(VERSION).vsix

.PHONY: help all build build-webview build-extension check-types lint test unit \
	watch dev smoke verify package vsix install uninstall clean version

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
vsix: ## Build the .vsix (vsce runs the prepublish build first)
	$(VSCE) package -o $(VSIX)
	@echo "Packaged: $(VSIX)"

release: verify package ## Verify everything, then produce the .vsix

## ── Install ─────────────────────────────────────────────────

install: vsix ## Install the built .vsix into VS Code (force-replaces)
	code --install-extension $(VSIX) --force

uninstall: ## Uninstall CodePi from VS Code
	code --uninstall-extension lutrarutra.codepi

## ── Cleanup ─────────────────────────────────────────────────

clean: ## Remove build outputs and packaged .vsix files
	rm -rf dist webview-ui/dist *.vsix

## ── Misc ────────────────────────────────────────────────────

version: ## Print the package version
	@echo $(VERSION)
