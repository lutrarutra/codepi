# CodePi - customizable coding agent agent inside customizable coding editor

VSCode extension that integrates [pi.dev](https://pi.dev) — the customizable coding
agent — into VS Code. CodePi embeds pi's agent runtime directly in the editor:
you get pi's models, sessions, skills, tools, and extension system, wrapped in
deep VS Code integration — editor context, inline edit review, the Problems
panel, terminal-backed bash, and a Settings dashboard.

## Features

### The agent, in your editor
- **Embedded pi runtime** — no separate CLI needed. CodePi bundles the pi SDK
  and reads your canonical pi resources (`~/.pi/agent`): models, auth,
  skills, prompt templates, packages, and custom extensions.
- **Full TUI chat panel** — streaming responses, thinking levels, tool calls,
  markdown with syntax-highlighted code blocks, and a built-in terminal pane.
- **Multi-provider models** — any model configured in `models.json`
  (OpenAI, Anthropic, OpenRouter, Gemini, local models, …); switch models
  right from the chat footer.
- **Sessions** — a persistent session list in the sidebar (new / rename /
  delete / reopen), per-session state, model and mode remembered across
  reloads. Sessions are stored under VS Code's extension global storage —
  separate from the pi CLI's session dir, so local and Remote-SSH sessions
  never cross machines.
- **Skills, prompts, and extensions** — pi's whole ecosystem is available:
  install packages from the Settings dashboard, load skills, and register
  your own tools/commands/events through pi's extension API.

### Deep VS Code context (`codepi-context`)
- **Session-start `<editor_context>` snapshot** injected into the system
  prompt: active file + cursor, every selection with its file and range,
  all open editors, recent file switches, git branch and changed files with
  `+N/−M` line counts, the SCM commit box, open terminals, and the active
  debug session.
- **Live per-turn updates** — a compact `<live_editor_context>` block is
  injected whenever your active file or selections change, so a fresh
  highlight is visible without a tool call.
- **On-demand tools** — `get_editor_context` (refresh the snapshot live,
  with `includeSelection` / `includeDiff` / `maxFiles`) and `get_git_diff`
  (full unified diffs vs HEAD for changed files).
- **Resilient collection** — open editors are read from the VS Code tab
  model, with a fallback to open text documents while the window is still
  restoring, so the snapshot is never spuriously empty.

### Edit review — Copilot-style inline diffs
- When the agent calls `write`/`edit`, the change is **applied and saved
  immediately**, then tracked for review:
  - Green/red **editor decorations** on added/removed lines.
  - A **review bar** at the top of each changed file
    (Accept All · Reject All · Open Diff), plus per-snippet
    **Accept / Reject pills** and CodeLens actions.
  - A notification queue asking you to accept or decline **file by file**,
    and a **status-bar counter** that jumps to the next pending file.
  - In the chat: an **Edit Review bar** and per-edit **EditCards**.
  - **Open Diff** opens a side-by-side view of original vs. proposed.
  - If you edit the file yourself while a proposal is pending, it is marked
    **stale** and never overwritten.

### File-change tracking (`filechanges`)
- CodePi remembers what the agent created/edited (baseline + diff per file).
- `/filechanges` — interactive modification log with per-file diff viewer.
- `/filechanges-accept` — keep current files, resolve all pending snippet
  reviews, and clear the log (`/filechanges-accept force` skips the
  confirmation).
- `/filechanges-decline` — revert files to their original contents and clear
  the log.
- The tracker stays in sync with the editor review proposals, so
  decorations and the review bar clear in step.

### Agent modes (`codepi-modes`)
- **Implement** (default) — full tool access.
- **Plan** — planning only: explore, ask clarifying questions, write the plan
  to `docs/plans/`, track with todos; never modifies source code.
- **Ask** — read-only: only an allowlisted set of tools runs (read, grep,
  find, diagnostics, web research, …); anything else is blocked with a clear
  reason. The allowlist is editable in Settings
  (`codepi.modes.ask.allowedTools`).
- Switch with `/codepi-ask`, `/codepi-plan`, `/codepi-implement`. Modes are
  user-only commands; from Plan mode, switching to Implement asks for your
  confirmation. The active mode shows as a badge in the chat footer and
  persists across session reloads.

### bash through the VS Code terminal (`codepi-bash`)
- Commands run in a hidden VS Code terminal with **shell integration** — the
  same shell environment you'd type into — and the terminal is disposed on
  timeout/abort.
- **Approval modes** per session: `ask` (default) or `allow`, toggled in the
  footer or with `/codepi-bash-ask` / `/codepi-bash-auto`. In `ask` mode
  every command gets a dialog: **Yes / No / Revise / Approve & auto-approve
  all**.
- Disable `codepi-bash` in Settings to fall back to pi's stock bash tool.

### Diagnostics & verification
- **`get_diagnostics`** reads the VS Code Problems panel (errors, warnings,
  info, hints from language servers and problem matchers), grouped by file.
  A path-scoped check opens the file invisibly and waits for the language
  server to settle — so the answer right after an edit is trustworthy.
- **Auto-verify** after every editing turn: `codepi.autoVerify` is
  `nextTurn` (quiet context on your next prompt) by default, `followUp`
  (the agent keeps working to fix problems), or `off`.

### Search
- **`grep`** — CodePi's replacement for pi's stock `grep`: search file
  contents with optional regex (`isRegExp`), case-sensitive matching
  (`isCaseSensitive`), include/exclude globs (`**/*.ts`), path scoping, and a
  result cap — backed by ripgrep (`@vscode/ripgrep-universal`, with a
  fallback to the system `rg`).
- **`find_files`** — CodePi's replacement for pi's stock `find`: locate files
  and directories by name/glob over VS Code's file index
  (`**/*.ts`, `src/**/*.css`), with sensible default excludes (node_modules,
  .git, dist, build, …).

### Settings dashboard
- A compact webview in the sidebar that reports pi package status, toggles
  CodePi's **bundled resources** (`custom-footer`, `filechanges`,
  `codepi-modes`, `codepi-bash`, `codepi-context`, and the `nebula-pulse`
  theme), and opens the real `settings.json`, `models.json`, and `auth.json`
  in VS Code.
- Terminal font control for chat panels (`codepi.fontFamily` /
  `codepi.fontSize`), an "Ask mode tools" field, and the bundled-theme
  toggle. Bundled preferences live under the `codepi` namespace in
  `settings.json`; a missing preference means enabled, an explicit `false`
  disables.

### Extensible to the core
- Everything CodePi ships is itself a **pi extension** — plain `.ts` files
  under `resources/extensions/` that register tools, commands, and event
  handlers through pi's extension API. Add your own alongside them.
- Custom **footer**, custom **theme** (the bundled `nebula-pulse` theme is
  applied in memory unless you've chosen one explicitly), skills, prompt
  templates — all composable.

## TODO Features
- Calm mode
    - collapse the coding agent's streaming thoughts and tool calls into a single line. Only show output when the coding agent is done.
- Better git integration
- Feedback for changes
    - Allow the user to provide feedback on the coding agent's suggestions and changes, snippet-by-snippet or file-by-file.

## Requirements
- VS Code 1.93 or newer.

## Dev Setup

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

### Build & package with Make

A `Makefile` wraps the common workflows:

```bash
make build           # full production build (webview + extension)
make watch           # watch mode (same as npm run watch)
make verify          # type-check + unit tests + smoke test
make vsix            # package codepi-<version>.vsix (runs the prepublish build)
make install         # install the built .vsix into VS Code
make clean           # remove build outputs and .vsix files
make help            # list all rules
```
