# CodePi: Native pi TUI inside the Editor Webview

**Date:** 2026-08-01
**Status:** Implemented 2026-08-01 (see `docs/superpowers/plans/2026-08-01-tui-in-webview.md`)
**Approved design** (pending implementation plan — superseded)

## Purpose

Replace the custom React chat GUI of the CodePi VSCode extension with **pi's native TUI** — the actual `InteractiveMode` full-screen terminal UI that the `pi` CLI uses — rendered inside the editor's custom-editor webview, exactly where the current chat GUI renders today. The sidebar sessions tree and the file-overlay review workflow for edit tool calls are kept.

## User Decisions (from brainstorming)

1. **Toolset:** keep today's VSCode-only tools (custom `read`, `write`, `edit` with review overlays, `list_dir`, `find_files`, `grep`, `ask_user`, `todo`) — no bash. The TUI renders the same constrained agent, just with pi's native UI.
2. **Session/tab model:** one TUI per custom-editor tab (the current tab model) — each open `codepi-chat://` tab hosts its own live TUI.
3. **Approach:** in-process `InteractiveMode` with an injected virtual terminal (Approach A), not a pty subprocess, not RPC.

## Verified Technical Facts

- pi's TUI = `InteractiveMode` (class exported by `@earendil-works/pi-coding-agent`, built on `@earendil-works/pi-tui`, full-screen alt-screen differential rendering: message list, input box, footer, `/commands`, keybindings).
- Installed SDK 0.80.1 exports `InteractiveMode`, `AgentSessionRuntime`, `createAgentSessionRuntime`, `createAgentSession` and all tool factories; `InteractiveMode(runtimeHost, options)` + `init()`/`run()`/`stop()`.
- pi-tui's `Terminal` interface is minimal and injectable-in-principle: `start(onInput, onResize)`, `stop()`, `drainInput()`, `write(data)`, `columns`/`rows`, `kittyProtocolActive`, `moveBy`, `hideCursor`/`showCursor`, `clearLine`/`clearFromCursor`/`clearScreen`, `setTitle`, `setProgress`.
- **The blocker:** the published SDK (0.80.1 and latest 0.83.0) hard-wires `this.ui = new TUI(new ProcessTerminal(), showHardwareCursor)` in the `InteractiveMode` constructor; `InteractiveModeOptions` has no `terminal` field. Upstream already threads `terminal?: Terminal` through their internal `createInteractiveTui` (in pi-main, unreleased) — the extension patch may become unnecessary later.
- The current extension already runs multiple in-process SDK sessions (one `createAgentSession` per panel), so multi-runtime is proven; the NEW multi-instance surface is multiple `InteractiveMode` TUI renderers. pi's TUI keeps one module-global: `setKeybindings()` in `@earendil-works/pi-tui` (last-constructed wins). Components inside `InteractiveMode` use per-instance keybindings, so impact is expected to be low — but this is a required validation item.
- Custom-editor wiring, session registry, sidebar tree, `ReviewManager`, settings view, `pi-store`/env redirect all exist and are unaffected structurally.

## Architecture

### Components

**Wiped (chat GUI):**
- `webview-ui/src/` chat React app: `App.tsx`, `components/*` chat components (`ChatView`, `InputArea`, `EditReviewBar`, `ThinkingLevelPicker`, `ModelSelector`, …), `hooks/useStreaming.ts`, chat CSS/types.
- Extension-side chat plumbing: `PiEventRelay` GUI paths, `modeInfo`/`toolsInfo` webview posts, `modelList` posts (`refreshPanelModels`), review message posting to the chat webview (review events now only drive editor decorations/CodeLens/status bar/notifications).

**Kept unchanged:**
- Sidebar sessions tree + preview/double-click behavior (`session-tree.ts`).
- Custom-editor provider (`CodePiChatProvider`/`CodePiChatDocument`, `codepi-chat://chat/<sessionId>` URIs, `sessionRegistry`).
- `ReviewManager`, editor decorations, CodeLens, review status bar, file-review prompt notifications, custom tools (`src/tools/*`, `src/review/*`).
- Settings sidebar GUI (`settings-view.ts`), storage (`pi-store.ts`, `PI_CODING_AGENT_DIR` redirect), `import-config.ts`.
- Tab icon (white pi logo ThemeIcon + `media/codepi-logo.woff`).

**New:**
- `src/tui/webview-terminal.ts` — `WebviewTerminal implements Terminal` bridging ANSI to the webview.
- `src/tui/tui-session.ts` — per-tab TUI lifecycle: build `AgentSessionRuntime` (same options as today: `DefaultResourceLoader`, `agentDir`, `noTools: "builtin"`, `customTools: createVscodeTools(review)`), construct `new InteractiveMode(runtime, { uiMode: "fullscreen", terminal })`, `run()`; teardown on close; rebind on reload.
- `webview-ui/src/terminal/` — xterm.js host app (repurposed chat `index.html` Vite entry): `xterm` + `@xterm/addon-fit`, message protocol.
- `patches/@earendil-works+pi-coding-agent+0.80.1.patch` — patch-package hunk threading `terminal` through `InteractiveModeOptions` (dist `.js` line ~246 + `.d.ts`), re-applied via postinstall; documented for removal when upstream ships it.

