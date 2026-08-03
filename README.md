# CodePi

A minimal VSCode extension starter with a **React + TypeScript** webview (frontend) and a **TypeScript** extension host (backend).

## Project structure

```
codepi/
├── src/                  # Backend: VSCode extension host (TypeScript)
│   └── extension.ts      #   entry point, registers commands + webview
├── webview-ui/           # Frontend: React app rendered in the webview
│   ├── src/
│   │   ├── main.tsx      #   React bootstrap
│   │   ├── App.tsx       #   main UI + messaging to/from backend
│   │   └── index.css     #   VSCode-theme-aware styling
│   ├── index.html
│   ├── vite.config.ts     #   fixed output names referenced by extension.ts
│   └── tsconfig.json
├── esbuild.mjs           # Backend bundler (esbuild)
├── tsconfig.json         # Backend tsconfig
└── package.json          # Extension manifest
```

## Setup

```bash
npm install          # root deps (backend)
npm --prefix webview-ui install   # webview deps (frontend)
```

## Build

```bash
npm run build      # build both webview + extension into dist/
```

Or watch during development:

```bash
npm run watch        # watches both webview and extension concurrently
```

## Run / Debug

Open the project in VSCode and press **F5**
(launch config `.vscode/launch.json` starts an Extension Development Host
after running the watch task). Then run the command **CodePi: Open Panel**
from the Command Palette (`Ctrl/Cmd+Shift+P`).

## Storage, packages, and settings

CodePi uses the Pi resource directory on the **current computer** as its
canonical shared resource root: `~/.pi/agent`. Pi package declarations,
models, authentication, and installed packages are read from that directory,
so the Pi CLI is optional; CodePi does not require a separate CLI binary.
Package declarations and configuration are still per computer, so when using
SSH hosts you must synchronize them separately on each host.

CodePi session files are intentionally separate from Pi resources. They are
stored below the VS Code extension global storage (`sessions/`) and are never
put in `~/.pi/agent/sessions`. With Remote-SSH, both the extension storage and
`~/.pi/agent` belong to the remote computer, so local and remote sessions and
resources do not cross machines.

The CodePi Settings view is a compact dashboard. It reports configured Pi
package status, lets you enable or disable CodePi's bundled `custom-footer`,
`filechanges`, `codepi-modes`, `codepi-bash`, and `nebula-pulse` defaults, and
opens the real `settings.json`,
`models.json`, and `auth.json` files in VS Code. The bundled resources are
CodePi-only and are not copied into `~/.pi/agent` or exposed to the Pi CLI.
Their preferences are stored under the `codepi` namespace in `settings.json`;
missing preferences mean enabled, while an explicit `false` disables a
resource. The default `nebula-pulse` theme is applied in memory and is not
written into shared Pi settings, so an explicit Pi theme always wins.

The Settings view also sets the terminal font for CodePi chat panels
(`codepi.fontFamily` / `codepi.fontSize`, also under the `codepi` namespace).
Changes apply to new sessions; the default is the bundled Fira Code Nerd
Font at 14 px.

CodePi ships a `get_diagnostics` tool that reads the VS Code Problems panel
(errors/warnings/info/hints from language servers and problem matchers),
grouped by file with line:column positions. A path-scoped check opens the
file invisibly to trigger analysis, then waits for the language server to
settle (a few seconds max) before reporting — so the answer right after an
edit is trustworthy, and re-checks of an unchanged file are instant. If the
server is still churning, never reported anything, or the open editor buffer
differs from the saved file, the result says so instead of silently claiming
the code is clean. After each turn that edits files, CodePi automatically
lints exactly the files the agent touched and feeds the findings back:
`codepi.autoVerify` is `nextTurn` (quiet context on your next prompt) by
default, `followUp` (agent keeps working to fix them), or `off`.

CodePi ships a bundled `codepi-bash` extension that provides the agent's
`bash` tool. Unlike Pi's stock bash (which spawns a process directly),
`codepi-bash` submits commands through the **VS Code terminal API** — a
hidden transient terminal with shell integration — so commands run with the
same shell environment you'd type into, and terminal disposal kills them on
timeout/abort. Commands can be a string or an array (joined with ` && `), with
an optional `cwd` (default: the session folder) and `timeout` (default 120 s).
The agent is instructed to use bash only as a **last resort** — search with
`grep`, names with `find_files`, reads with `read`, changes with `edit`/`write`,
problems with `get_diagnostics`.

