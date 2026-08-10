# Close protection for active CodePi sessions

**Status:** investigated & prototyped, then reverted (2026). Re-implement later per
this document.

**Goal:** prevent the user from *accidentally* closing a CodePi session tab (or the
VS Code window) while the agent is active — generating (tab icon: cyan/blue,
activity `working`) or blocked on user input (`waiting`, yellow — e.g.
`ask_user_question`, the bash approval dialog, or extension permission dialogs).
The desired UX: the same confirmation the user gets when closing a file with
unsaved changes.

**TL;DR:** a true *before-close* warning is **impossible for `createWebviewPanel`
panels** — VS Code has no API to intercept or delay their close, and it actively
blocks the one browser-level workaround. Two viable designs, both implemented
or fully scoped:

| Approach | Before-close? | Cost |
|---|---|---|
| **A. Restore-based modal** (prototyped, tested) | No — warns immediately *after* close, tab is recreated; agent never stops | None beyond ~1 frame of flicker. Honest dialog, explicit [Keep Session Open]. |
| **B. Convert TUI tab to a custom editor** (scoped, not implemented) | **Yes** — native dirty-save dialog, Cancel keeps the tab open | File-save dialog semantics ("Save"/"Don't Save" both close; only "Cancel" keeps), tab icon regression, refactor, engine bump. |

---

## 1. VS Code API research (what the platform allows)

### 1.1 The warning dialog itself

- `vscode.window.showWarningMessage(message, { modal: true }, ...items)` is the
  extension-equivalent of the native confirm: a modal, window-blocking dialog
  with custom buttons.
- `MessageItem.isCloseAffordance: true` maps Esc / the close gesture to that
  button (so Esc = "Close anyway", the destructive affordance).

### 1.2 Closing a webview panel tab (the ✕ on the tab handle)

- **There is no API to prevent a `WebviewPanel` from closing.** No
  `onWillClose` / `onBeforeClose` event exists.
- `panel.onDidDispose` fires only **after** the panel is destroyed, and it
  cannot be cancelled or delayed.
  - Issues: microsoft/vscode#66939 ("Need an event to signal the user is closing
    a webview window" — dup #66842, unaddressed), #242335 ("Prevent closing
    webview if the user didn't save the changes" — official answer: use a
    custom editor), #48509 (dispose event arrives asynchronously after close).