### Terminal bridge & protocol

| pi `Terminal` method | Webview behavior |
|---|---|
| `write(data)` | post `{command:"tui:write", data}` → `xterm.write(data)` |
| `start(onInput, onResize)` | register webview handlers; `onInput(data)` fed from xterm `onData` (escape sequences like a real terminal) |
| `stop()` / `drainInput()` | unregister; drain = resolve immediately (no tty) |
| `columns`/`rows` | from `{command:"tui:resize", cols, rows}` (xterm `fit`) |
| `kittyProtocolActive` | always `false` — no kitty negotiation; pi degrades to standard keys |
| `setTitle(title)` | post `{command:"tui:title", title}` → tab title = session name (icon stays the white logo) |
| `setProgress(active)` | post → busy indicator (status bar / icon) |
| `moveBy`/`hideCursor`/`showCursor`/`clearLine`/`clearFromCursor`/`clearScreen` | post to xterm (cursor/line/clear ops) |

Input path: xterm `onData` (already terminal-formatted key sequences) → `{command:"tui:input", data}` → extension `onInput(data)`.

### Session/tab lifecycle

- Custom-editor resolve: `sessionRegistry` lookup/create → `setupTuiPanel` (replaces `setupChatPanel`): create webview (xterm host), `ReviewManager` (unchanged), build runtime, `new InteractiveMode(...)`, `void mode.run().catch(...)`.
- Tab close (`dispose`): `mode.stop()`, runtime dispose, webview dispose.
- Extension-host reload: URIs persist; re-resolve opens the session from its file (existing pattern) → fresh TUI bound to it.
- Tab icon/title: re-asserted on every title change and view-state change (existing `setPanelTitle`/icon mechanism).

### Integration

- **File overlays:** custom write/edit tools + `ReviewManager` unchanged; accept/reject via editor decorations, CodeLens, notifications, review status bar. Chat `EditReviewBar` removed with the GUI.
- **Settings storage/GUI/import:** unchanged. Hot-apply: `settings.json` → new sessions; `auth.json` → request-time (both unchanged semantics). `models.json` → the TUI's native `/model` (ModelSelectorComponent) refreshes the catalog on demand; the GUI `modelList` post is removed. Validation item: what `onConfigSaved` should do for open TUIs (likely nothing beyond `registry.refresh()`, or a documented no-op).
- **Mode (ask/plan/agent):** keep `setWriteMode` default `agent`; the TUI's native affordances take over (validation item — pi's TUI mode behavior to be confirmed).
- **Images in transcript:** kitty protocol off → pi degrades to text/placeholder for images (accepted limitation).
- **Clipboard:** pi's `copyToClipboard` — validate; use xterm OSC 52 handling if trivial, else no-op.
- **External editor** (`$EDITOR` via `external-editor.ts`): unchanged (spawns editor process).

## Risks & Required Validations

| # | Risk | Validation / Mitigation |
|---|---|---|
| V1 | Multiple live `InteractiveMode` instances (module-global `setKeybindings`, ui.start double-calls, stdin untouched) | Explicit validation task with evidence (open 2+ tabs, both render/accept input correctly). Mitigation: re-assert focused tab bindings on view-state change; worst case serialize construction. |
| V2 | `InteractiveMode.run()` with non-tty injected terminal (no kitty negotiation, resize flows, `stop()` clean) | Validation task; patch minimality review. |
| V3 | Models/thinking/session switching semantics under TUI vs the extension's old model palette command | Confirm `/model` + TUI keybindings cover it; decide fate of `codepi.setModel` palette command. |
| V4 | Settings hot-apply for open TUIs (`onConfigSaved`) | Decide documented behavior (likely registry refresh only / no-op) |
| V5 | SDK patch maintenance across upgrades | patch-package pinned per version; postinstall reapply; doc note to drop when upstream ships terminal injection |

## Acceptance Criteria

1. Opening a session from the sidebar renders pi's native full-screen TUI inside the editor webview (message list, input box, footer, `/commands`, keybindings work).
2. Typing works (xterm → TUI), resize reflows the TUI, tab title = session name, white pi logo stays in the tab handle.
3. The agent runs today's VSCode-only tools; edit/write tools still create review proposals; editor decorations/CodeLens/notifications/status bar accept/reject still work (file overlays kept).
4. Sidebar sessions tree + preview/double-click behave as before; multiple TUI tabs coexist (V1).
5. Settings sidebar GUI + storage migration untouched and working (save/validate/import; auth key masking; models JSON).
6. Extension-host reload reopens TUI tabs bound to the same sessions.
7. Chat GUI code removed (no chat React app, no chat messages in the protocol); build/lint/tests green; manual F5 checklist passed by user.

## Out of Scope

- Bash tool / interactive terminal passthrough (user chose VSCode-only tools).
- Terminal images via kitty/sixel (accepted text fallback).
- Multi-session-in-one-tab native switching (user chose one TUI per tab).
- RPC/server-based remote TUI.
