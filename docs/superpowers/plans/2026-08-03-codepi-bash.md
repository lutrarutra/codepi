# CodePi Bash Tool — Implementation Plan

## Overview

A bundled PI extension (`codepi-bash`) that **overrides pi's built-in `bash` tool**
(extension-registered tools win over builtins in `_refreshToolRegistry` via
`Map.set` ordering — verified in `agent-session.ts`). Commands are **submitted
through the VS Code terminal API** (`window.createTerminal` + shell integration
`executeCommand`) instead of node's `child_process`. It adds a **per-session
approval mode** — `ask` (default) or `auto` — with a 4-choice TUI dialog for the
agent's commands, toggleable via `/codepi-bash-ask` and `/codepi-bash-auto`, and
a footer badge (`bash: [ask]/auto`) on the right side of the custom footer, left
of the git branch.

The tool definition is a port of pi's built-in bash tool
(`packages/coding-agent/src/core/tools/bash.ts`): same schema semantics
(command + timeout), same truncation behavior (last ~2000 lines / ~50 KB, full
output to a temp file), same `renderCall`/`renderResult` TUI presentation —
with the execution backend replaced by the VS Code terminal runner. The port
reuses pi's public exports (`truncateTail`, `DEFAULT_MAX_LINES`,
`DEFAULT_MAX_BYTES`, `formatSize`, `truncateToVisualLines`, `keyHint`, `Theme`,
`BashOperations`) rather than reimplementing them.

The extension lives at `resources/extensions/codepi-bash.ts` and is loaded like
the existing `custom-footer.ts`, `filechanges.ts`, and `codepi-modes.ts` bundled
extensions. It composes with codepi-modes: in Ask (read-only) mode the
`tool_call` backstop already blocks `bash` unless allowlisted, so the approval
mode only gates commands the mode system lets through.

**Enable/disable with builtin-bash fallback:** `codepi-bash` is a CodePi bundled
resource (Settings sidebar toggle, default **enabled**). When enabled, the
extension's `bash` overrides pi's builtin (extension-registered tools win over
builtins in `_refreshToolRegistry` via `Map.set` ordering). When the user
disables it, the extension is not loaded and **pi's own builtin bash tool is
registered instead** (host-side `pi.createBashToolDefinition(cwd)` added to
`customTools` in `extension.ts`), so the agent still has a working bash — pi's
stock spawn-based one, without the approval layer. `noTools: "builtin"` stays
in both paths, so no other builtin tools leak in.

**Locked decisions:**
- Per-command hidden transient terminal (fresh terminal per tool call, disposed on completion).
- Bump `engines.vscode` to `^1.93.0` (shell integration is a hard requirement; feature-detect with a clear error regardless).
- New sessions default to `ask`, hardcoded.
- Approval dialog = `ctx.ui.select()` with 4 options, **first option (YES) pre-selected → Enter approves by default**.

---

## Architecture

### Tool registration & override semantics

Registered via `pi.registerTool()` in the bundled extension, **named `bash`** so
it shadows pi's built-in bash tool whenever builtin tools are enabled. (CodePi
normally creates sessions with `noTools: "builtin"`, so there is no builtin bash
to clash with — but the override is guaranteed by registry ordering either way.)
`ToolDefinition` gives us `execute(toolCallId, params, signal, onUpdate, ctx)`
with full `ExtensionContext` (`ctx.cwd`, `ctx.ui`, `ctx.sessionManager`).

### Parameter schema (TypeBox)

```
command: string | string[]        // array ⇒ joined with " && " (user's request)
cwd?:    string                   // absolute, or relative to ctx.cwd; default ctx.cwd
timeout?: number                  // seconds, default 120; 0/omitted → default
```

- `command` array capped at e.g. 32 entries; empty array / empty string ⇒ error.
- `cwd` validated with `fs.existsSync` (and directory check) before creating the
  terminal — error mirrors pi's bash: `Working directory does not exist: <cwd>`.
- The *displayed* command (dialog, renderer, result) shows the joined string.

### Tool description & last-resort guidance