Bash commands are gated by a per-session approval mode, shown in the footer as
a terminal icon plus an `ask/allow` toggle — the active option is highlighted
(bold + amber for `ask`, bold + green for `allow`) and the other is dimmed —
right of the thinking level, left of the git branch. New sessions default to
**ask**: before each command a dialog
lets you **Yes** (Enter, the default), **No**, **Revise** (edit the command and
run it), or **Approve & auto-approve all** (run it and switch this session to
auto). Toggle manually with `/codepi-bash-ask` and `/codepi-bash-auto`; the
mode is persisted per session. Disabling `codepi-bash` in Settings (default
enabled) falls back to Pi's stock bash tool (spawn-based, no approval) so the
agent still has a working bash. Requires VS Code ≥ 1.93 (shell integration).

CodePi ships a bundled `codepi-modes` extension with three agent modes you
switch with `/codepi-ask`, `/codepi-plan`, and `/codepi-implement` (implement
is the default; the active mode shows in the chat footer). Ask mode is
read-only: it blocks `edit`/`write`, shell commands (`bash`), and every
third-party extension tool, allowing only the read-only allowlist. The
default allowlist is seeded into `codepi.modes.ask.allowedTools` in
`settings.json` on first activation:

```json
{
  "codepi": {
    "modes": {
      "ask": {
        "allowedTools": [
          "read", "grep", "find", "ls",
          "list_dir", "find_files", "get_diagnostics", "ask_user_question",
          "web_search", "fetch_content"
        ]
      }
    }
  }
}
```

Edit it in the CodePi **Settings** view ("Ask mode tools" field) or directly in
`settings.json` — the list is re-read on every Ask-mode tool call, so changes
apply immediately. When the block is missing entirely, the extension falls
back to the same hardcoded defaults. Tools not on the list (e.g. `subagent`,
`todo`, or any new extension tool) stay blocked in Ask mode.

Plan mode keeps full tool access but instructs the agent to only produce
plans (document in `docs/plans/`, track with todos) and not implement them.

On first activation after an upgrade, CodePi can offer a non-destructive
migration of legacy CodePi configuration into the canonical Pi files and old
CodePi sessions into the new VS Code storage location. It never copies the
canonical Pi session directory and keeps the legacy source files in place.

## How frontend ↔ backend messaging works

**Frontend → Backend:** call `vscode.postMessage({ command, ... })`
(see `webview-ui/src/App.tsx`).

**Backend → Frontend:** call `panel.webview.postMessage({ command, ... })`
and listen with `panel.webview.onDidReceiveMessage(...)` in
`src/extension.ts`. The webview listens via `window.addEventListener("message", ...)`.

## Edit review (Copilot-style inline diffs)

When the agent calls the `write` or `edit` tool, the change is **applied and
saved immediately** (matching VS Code Copilot), then tracked for review:

- The file opens in the editor with **green** decorations on added lines and
  **red** decorations (plus a preview) where lines were removed.
- A **review bar at the top of the file** asks the whole-file question:
  `📝 N changes — Accept All · Reject All · Open Diff` (hover the bar for
  clickable buttons; the same actions appear as CodeLens at the top when
  `editor.codeLens` is enabled).
- **Each changed snippet** gets its own question: an `✓ Accept  ✕ Reject` pill
  at the end of the snippet's last line, with clickable Accept/Reject buttons
  on hover (and per-hunk CodeLens actions).
- A **bottom-right notification** asks you to `Accept` or `Decline` changes
  **file by file**, in order, and a **status-bar item** shows how many files /
  edits are pending (click it to jump to a pending file).
- The chat panel shows an **Edit Review bar** (per-file `Accept`/`Reject` and
  cross-file `Accept All` / `Reject All`) plus a per-edit **EditCard** in the
  tool result.
- `Open Diff` opens a side-by-side diff of the original vs. proposed content.
- If you edit the file yourself while a proposal is pending, the proposal is
  marked **stale** and nothing is overwritten.

Implementation lives in `src/review/` (`review-manager.ts` owns proposals and
hunk resolution, `diff.ts` computes line hunks, `decorations.ts` renders the
editor UI — review bar, snippet pills, hover actions, CodeLens — and
`edit-apply.ts` applies `oldText`/`newText` edits).
