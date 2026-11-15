# Changelog

All notable changes to CodePi are documented in this file.

## 0.9.0

- **Update to pi 1.5.2** (from 1.0.4). `@earendil-works/pi-coding-agent` is
  now pinned exactly, like `pi-tui`, so the patch always matches the installed
  version and pi's own packages (pinned exactly upstream since 1.3.0) can no
  longer mix versions.
  - The host-integration patch keeps its four files, and adds two for the
    fixes below (clipboard hook, startup hints). 1.5.2 still neither
    declares nor forwards `baseToolsOverride` in `createAgentSession`, and
    `createToolDefinitionFromAgentTool` still drops prompt metadata and
    renderers. The default-tool hunk moved to `defaultToolNames`: since 1.1.0
    `--tools +name/-name` modifiers apply on top of that default, so the
    override keys replace the default rather than the final active set.
  - pi-tui 1.1 requires `Terminal.setProgramStatus()` (OSC 7501
    working/blocked/done/failed status) and calls it unconditionally. The
    webview terminal records the latest status instead of forwarding it to
    xterm.js, which has no use for it.
  - pi 1.2 also fires `before_agent_start` for runs started by an
    extension's `sendMessage(..., { triggerTurn: true })`, such as the
    after-implement task nudge. The live editor context is now attached to
    user prompts only. The mode and task system-prompt sections still apply
    to every run.
  - Settings: the `cacheWarming` help text notes that `"idle"` is now pi's
    default.
  - Packaging: the allowlist adds `lovely-mermaid` (replaces `grok-mermaid`),
    `marked-cjk-friendly`, `@isaacs/nonrecursive-glob-match`, `minimatch` and
    `undici`, which pi 1.5 hoists to the root. `.env` files are kept out of
    the vsix.
  - pi 1.5.2 needs Node ≥ 22.19.0. VS Code 1.105, the oldest supported
    release, ships exactly 22.19.0.
  - Behaviour from upstream worth knowing: `/resume` of a session whose
    folder no longer exists now offers Continue / Fork / Cancel, and tool
    argument validation runs on pi-schema instead of TypeBox (CodePi's
    tools use only JSON-Schema features).
- **Scrolling**
  - Fix the scrollback filling with copies of the session: pi's full redraw
    (resize, changes above the viewport) clears the scrollback and rewrites
    the whole transcript, and stripping the clear appended a complete second
    copy each time. The clear now goes through, and a reader who had scrolled
    up is put back on the same lines afterwards.
  - Sending a message (Enter, Alt+Enter) scrolls to the bottom, so its answer
    is visible even when you had scrolled up to read.
  - A wheel scroll down that ends near the end (within a third of the
    viewport) snaps to the bottom and follows output again; before, xterm
    stopped following a few lines short while pi was streaming.
  - A "↓ Latest" button appears while scrolled up and lights up when new
    output arrives below.
- **Keys**
  - Ctrl+Z no longer kills the session: pi's suspend stopped the TUI and
    signalled the extension host's process group, then waited forever.
    Suspend, exit (Ctrl+D) and clear (Ctrl+C) are unbound for CodePi
    sessions; the webview already kept Ctrl+D and Ctrl+C (copy) from pi.
    The startup help no longer lists them: the patch makes pi's header
    skip hints for unbound keys instead of printing " to suspend".
  - Ctrl+- is pi's undo again instead of zooming VS Code out (a CodePi
    keybinding takes the chord while a session tab has focus).
  - Keystrokes typed right after switching to a CodePi tab are no longer
    lost: the terminal takes focus when its tab becomes active, and keys that
    still land on the page are forwarded to it.
- `/copy` and Ctrl+X copy through VS Code's clipboard, so they work without
  xclip/xsel on Linux and copy to the local machine from Remote-SSH and
  containers. pi's own fallback (OSC 52) went to the extension host's
  stdout, which VS Code does not let an extension redirect, so the patch
  gains a fifth file: `copyToClipboard` calls a host clipboard hook
  (`globalThis.__piHostClipboardWrite`) when one is registered.
- **Project trust:** a folder whose `.pi` settings declare packages or
  extensions now asks "Trust project folder?" with pi's five choices before
  anything loads, and saves the answer in `~/.pi/agent/trust.json` as pi
  does. Before, project packages were installed and run without asking. The
  Extensions view never loads an undecided project's extensions.
- **Packages:** the Extensions view can install (npm, git or a path), update
  and remove pi packages through pi's own package manager.
- The agent now gets the editor selection even when its file is hidden
  behind the CodePi tab in the same editor group (CodePi remembers the last
  file editor and its selection).
- The agent is told when bash is disabled or re-enabled
  (`/codepi-bash-*`), as it is for Ask/Plan/Implement.
- The tab title shows "●" while pi works, independent of pi's
  terminal-progress setting (off by default).
- Terminal font changes in Settings apply to open sessions right away.
- The Extensions view shows "Implement mode active" for sessions that never
  switched modes, instead of "mode unknown".
- The Command Palette offers Open Session, the Sessions / Settings /
  Extensions views, and — while edits are pending — Open Pending Review and
  Accept / Reject All Edits.

## 0.8.0

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
- Fix "CodePi TUI error: Webview is disposed" on startup (e.g. a debug session
  with a restored or duplicate session tab). VS Code throws that error from the
  `WebviewPanel` accessors (`title`, `iconPath`, `reveal`, `visible`) once the
  panel is gone, and CodePi reached them after teardown — pi's shutdown keeps
  writing to the terminal while the session closes. The panel is now torn down
  only after the TUI stops, the pty goes inert with it, and every async panel
  touch (title refresh, activity icon, delete-session) is guarded. A TUI that
  exits after its session is already gone is logged instead of reported, and a
  non-zero `process.exit()` from pi now says so instead of closing the tab
  silently.

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