- **`beforeunload` inside the webview does not work and is deliberately
  blocked**: VS Code overwrites `beforeunload`/`onbeforeunload` in webviews so
  scripts cannot cancel unloads (microsoft/vscode#122758, fixing #122736).
- No proposed API ships for this (checked the installed app's `vscode.d.ts`
  and `vscode-dts/` — nothing).
- **The only pre-close interception point is keyboard**: an extension
  keybinding can shadow the built-in `cmd+w`/`ctrl+w`
  (`workbench.action.closeActiveEditor`) when its `when` clause matches
  (`codepi.webviewFocused`). Verified in `keybindingResolver.ts`:
  candidates are checked last-to-first — user keybindings > extension
  keybindings > defaults; `whenIsEntirelyIncluded` removes less-specific
  conflicts. This covers the keyboard gesture only, **not** the mouse ✕.
  (User deprioritized this route — the goal is the ✕ button.)

### 1.3 Closing the whole window

- **No extension API exists to intercept, delay, or cancel a window close.**
  - microsoft/vscode-discussions#2407 (official answer): *"The extension APIs
    do not provide hooks for intercepting or delaying the application shutdown
    process. I do not think there are plans right now."*
  - microsoft/vscode#249621 ("Allow Extension listen for window close before
    deactivate") — closed, won't fix.
  - Verified against the installed VS Code 1.124.2 `vscode.d.ts`: no
    `onWillCloseWindow` / `onDidCloseWindow` anywhere.

### 1.4 How VS Code's own "unsaved changes" prompt works (and why panels can't get it)

- Editor-backed views carry a **dirty flag** on their document model
  (`TextDocument.isDirty` for text editors; `onDidChangeDirty` for custom
  editors / notebooks).
- The workbench's close path consults `IEditorCloseHandler.showConfirm()`
  (`src/vs/workbench/common/editor/editorInput.ts`): *"If true, will call into
  the confirm method to ask for confirmation before closing the editor. By
  default a file specific dialog will open if the editor is dirty and not in
  the process of saving."* → the native
  *"Do you want to save the changes you made to \<file\>?"* dialog
  (Save / Don't Save / Cancel). **Cancel aborts the close — the tab never
  closes.**
- `createWebviewPanel` panels are **not editors**: no document, no dirty state,
  no close handler → they never participate in this flow. This is the entire
  reason the feature is hard.

### 1.5 The sanctioned route: custom editors

`vscode.window.registerCustomEditorProvider` gives a webview-based **editor**
that DOES participate in the dirty-close flow (notebooks are the canonical
proof; the Codex editor shows the same close dialog in practice —
genesis-ai-dev/codex-editor#1097).

Feasibility findings, verified against installed VS Code 1.124.2:

| Item | Verdict |
|---|---|
| Native before-close dialog when the custom document is dirty | ✅ Works. **Cancel keeps the tab open.** |
| Custom tab title (`webviewPanel.title`) | ✅ Works since the Oct 2025 release — PR microsoft/vscode#272375 (fixes #105299; follow-up cleanup #272787). ⚠️ Our engine `^1.105.0` predates it → bump to `^1.107.0` or accept filename titles on 1.105/1.106. |
| `retainContextWhenHidden`, `localResourceRoots` | ✅ Via `registerCustomEditorProvider(..., { webviewOptions })` — the xterm TUI survives tab switches. |
| Window-reload restore | ✅ Automatic (editor state re-resolves); the hand-rolled `registerWebviewPanelSerializer` could be dropped (replaced by `openCustomDocument`/`resolveCustomEditor` + trivial `backup()`). |
| **Tab icon (`panel.iconPath`)** | ❌ **Does not work on custom editors.** Tabs show the document icon. Open feature requests: #105028 ("Add ability to apply custom icon to Custom Editors"), #209668. Busy signal would be the native **dirty dot** + the " ●" title suffix. |
| Window-close protection (bonus) | ⚠️ Only when the user's `files.hotExit` is `"off"`. Default `"onExit"` silently hot-exits (backs up) dirty docs on window close without prompting. Tab close always prompts. |

**The custom-editor trap:** the dialog is file-save semantics. The message
names the session file ("Do you want to save the changes you made to
\<session file\>? Your changes will be lost if you don't save them.") and
**Save (the default button) and Don't Save both close the session; only Cancel
keeps it.** A user who reflexively presses Enter loses the session — arguably a
worse trap than the explicit modal of Approach A.

---

## 2. Approach A — Restore-based modal (implemented & tested, then reverted)

**Design principle:** since the close cannot be prevented, keep the session
alive when the tab is closed, ask, and recreate the tab if the user wants to
keep it. The agent **never stops running**; nothing is lost. This is the
pattern microsoft/vscode-mssql uses (PR #18184, "Adding a prompt to restore
closed webviews").

### 2.1 Behavior

1. User clicks ✕ while `activity ∈ {working, waiting}` → the tab closes
   (unavoidable, ~1 frame), **cleanup is skipped** — the agent keeps working.
2. Modal appears immediately:
   - *"CodePi is still working — closing this tab will interrupt the session."*
     (or *"is waiting for your input"*)
   - `[Keep Session Open]` (primary) / `[Close Anyway]` (`isCloseAffordance: true` → Esc = Close Anyway).
3. **Keep Session Open** → a new panel is created in the same editor group and
   the live session re-attaches: same runtime/TUI/pty, fresh webview, full
   screen repaint (the same path a panel dragged across windows already uses).
4. **Close Anyway** (or Esc) → normal `cleanupSession` (kills the runtime), as
   before the feature.
5. No dialog when idle, on `/quit` (TUI-initiated close), or when the session
   was already cleaned up.

### 2.2 Implementation (files touched)

**`src/tui/webview-pty.ts`**
- `private readonly webview` → `private webview`.
- New `setWebview(webview)`: re-points the pty at a new panel's webview;
  resets `ready = false` and clears `pendingWrite` so writes buffer until the
  new xterm reports `tuiReady` (the TUI repaints its full screen on the resize
  that ready triggers; output that reached the old disposed webview is not
  re-sent).

**`src/extension.ts`**
- `SessionState` gains `activity: SessionActivity` (import the type from
  `./session-activity`) and `progressActive: boolean`. The existing
  `createSessionActivityTracker` (which already distinguishes exactly
  `working`/`waiting` — it drives the tab icon) now also stores the state:
  `onActivity: (activity) => { state.activity = activity; setPanelIcon(...); }`.
- Title/icon callbacks are **late-bound through `state`** (`refreshTitle`
  reads `state.panel` / `state.progressActive`) so they survive a panel swap;
  the pty's constructor callbacks call `state.refreshTitle?.()` instead of
  capturing locals.
- Per-panel wiring extracted into **`wirePanelToSession(state)`**: webview
  html, `onDidReceiveMessage` handlers, `onDidChangeViewState`, `onDidDispose`,
  icon, title. Shared by fresh panels (`setupSessionPanel`), window-reload
  restores (serializer), and reattached panels.
- `panel.onDidDispose` logic:
  ```ts
  const agentActive = state.activity === "working" || state.activity === "waiting";
  if (agentActive && !state.pty.quitting && sessions.has(sessionId)) {
    void confirmSessionClose(state);
  } else {
    cleanupSession(sessionId);
  }
  ```
  (`pty.quitting` is set by `drainInput` on TUI shutdown paths — `/quit`
  already cleans up via the `process.exit` interception, so intentional closes
  never prompt.)
- `confirmSessionClose(state)`: modal (see 2.1); after it resolves,
  re-check `sessions.has(state.sessionId)` (the session may have been cleaned
  up while the dialog was open), then `reattachSessionPanel(state)` or
  `cleanupSession(...)`.
- `reattachSessionPanel(state)`: `createTuiPanel("CodePi")` (new helper —
  extracted from `startTuiSession`) → `state.panel = panel` →
  `state.pty.setWebview(panel.webview)` → `wirePanelToSession(state)`.
- Disposed-panel guards (the modal is up while the session is "detached"):
  `setPanelIcon` and `state.panel.title` writes wrapped in try/catch;
  `getModeInfoFromSessions` guards `state.panel.visible` with try/catch.

**`src/__tests__/webview-pty.test.ts`**
- New test: `setWebview` re-points the pty, buffers writes until the new
  webview reports ready, flushes in order afterwards.

### 2.3 Verification (as built)

- `npm run check-types` clean; `node esbuild.mjs --production` builds;
  `npm test` — 447 tests pass (13 in `webview-pty.test.ts`).
- Behavior notes:
  - While the modal is up the agent keeps running in the background (VS Code
    modals block the window; the extension host does not).
  - Multiple sessions → multiple modals (they queue).
  - Window close remains unprotected (platform limit — see 1.3).
  - `tui.run().then(() => state.panel.dispose())` uses `state.panel`, so a TUI
    exit closes whichever panel is current (fresh or reattached).

### 2.4 Manual test script

1. Reload the extension host window to pick up the new bundle.
2. Start a session; give the agent a task; wait for the cyan icon.
3. Click ✕ on the tab → modal appears → **Keep Session Open** → tab reappears
   in the same spot with the live transcript; the agent never stopped.
4. Repeat while the agent is waiting on a question (yellow icon).
5. Idle session: ✕ closes instantly, no dialog. `/quit`: no dialog.

---

## 3. Approach B — Custom editor conversion (scoped, not implemented)

If the before-close dialog is a hard requirement, this is the only route
(full feasibility in §1.5).

### 3.1 Design sketch

- `package.json`:
  - `contributes.customEditors`: `{ "viewType": "codepi-tui", "displayName": "CodePi Session", "selector": [{ "filenamePattern": "*session*.json" }], "priority": "option" }` (low visibility in "Open With" since sessions are opened via command, not from the Explorer).
  - Bump `engines.vscode` to `^1.107.0` (custom editor titles).
- `vscode.window.registerCustomEditorProvider(viewType, provider, { webviewOptions: { retainContextWhenHidden: true, localResourceRoots: [webview-ui/dist, media] } })`.
- Provider: `openCustomDocument(uri, ...)` → load the session file
  (pi `SessionManager.open`); `resolveCustomEditor(document, webviewPanel)` →
  the existing `setupSessionPanel`-style wiring (pty, TUI, review, activity
  tracker, close protection becomes unnecessary — the dirty dialog replaces
  it); `save()` → near-no-op (the agent owns the file); `backup()` → trivial
  token (file is already on disk).
- Open sessions via `vscode.commands.executeCommand("vscode.openWith", sessionUri, viewType)` instead of `createWebviewPanel`.
- Dirty lifecycle: emit `onDidChangeDirty` while `activity ∈ {working, waiting}`, clear when idle.
- Drop `registerWebviewPanelSerializer` (restore is automatic).
- New-session flow: session file may not exist yet when opened — handle
  gracefully in `openCustomDocument`.

### 3.2 Accept/reject checklist (for the later investigation)

- [ ] Is losing the colored tab icon acceptable? (busy = native dirty dot + " ●" in the title)
- [ ] Is the file-save dialog acceptable, knowing **Save (default) and Don't Save both close the session; only Cancel keeps it**?
- [ ] Bump `engines.vscode` to `^1.107.0`?
- [ ] Window-close protection only works with `files.hotExit: "off"` — OK?
- [ ] Refactor cost: session lifecycle moves from `createWebviewPanel` + serializer to provider + `openWith`.

---

## 4. Environment facts (recorded during investigation)

- Repo: `code-pi` extension (`package.json` — engine `"vscode": "^1.105.0"`,
  devDeps `@types/vscode ^1.85.0`, resolved to 1.125.0).
- Installed VS Code: **1.124.2** (includes the Oct-2025 custom-editor title
  fix).
- Relevant existing machinery:
  - `createSessionActivityTracker` (`src/session-activity.ts`) — emits
    `idle | working | waiting | error` from pi session events; `waiting`
    covers `ask_user_question`, the bash approval dialog ("ask" mode), and
    extension UI dialogs (`extension_ui_start/end`).
  - `pty.quitting` (`src/tui/webview-pty.ts`) — set by `drainInput()` on
    TUI shutdown paths; the `process.exit` interception
    (`src/extension.ts` ~line 334) uses it to target `/quit` closes.
  - `registerWebviewPanelSerializer("codepi-tui", ...)` — restores panels
    across window reloads (session id persisted via `vscode.setState` in the
    webview).
  - The late-`tuiReady` path already proves a reloaded webview can render a
    live TUI (used by panels dragged across windows) — the mechanism
    `reattachSessionPanel` relies on.
