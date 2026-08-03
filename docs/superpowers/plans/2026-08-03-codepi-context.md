# CodePi Editor Context — Implementation Plan

## Overview

A bundled PI extension (`codepi-context`) that gives the agent a feel for **what
the user is up to** in the editor: which file is active, what is selected,
which editors are open, the git state of the repo (branch + changed files with
line counts), the SCM commit message being typed, open terminals, and the
active debug session — all read live through the VS Code API.

Two mechanisms (user-locked decision: **hybrid**):

1. **Session-start snapshot in the system prompt** — a compact
   `<editor_context>` block injected via pi's `appendSystemPromptOverride`
   resource-loader hook (codepi owns the loader options in `createRuntime`, so
   it can render the snapshot fresh per session). The agent knows the starting
   state from turn one, without any tool calls.
2. **Live on-demand tools** — `get_editor_context` (combined snapshot, always
   fresh) and `get_git_diff` (full unified diffs). The system-prompt snapshot
   is static for the session (pi rebuilds the prompt only at session
   start/reload/tool-change), so freshness comes from the tools; a `note:` line
   in the snapshot tells the agent to call `get_editor_context` for live state.

Selection text: **short selections (≤ ~800 chars) inline**; longer selections
show only the range, with `includeSelection: true` to force the full text.

**Out of scope** (per user): `get_problems` / diagnostics — the goal is
"activity context", not code-quality context. Problems can be re-added later as
a small line or tool if wanted.

The extension lives at `resources/extensions/codepi-context.ts`, loaded like the
existing bundled extensions, with its own Settings sidebar toggle
(`codepi.bundledExtensions["codepi-context"]`, default **enabled**). When
disabled: no tools registered, no snapshot injected, no behavior change.

---

## Architecture

### VS Code access — bridge reuse

The host's `activate()` already sets `globalThis.__codepiBashHost = { vscode }`
for codepi-bash. The context extension reads the same bridge via
`getVscode()`-style logic (bridge → `createRequire` → `import`). Since both
extensions now depend on the bridge, **rename the key to a generic
`__codepiVscode`** (update `extension.ts`, `codepi-bash.ts`, and its tests in
the same change) so the bridge is clearly shared infrastructure, not
bash-specific.

### Context sources (all VS Code API)

| Source | API | Notes |
|---|---|---|
| Active editor | `window.activeTextEditor` | path, languageId, cursor, line count, dirty |
| Selections | `editor.selections` (multi-cursor) | ranges + text (`document.getText(range)`) |
| Open tabs | `window.tabGroups` / `window.tabs` | file paths, active tab, dirty, non-editor tabs |
| Recent switches | `onDidChangeActiveTextEditor` cache | last N files the user jumped between |
| Git state | `getExtension("vscode.git").exports.getAPI(1)` → `api.getRepository(uri)` | repo root, `state.HEAD.name`, ahead/behind |
| Changed files | `repo.state.workingTreeChanges/indexChanges/untrackedChanges` | file list + status codes (free, no subprocess) |
| Per-file ±lines | `repo.diffWithHEADShortStats(path)` | subprocess per file → cache ~3s TTL, cap ~30 files |
| Full diff | `repo.diffWithHEAD(path)` | raw unified diff, only via `get_git_diff` |
| SCM commit box | `scm.inputBox.value` | only when non-empty |
| Workspace | `workspace.workspaceFolders`, `workspace.isTrusted` | folders, trust |
| Terminals | `window.terminals` | names + shell types |
| Debug | `debug.activeDebugSession` | name/type/state |

### Snapshot format (system prompt + `get_editor_context`)

```
<editor_context>
workspace: /Users/agynter/dev/codepi (trusted)
active: src/extension.ts [TypeScript] L132:7 — selection L132:7–L145:3 (14 lines)
selection: "const x = parse();"      ← only when ≤ 800 chars
open(4): src/extension.ts*, src/pi-store.ts, README.md, webview-ui/package.json
recent: src/pi-store.ts → src/extension.ts
git: main (ahead 2) — 3 changed: src/extension.ts +12/−3, src/pi-store.ts +1/−1, new src/context.ts
scm_input: "feat: editor context snapshot"   ← only when non-empty
terminals: 1 (zsh)  debug: none
note: snapshot from session start — call get_editor_context for live state
</editor_context>
```

Rules: paths relative to `ctx.cwd` where possible; open-editors list capped
(~30) with overflow ellipsis; git files capped (~30); never include the active
document body (the `read` tool exists for that); always end with the `note:`
line so stale snapshots self-correct.

### Tools

