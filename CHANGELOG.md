# Changelog

All notable changes to CodePi are documented in this file.

## Unreleased

- **Update to pi 1.0.4** (from 0.87.1). The SDK API is unchanged for our
  integration — `createAgentSession`, `AgentSessionRuntime`, `SettingsManager`,
  `InteractiveMode` and the pi-tui components all work as before — so the bump is
  mostly version plumbing:
  - The host-integration patch keeps its four files (upstream 1.0 added
    `baseToolsOverride` to `AgentSessionOptions` but `createAgentSession` still
    neither declares nor forwards it, and `createToolDefinitionFromAgentTool`
    still drops prompt metadata and renderers). It now also forwards
    `renderShell`, and the default-tool hunk moved to
    `initialActiveToolNames` because 1.0 computes the active set itself.
    `@earendil-works/pi-tui` follows to 1.0.4.
  - typebox is imported directly (`typebox` is a direct dependency now) instead
    of through a deep path into pi's nested `node_modules`.
  - The TUI is pinned to `tuiMode: "regular"`. pi 1.0 runs fullscreen by
    default; CodePi renders the TUI into its own xterm.js webview and owns
    scrollback, find, and viewport anchoring, so the alternate-screen layout
    would fight those features.
  - Packaging: pi 1.0 hoists its dependency closure to the root `node_modules`
    (0.87.x nested it under `pi-coding-agent`), so `.vscodeignore` now
    allow-lists every production package explicitly. Without that the vsix
    shipped 131 of 148 packages missing and died at activation.
    `src/__tests__/packaging-allowlist.test.ts` recomputes the closure from the
    lockfile and fails when the allowlist drifts; `scripts/check-package.mjs`
    also asserts the SDK's entry points are in the built vsix.
  - Test/dev plumbing follows the hoisted layout: the vitest alias map and the
    bundled-extension smoke loader resolve their entries through the package
    resolver instead of hardcoding `pi-coding-agent/node_modules/...`.
- Settings: expose pi 0.86's `cacheWarming` mode (`off`/`streaming`/`idle`) in
  the settings dashboard.
- Fix Ctrl+Left/Right in the TUI: on Windows/Linux the chord is no longer
  remapped to line start/end, so xterm sends pi's native word-navigation
  sequences. Cmd+Left/Right (macOS) and Ctrl/Cmd+Up/Down keep moving to the
  start/end of the input line.
- **Fix bash on Windows** ([#5](https://github.com/lutrarutra/codepi/issues/5)):
  the hidden terminal no longer hardcodes `/bin/bash`. The shell is now resolved
  per command — pi's `shellPath` setting (Settings → Behavior → Shell path), then
  the VS Code default shell (`terminal.integrated.defaultProfile.*`, i.e. the
  Git Bash profile you configured), then the well-known Git for Windows install
  locations and `bash.exe` on `PATH`. The WSL launcher is deliberately never
  used, and the tool now fails with an actionable message instead of spawning
  the wrong shell. Temp-file redirect paths are quoted and slash-converted, so
  a profile path containing spaces no longer breaks output capture.

## 0.4.1

- **Fix broken 0.4.0 release**: the GitHub Actions publish workflow passed
  `vsce package --no-dependencies`, so the published vsix shipped without
  `node_modules`. The extension died at activation (`Cannot find module
  '@earendil-works/pi-coding-agent'`) and every command failed with
  "command 'codepi.openPanel' not found". Packaging now bundles production
  dependencies again, and CI verifies the vsix contains them before
  publishing.

## 0.2.1

- Add GitHub Actions publishing workflow (tag-triggered, automated vsix build + publish)
- CI: run on Node 22 (jsdom 30 and undici 8 require Node >= 22.19; Node 20 crashes
  undici's CacheStorage with `webidl.util.markAsUncloneable is not a function`)
- Require VS Code >= 1.105 (first stable release whose extension host ships
  Node >= 22.19, required by undici 8)
- Slim the vsix: exclude dev-only files (docs, patches, build configs, CI files)

## 0.2.0

- Update to pi 0.84.0
- Packaging: vsix version syncs to the latest git tag (`make vsix`)

## 0.1.0

- Initial release