The agent is told bash is a **last resort** — this goes in the tool definition
(`description`, plus `promptSnippet` and `promptGuidelines` which are appended
to the system prompt's Available-tools/Guidelines sections):

```
description:
  "Run a shell command via the VS Code terminal, in the given working
  directory. Returns stdout and stderr. Output is truncated to the last
  2000 lines or 50KB (full output saved to a temp file when truncated).
  Optionally provide a timeout in seconds (default 120).

  USE ONLY AS A LAST RESORT. Prefer the dedicated tools whenever they
  can do the job:
    - search files by name → find_files
    - search file contents → grep (never bash grep)
    - read files → read
    - edit/create files → edit / write (never bash sed/echo >)
    - diagnostics → get_diagnostics
  Use bash for what only a shell can do: build/test/install/run commands,
  git operations, process management, file/dir operations beyond the
  other tools' scope."

promptSnippet: "Run shell commands — only when dedicated tools cannot (last resort)"
promptGuidelines:
  - "Prefer dedicated tools over bash: grep for content search, find_files for
     names, read for file contents, edit/write for changes, get_diagnostics for
     problems. Use bash only for what a shell uniquely does (build, test, run,
     git, install, process management)."
```

### Approval dialog (ask mode)

`ctx.ui.select()` renders the TUI selector; the **first option is pre-selected
(index 0), Enter confirms it → YES by default**. Esc cancels (⇒ deny).

```
title: "Approve bash command?" + "\n" + truncated command (≤ ~100 chars)
       + "\ncwd: <cwd>"
options:
  1. "Yes, approve"                              ← default (Enter)
  2. "No, deny"
  3. "Revise…"          → ctx.ui.input(title, placeholder = command text)
  4. "Approve & auto-approve all"  → run + switch session mode to auto
```

Behavior per choice:
- **Yes, approve** → execute as-is.
- **No, deny** → `isError`: `Command execution denied by the user.` (Esc = same).
- **Revise…** → an input dialog prefilled (placeholder) with the current
  command; the user edits it (may also be a different command entirely). The
  revised command runs **without re-confirmation** — the user authored it in the
  dialog, which is itself the approval. If the input is cancelled (Esc) ⇒ deny.
  The result reports the revised command so the agent sees what actually ran.
- **Approve & auto-approve all** → execute as-is **and** `setMode("auto")`
  (persist entry, update footer status, notify) — the session now auto-approves.

### Execution pipeline (per command)

```
1. resolve cwd (validate)                    ── pure helper, unit-testable
2. approval gate (ask mode → 4-option select) ── see above
3. create terminal:
     vscode.window.createTerminal({
       name: `CodePi bash`, cwd, hideFromUser: true, isTransient: true,
     })
4. wait for shell integration (≤5s):
     window.onDidChangeTerminalShellIntegration filtered to our terminal,
     else timeout ⇒ dispose + isError "shell integration unavailable"
     (hint: enable terminal.integrated.shellIntegration / update VS Code ≥ 1.93)
5. const exec = shellIntegration.executeCommand(command)
6. exec.read() → stream → ANSI-strip + echo/prompt cleanup → OutputAccumulator
7. await exec.exitCode (rejects if shell integration failed → step-4-style error)
8. dispose terminal (also the kill mechanism — see Timeout & Abort)
9. return result: output text, isError ⇐ exitCode non-zero/undefined
```

**Port from pi's built-in bash tool** (`core/tools/bash.ts`):
- `OutputAccumulator` behavior (temp-file spill on truncation, `snapshot()`)
  reimplemented in-extension with `node:fs` (pi internals aren't exported);
  `filechanges.ts` already imports `node:fs/promises` from bundled extensions, so
  this is proven.
- `renderCall` → `$ command` (+ timeout suffix); `renderResult` → truncated
  preview with expand, truncation warning + temp-file path, "Took Ns" — adapted
  from the builtin renderer.
- Streaming partial output via `onUpdate` (throttled ~100 ms) so the user sees
  progress for long-running commands.

**Output cleanup (the messy part):** `read()` streams *raw terminal bytes* —
escape sequences, the echoed command line, trailing prompt. Cleanup steps:
1. Strip ANSI CSI/OSC escape sequences (small regex, no dependency).
2. Normalize `\r\n` → `\n`.
3. Drop the echoed command line (first line when it equals the joined command).
4. Trim trailing prompt artifacts (lines matching `^[\w@~/.\-:]+[%$#>]\s*$`).

**Timeout & abort — terminal disposal is the kill switch:** you cannot signal a
terminal execution; `dispose()` kills the shell and its process tree.
- Timeout: `setTimeout` → dispose → result "Command timed out after Ns".
- Abort: `signal.addEventListener("abort")` → dispose → "Command aborted".
- After dispose, `exec.exitCode` may reject or resolve `undefined` — treat both
  as cancelled/timeout outcomes, never a crash.

**Exit codes:** `0` ⇒ success; non-zero ⇒ `isError` with output + `Command exited
with code N`; `undefined` ⇒ `isError` "could not determine exit code" (shell
integration quirk, ^C, or sub-shell).

### Approval state machine

```
mode ∈ { ask (default), auto }

setMode(mode):
  ctx.ui.setStatus("codepi-bash", mode)   // footer badge source
  pi.appendEntry("codepi-bash:mode", { mode, timestamp })   // persistence
  ctx.ui.notify(`Bash approval: ${mode}`)

session_start: replay branch for "codepi-bash:mode" entries → currentMode
               (default "ask"), re-push status.
```

Mode changes come from the `/codepi-bash-ask` / `/codepi-bash-auto` commands and
from the dialog's "Approve & auto-approve all" option. `waitForIdle()` first
(codepi-modes pattern); no-op + notify when already in the mode.

### Footer badge

`custom-footer.ts`, right side, **immediately before the git branch**:

```
… • model • thinking ●  ask/allow •  branch     (ask active: bold amber ask, dim allow)
… • model • thinking ●  ask/allow •  branch     (auto active: bold green allow, dim ask)
```

- Read `footerData.getExtensionStatuses().get("codepi-bash")` → `"ask" | "auto"`.
- Format `nf-fa-terminal` icon (`\u{F120}`) + BOTH mode options as an
  `ask/allow` toggle — the ACTIVE option is highlighted (bold + `warning` amber
  for `ask`, bold + `success` green for `allow`) and the inactive one is
  dimmed. Showing both options keeps the badge visually distinct from the
  codepi-modes badge. Hidden entirely when the extension is not loaded/status
  absent (so disabling codepi-bash in Settings removes the badge).

### Bundling & enablement (with builtin-bash fallback)

- Add `codepi-bash` to `BUNDLED_RESOURCES` in `src/pi-store.ts` (id, name,
  kind "extension", default enabled `true`), widen `BundledResourceConfig`
  (defaults + `readBundledResourceConfig`), add `isBundledResourceId` in
  `src/settings-view.ts`, widen the `BundledResourceRow` id union in
  `src/shared/settings-protocol.ts` and `webview-ui/src/settings/types.ts`, and
  add `["codepi-bash", "codepi-bash.ts"]` to the `bundledExtensionPaths` list
  in `src/pi-runtime-config.ts`.
- The Settings sidebar toggle then controls loading: enabled → the extension
  registers the VS Code-terminal `bash` (approval modes, badge); disabled →
  `extension.ts` `createRuntime` appends pi's stock
  `createBashToolDefinition(opts.cwd)` to `customTools` (pi's default bash,
  spawn-based, no approval layer), read per-session so toggles apply to new
  sessions. Footer badge is absent when disabled (no extension status).

---

## Implementation Details (file-by-file)

| File | Change |
|---|---|
| `resources/extensions/codepi-bash.ts` | **New.** The extension: `bash` tool (ported from pi's builtin, VS Code terminal backend), 4-option approval dialog, mode state machine, commands. Export pure helpers for tests. |
| `resources/extensions/custom-footer.ts` | Add bash badge before `gitStr` in `rightParts`. |
| `src/pi-store.ts` | Add `codepi-bash` to `BUNDLED_RESOURCES`; widen the union type. |
| `src/pi-runtime-config.ts` | Add `["codepi-bash", "codepi-bash.ts"]` to the path list. |
| `src/shared/pi-settings-schema.ts` + `webview-ui/src/settings/types.ts` (+ `settings-view.ts` if needed) | Settings UI toggle for the new bundled resource. |
| `package.json` | `engines.vscode` → `^1.93.0`. |
| `docs/superpowers/plans/…` + README | This plan; README bundled-resources list. |

**Pure helpers (unit-testable, no VS Code):**
- `joinCommands(command: string \| string[])` → joined string, array cap, empty check.
- `resolveCwd(cwd: string \| undefined, sessionCwd: string)` → absolute path + exists check.
- `cleanTerminalOutput(raw: string, command: string)` → ANSI-strip + echo/prompt cleanup.
- `formatBashBadge(mode: "ask" \| "auto")` → `\u{F120} ask` / `\u{F120} allow`.
- `readModeFromBranch(branch)` → replay persisted mode.
- `truncateOutput` (cap lines/bytes, temp file, counts).
- `mapDialogChoice(choice)` → `"approve" \| "deny" \| "revise" \| "auto"` (from the 4 option labels).

**`import("vscode")` risk — RESOLVED via bridge:** jiti's ESM loader cannot
resolve the `"vscode"` module (the extension host only intercepts its own
require/import paths — verified in the dev host: the tool errored with "VS
Code API unavailable"). The fix: `extension.ts` `activate()` sets
`globalThis.__codepiBashHost = { vscode }` (the SDK + jiti extensions share
the extension host's globalThis), and `getVscode()` in codepi-bash reads the
bridge first, then tries `createRequire(import.meta.url)("vscode")` (node's
CJS `Module._load` IS intercepted for "vscode") as a second-chance fallback,
then plain `import("vscode")` last.

---

## Edge Cases & Open Questions

1. **Dialog default = YES** — `ExtensionSelectorComponent` starts at index 0 and
   Enter confirms; "Yes, approve" must stay the first option. Esc ⇒ deny.
2. **Revise** runs the edited command without re-confirmation (dialog = approval).
   Edge: user revises to something destructive — their call; document in tooltip.
3. **Interactive commands** (vim, less, `npm init`) hang in a hidden terminal —
   timeout saves us; document "no stdin support, pass non-interactive flags".
4. **`!` prefix (pi's user_bash)** still runs through pi's local executor, not
   this terminal — user-initiated, so **no approval gate**; document the
   difference (consistency: `!` output also differs in env).
5. **Env:** the hidden terminal is a fresh shell that sources the user's shell
   rc (PATH/aliases) — matches what the user would type. PI_* env vars
   (PI_SESSION_ID etc.) are NOT exported; acceptable for v1, note as future.
6. **Windows:** `&&` fails on Windows PowerShell 5.1 (ok on pwsh 7, cmd).
   Document; optionally use `vscode.env.shell` to pick a separator later.
7. **Parallel tool calls:** `executionMode: "sequential"` — one bash at a time,
   avoids interleaved output; per-command terminals make parallelism a later
   option.
8. **Terminal name collisions:** use a fixed distinctive name; `hideFromUser`
   keeps it out of the terminal dropdown; `isTransient` avoids reload restore.
9. **Output volume:** temp file for full output must be cleaned up (os.tmpdir,
   prefix `codepi-bash`), deletion on dispose best-effort.
10. **Exit-code `undefined`** should never be reported as success.

---

## Testing

- `resources/extensions/__tests__/codepi-bash.test.ts` (vitest, mirrors
  codepi-modes.test.ts conventions — hermetic `PI_CODING_AGENT_DIR`, mock pi):
  - mode replay from branch entries, default `ask`;
  - commands register `/codepi-bash-ask` / `/codepi-bash-auto` and update
    status/entry/notify; no-op on same mode;
  - **ask-mode dialog:** calls `ctx.ui.select` with 4 options in order;
    "Yes, approve" → run; "No, deny" / Esc → denied error; "Revise…" → input
    dialog, revised command runs without re-ask, Esc on input ⇒ deny;
    "Approve & auto-approve all" → runs AND switches mode to auto (entry +
    status + notify);
  - pure helpers: `joinCommands`, `resolveCwd`, `cleanTerminalOutput`,
    `truncateOutput`, `formatBashBadge`, `mapDialogChoice`;
  - execute pipeline with a mocked terminal runner (fake `createTerminal` /
    `executeCommand` / `read` / `exitCode`) covering: success, non-zero exit,
    undefined exit, timeout, abort, shell-integration-missing.
- `resources/extensions/__tests__/custom-footer.test.ts`: bash badge renders
  `bash: [ask]/auto`, hidden when status absent.
- `resources/extensions/__tests__/smoke-load.mjs`: add codepi-bash.ts to the
  load smoke test.
- `src/__tests__/pi-store.test.ts` / settings tests: new bundled-resource
  defaults.
- Manual (dev host): ask mode → `ls` → Enter approves (default YES), 2 denies,
  3 revises to `ls -la`, 4 switches footer to auto; verify output cleanliness
  (no `^[` escape garbage, no echoed prompt); long output truncation; `sleep
  200` with default timeout; non-zero exit; footer badge updates instantly.

---

## Rollout Steps

1. `resources/extensions/codepi-bash.ts` with pure helpers + tests (helpers first).
2. Terminal runner (mock-based tests) — verify `import("vscode")` resolves; bridge fallback if not.
3. Approval dialog (4 options) + mode state machine + commands + persistence.
4. Footer badge + custom-footer test.
5. Bundling + fallback: pi-store, pi-runtime-config, settings-view/protocol/webview types, `extension.ts` builtin-bash fallback, engines bump, `pi-resource-policy` test updates.
6. Manual verification pass (dev host), README + this plan.