**`get_editor_context`** — returns the same shape as the snapshot, computed
live. Params (TypeBox): `{ includeSelection?: boolean, includeDiff?: boolean,
maxFiles?: number }`. Defaults: short selection inline; diff stats on (cached);
full diff off. `promptSnippet`: "Inspect the current VS Code editor state
(active file, selection, open editors, git changes)". `promptGuidelines`:
- "Before editing or explaining a file, call get_editor_context to see the active editor and selection."
- "When the user changes files mid-task, call get_editor_context again — your session-start snapshot is stale."

**`get_git_diff`** — `{ path?: string, maxLines?: number }` full unified diff(s)
for changed files (working tree vs HEAD; untracked files listed with line
counts). Capped output with truncation footer, same truncation conventions as
the bash port.

### Injection into the system prompt

Verified in `submodules/pi-main`:
- `appendEntry` is **not sent to the LLM** ("for state persistence") — not a context channel.
- `resources_discover` only contributes skill/prompt/theme paths — no prompt text.
- `DefaultResourceLoader` accepts `appendSystemPrompt?: string[]` and
  `appendSystemPromptOverride?: (base: string[]) => string[]`; both are
  evaluated **synchronously** during `loader.reload()` (session start).
- `_rebuildSystemPrompt` (`agent-session.ts`) re-renders the prompt at session
  start and when active tools change — so the snapshot is per-session static.

**Wiring:** in `extension.ts` `createRuntime`, before building the loader,
`await computeEditorContextSnapshot(vscode, opts.cwd)` (the context builder
lives in `codepi-context.ts`, exported and reused host-side), then pass
`appendSystemPromptOverride: (base) => [...base, snapshot]` into the
`DefaultResourceLoader` options. Only when the extension is enabled. The
override closure captures the pre-rendered string, keeping the synchronous
hook constraint satisfied.

### Live-state cache

The extension subscribes to VS Code events (`onDidChangeActiveTextEditor`,
`onDidChangeTextEditorSelection`, `tabGroups.onDidChangeTabs`,
`onDidSaveTextDocument`, `workspace.onDidChangeWorkspaceFolders`) to maintain
an in-memory view for the `recent:` list and to know when the snapshot is dirty.
Git per-file stats are cached per repo with a ~3s TTL (each shortstat is a
subprocess). Everything else is read live on each tool call (cheap property
reads), so `get_editor_context` is always fresh without staleness tracking.

---

## Files touched

- `resources/extensions/codepi-context.ts` — new: snapshot builder, tools,
  event cache, `getVscode` via shared bridge, exports for host reuse + tests.
- `resources/extensions/__tests__/codepi-context.test.ts` — new: unit tests
  (snapshot builder, git stats parser/cache, tool execution with mocked
  vscode + git API, truncation) + host-side snapshot rendering test.
- `resources/extensions/__tests__/codepi-bash.test.ts` — rename bridge key in
  tests (mocks set `__codepiVscode`).
- `resources/extensions/codepi-bash.ts` — read renamed bridge key.
- `src/extension.ts` — set `__codepiVscode` bridge in `activate()`; render +
  inject snapshot via `appendSystemPromptOverride` in `createRuntime` when
  enabled.
- `src/pi-store.ts` — `BUNDLED_RESOURCES` entry + `isContextExtensionEnabled`.
- `src/pi-runtime-config.ts` — extension path list entry.
- `src/shared/settings-protocol.ts` + `webview-ui/src/settings/types.ts` — id unions.
- `src/settings-view.ts` — bundled-resource id set (already generic).
- `README.md` — feature section.

## Verification

- `npm test` (unit + existing suites stay green), `npm run lint`,
  `npm run build:extension`, `node resources/extensions/__tests__/smoke-load.mjs`
  (extended to also load codepi-context).
- E2E via jiti + `globalThis.__codepiVscode` mock (same pattern as the bash
  e2e): snapshot renders, both tools execute against a mock vscode/git API,
  injection produces `<editor_context>` in the built system prompt.
- Manual checklist once the dev host works: snapshot visible on new session;
  `get_editor_context` returns live state after switching files; `get_git_diff`
  returns real unified diffs; disabling the toggle removes both tools and the
  snapshot; footer/settings toggle live-update.

## Open questions / risks

- **Snapshot staleness** — by design (per-session static); mitigated by the
  `note:` line + live tools. If it feels stale in practice, options: rebuild on
  active-tool change is already automatic; a `/codepi-context-refresh` command
  could bump the note — cheap future add.
- **Git shortstat cost** — N subprocesses for N files; mitigated by TTL cache
  + file cap. If repos are huge, cap drops the list to statuses only.
- **`scm.inputBox` privacy** — commit messages go to the LLM provider; it is
  the strongest "what is the user doing" signal, so keep it, but only when
  non-empty and only in the snapshot/tool, never auto-steered.
- **Git extension disabled in remote/CI** — `GitExtension.enabled` is false;
  the git section renders `git: unavailable` and the tool reports
  `available: false` instead of throwing.
