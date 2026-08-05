# Plan: `codepi-task` bundled extension — reusable per-project tasks

> **Status: implemented** (2026-08-05) — `resources/extensions/codepi-task.ts`,
> `resources/extensions/__tests__/codepi-task.test.ts`, and the host plumbing
> listed below are all in place; `make verify` passes (types + 423 tests +
> smoke). One deviation from this plan: `when` enum schemas use
> `Type.Union` of literals instead of `StringEnum` (the bundled pi-ai root does
> not export `StringEnum`; the SDK's own bash tool uses `Type.Union`).

## Goal

Add a bundled pi extension to CodePi that persists reusable shell "tasks"
(build, test, lint, package, …) per project in `.pi/tasks.json`, and exposes:

- **5 agent tools**: `codepi-task-create`, `codepi-task-edit`, `codepi-task-delete`,
  `codepi-task-run`, `codepi-task-list`
- **5 slash commands**: `/codepi-task-create`, `/codepi-task-edit`,
  `/codepi-task-delete`, `/codepi-task-run`, `/codepi-task-list`
- **"when" awareness**: tasks are tagged `before-implement` / `after-implement` /
  `anytime`; the agent is reminded to run them via (a) a system-prompt section
  and (b) an automatic quiet nudge after turns that modified files.
- **Read-only tasks**: tasks may declare `readOnly: true` and are then
  runnable in Ask (read-only) mode.
- **User permission**: the agent must ask the user (via the `ask_user_question`
  tool) before creating, editing, or deleting a task.

`codepi-task-run` executes through the same hidden VS Code terminal backend as
`codepi-bash`, but — because tasks are predefined and stored in the user's
project — it does **not** show per-run approval dialogs. It only rejects when
the bash tool is in `disabled` mode, and enforces the read-only gate for
non-read-only tasks in Ask mode.

## Design decisions (confirmed with user)

| Decision | Choice |
|---|---|
| Task file schema | Object map keyed by unique name |
| Reminders | System-prompt injection + auto-nudge after edit-turns (gated by `codepi.tasks.*` settings) |
| Approval for task-run | Predefined tasks are trusted: no per-run dialog. `disabled` bash mode → tasks blocked with warning. `readOnly` tasks runnable in Ask mode; others blocked there. |
| Batch running | Single-task run only — **no** `run-all` tool |
| Create/edit/delete permission | Agent asks via `ask_user_question`; tools accept a `confirmed` param and refuse to write without it |
| Ask-mode allowlist | `codepi-task-run` + `codepi-task-list` added to the read-only baseline (run enforces `readOnly` itself) |

## Task file format (`.pi/tasks.json`)

Lives at the project root: `join(ctx.cwd, CONFIG_DIR_NAME, "tasks.json")`
(`CONFIG_DIR_NAME` from the SDK, so rebranded distributions resolve it
correctly). File is created on first `codepi-task-create`.

```json
{
  "tasks": {
    "build": {
      "command": "npm run build",
      "cwd": ".",
      "when": "after-implement",
      "timeout": 300,
      "readOnly": false,
      "description": "Compile the extension"
    },
    "test": {
      "command": ["npm run unit", "npm run smoke"],
      "cwd": ".",
      "when": "after-implement",
      "readOnly": true
    }
  }
}
```

Task fields:

| Field | Type | Rules |
|---|---|---|
| `name` | key | Unique by construction. Validated: `^[A-Za-z0-9][A-Za-z0-9._-]*$`, max 64 chars. No spaces (must be easy to type as `/codepi-task-run build`). |
| `command` | `string \| string[]` | Array joined with `" && "` (reuse `joinCommands` from codepi-bash: max 32 entries, no empties). Required. |
| `cwd` | `string` | Optional. Resolved relative to the project root (the session cwd that holds `.pi/tasks.json`). Default `"."` (the project root). |
| `when` | `"before-implement" \| "after-implement" \| "anytime"` | Optional, default `"anytime"`. |
| `timeout` | `number` | Optional, positive seconds. Default `DEFAULT_TASK_TIMEOUT_SECONDS = 600` (builds run long; bash's 120s is too short for the typical use case). |
| `readOnly` | `boolean` | Optional, default `false`. The user declares "this task does not modify project files" (e.g. `test`, `lint`, `typecheck`). Only such tasks may run in Ask (read-only) mode. |
| `description` | `string` | Optional, human-readable; shown in list output, prompt injection, and the permission question. |

Reading/writing is defensive: malformed JSON throws a clear error (reported to
the LLM); unknown keys and unknown task fields are **preserved** on edit (merge,
never clobber). All file mutations go through the SDK's
`withFileMutationQueue(absoluteTasksPath, …)` so parallel tool calls in one
assistant turn cannot lose updates (same guarantee as `edit`/`write`).

## Tools

All five tools share the task-store core; execute-time reads make agent/user
edits effective immediately without `/reload`. All tool descriptions carry the
guidance: *prefer these over raw `bash` for build/test/lint/package steps that
are defined in `.pi/tasks.json`* (names come from `codepi-task-list`).

Tool names keep the requested `codepi-task-*` dash spelling (pi tool names are
free-form strings; note the repo's builtin/custom tools conventionally use
snake_case — a rename to `codepi_task_*` later is a mechanical change).

### 1. `codepi-task-create`
- Params: `name` (validated), `command` (string | string[]), optional `cwd`,
  `when` (`StringEnum` from `@earendil-works/pi-ai` for Google compat),
  `timeout`, `readOnly`, `description`, and `confirmed` (boolean, default
  `false`).
- **Permission gate**: without `confirmed: true` the tool validates the input,
  does **not** write, and returns instructions for the agent to ask the user
  via `ask_user_question` (see "Permission flow" below). With `confirmed: true`
  it writes (creating `.pi/tasks.json` when missing) and returns
  `Created task 'build' (after-implement): npm run build`.
- Errors if the name already exists ("task already exists — use
  codepi-task-edit").

### 2. `codepi-task-edit`
- Params: `name` (required), optional `newName` (rename), `command`, `cwd`,
  `when`, `timeout`, `readOnly`, `description` (pass `""` to clear), and
  `confirmed` (default `false`).
- **Permission gate**: same two-phase flow as create; the question text states
  exactly what will change. With `confirmed: true` it merges only provided
  fields, preserves everything else (and unknown task fields).

### 3. `codepi-task-delete`
- Params: `name`, `confirmed` (default `false`).
- **Permission gate**: same two-phase flow (deleting is destructive — the
  question text states the task will be removed). No separate confirmation
  dialog beyond the user's `ask_user_question` answer.

### 4. `codepi-task-list`
- Params: optional `when` filter, optional `name` for a single lookup.
- Read-only. Returns the file path plus one block per task:
  `build — after-implement — npm run build (cwd ., timeout 300s, readOnly, Compile the extension)`.
  Empty file → "No tasks defined in .pi/tasks.json".
- Available in Ask mode (see "Read-only tasks & Ask mode").

### 5. `codepi-task-run`
- Params: `name` (required), optional `cwd` override, optional `timeout` override.
- Lookup → join commands → resolve cwd (task `cwd` relative to the tasks dir;
  explicit override wins) → **gates** (below) → execute via the shared terminal
  backend with streaming `onUpdate` + truncation (identical output semantics to
  the bash tool: last 2000 lines / 50KB, spill to temp file, clean ANSI/echo/
  prompt artifacts via `cleanTerminalOutput`).
- Non-zero exit → throw with the output appended (bash-tool behavior).
- `executionMode: "sequential"` (long-running commands; same as bash).
- Custom `renderCall` (`$ npm run build`) and `renderResult` (preview lines,
  `Took 12.3s`, error state) — simplified versions of codepi-bash's renderers.

## Run gates for `codepi-task-run`

Two independent gates inside `execute`, in order:

1. **Bash-disabled gate** — replay session-branch entries with
   `customType === "codepi-bash:mode"` (reuse `readModeFromBranch` exported
   from codepi-bash.ts). If mode is `disabled`:
   `ctx.ui.notify("Tasks are disabled because the bash tool is disabled — re-enable with /codepi-bash-ask or /codepi-bash-allow.", "warning")`
   and throw. **No tasks can run while codepi-bash is disabled.**
   (`ask` / `auto` → proceed; predefined tasks are trusted, so **no** per-run
   approval dialog — this is the deliberate difference from raw `bash`.)

2. **Read-only-mode gate** — replay session-branch entries with
   `customType === "codepi-modes:mode"` (a small local `readAgentMode` helper,
   same replay pattern). If the agent is in **Ask (read-only)** mode and
   `task.readOnly !== true`:
   throw: "Task 'build' is not marked readOnly — it may only run in Implement
   mode (switch with /codepi-implement), or mark the task readOnly: true in
   .pi/tasks.json if it is safe to run read-only."
   Read-only tasks run normally in Ask mode. (Plan mode has no tool backstop,
   matching the existing behavior where bash works in plan mode — the
   read-only gate applies to Ask mode only, consistent with codepi-modes.)

If codepi-bash is disabled in Settings, the host registers pi's **stock** bash
and no `codepi-bash:mode` entries exist → `readModeFromBranch` returns `ask` →
tasks run without a dialog. Acceptable default.

## Read-only tasks & Ask mode

For `codepi-task-run` to reach the read-only gate, the codepi-modes backstop
must not block it first. Both tools that are safe in Ask mode join the
read-only baseline allowlist:

- **`codepi-modes.ts`** — `READ_ONLY_TOOL_BASELINE` +=
  `"codepi-task-run"`, `"codepi-task-list"` (with a comment: run itself
  enforces `readOnly`).
- **`src/pi-store.ts`** — `ASK_MODE_DEFAULT_ALLOWED_TOOLS` += the same two
  (MUST stay in sync, per the existing comment), plus a new
  `ASK_MODE_DEFAULT_ALLOWED_TOOLS_PRE_TASKS` historical variant (the current
  default *without* the task tools) appended to the `HISTORICAL_DEFAULTS`
  migration list in `seedAskModeAllowedToolsIfMissing`, so already-seeded
  settings.json files gain the task tools without touching user-customized
  lists.

Consequences:
- `codepi-task-create` / `edit` / `delete` stay **blocked** in Ask mode (they
  mutate `.pi/tasks.json`; not in the allowlist → backstop blocks them).
- `codepi-task-run` is callable in Ask mode but only executes `readOnly` tasks
  (gate above). `codepi-task-list` runs freely.
- Update tests asserting the baseline: `codepi-modes.test.ts` (baseline
  composition) and `src/__tests__/extension-snapshot.test.ts` (askPolicy).

## Permission flow for create/edit/delete (`ask_user_question`)

Contract: the agent must obtain the user's explicit permission before mutating
`.pi/tasks.json`. The tools enforce it with a `confirmed` parameter; the
question itself is asked by the **agent** using the `ask_user_question` tool
(the user's requirement — the question appears in the conversation and the
user answers with structured options).

Flow for `codepi-task-create` (same shape for edit/delete):

1. Agent calls `codepi-task-create` with the task definition (no
   `confirmed`).
2. The tool validates the inputs (name, command, when, timeout…). If invalid →
   throw (never ask for a definition that would fail). If the target task
   exists (create) / is missing (edit/delete) → throw.
3. Otherwise the tool returns (NOT an error, so the agent continues) content
   that instructs the agent to ask the user with `ask_user_question`, including
   a ready-made question:
   - Question text: `Create project task "build" in .pi/tasks.json?`
   - Body: what the task does — command, cwd, when, readOnly, description —
     and the explicit pointer: *"See .pi/tasks.json for the full definition."*
   - Options: `Yes, create it` / `No, cancel` (edit: `Yes, apply changes` /
     `No, keep as-is`; delete: `Yes, delete it` / `No, keep it`).
4. If the user approves, the agent retries the same call with `confirmed: true`
   → the tool writes (within `withFileMutationQueue`) and returns success.
   If the user declines, the agent does not retry and reports the decision.

Tool descriptions state this contract up front, e.g.: *"Before creating a
task, always ask the user for permission with ask_user_question, describe what
the task does, and refer them to .pi/tasks.json. Call this tool with
confirmed: true only after the user approved."*

Notes:
- `ask_user_question` is a pi agent-runtime tool (CodePi's session-activity
  already special-cases it as a blocking/input tool); the extension never
  imports or calls it directly — it is purely an agent contract enforced by the
  `confirmed` gate.
- **Commands** (`/codepi-task-create` etc.) are user-initiated — the user is
  already present at the terminal, so no `ask_user_question` round trip. The
  interactive wizards perform the mutation directly.

## Reminder system ("when" awareness)

### A. System-prompt injection (`before_agent_start`)

If `codepi.tasks.injectPrompt` (default `true`) and the tasks file exists and is
non-empty, append a section built from a **fresh file read** each turn:

```
## Project tasks (.pi/tasks.json)
Reusable commands the user expects instead of ad-hoc bash for build/test/lint/package:
- build (after-implement): npm run build
- test (after-implement, readOnly): npm run unit

Rules:
- Run when=before-implement tasks BEFORE making changes (e.g. establish a test baseline).
- Run when=after-implement tasks AFTER finishing implementation to verify (build, test, lint).
- Prefer codepi-task-run over raw bash for these commands. Run codepi-task-list to see them all.
- Tasks marked readOnly may run in Ask (read-only) mode; others require Implement mode.
- Ask the user via ask_user_question before creating/editing/deleting a task.
```

### B. Auto-nudge after edit-turns (`tool_result` + `agent_end`)

Per-prompt state (reset on `agent_start`):

- `mutated` — set when a `tool_result` event has `toolName` in `{edit, write}`.
- `ranTask` — set when `toolName === "codepi-task-run"`.

On `agent_end`, if `mutated && !ranTask && after-implement tasks exist &&
codepi.tasks.remindAfterImplement` (default `true`), send a quiet follow-up via:

```ts
pi.sendMessage({
  customType: "codepi-task:nudge",
  content: "You modified files. The project defines after-implement tasks in .pi/tasks.json — verify your changes by running them with codepi-task-run: build, test. Skip only if the user asked you not to.",
  display: false,
}, { deliverAs: "followUp", triggerTurn: true });
```

This mirrors the auto-verify `followUp` behavior: the agent keeps working to run
the tasks. Naturally rate-limited (once per user prompt, only when edits
happened and tasks weren't already run). The decision logic is a pure function
(`shouldNudge`) so it is unit-testable.

### Settings read by the extension

Read defensively from `join(getAgentDir(), "settings.json")` at call time
(same pattern as `readAskAllowedTools` in codepi-modes):

- `codepi.tasks.injectPrompt` — boolean, default `true`
- `codepi.tasks.remindAfterImplement` — boolean, default `true`

No host-side seeding or Settings-dashboard rows needed (defaults live in the
extension); a dashboard toggle is a possible follow-up, not part of this plan.

## Commands

All handlers use `ctx.ui.*` guarded by `ctx.hasUI`. Names resolve relative to
`ctx.cwd` at execution time. User-initiated → **no** `ask_user_question` gate.

| Command | Behavior |
|---|---|
| `/codepi-task-list` | `ctx.ui.notify` with the formatted list (truncate ~30 lines; mention the file path for the rest). |
| `/codepi-task-create` | Interactive wizard: `ui.input` name → `ui.input` command → `ui.input` cwd (default `.`) → `ui.select` when → confirm readOnly (`ui.confirm`) → optional description. Then create + notify. |
| `/codepi-task-edit [name]` | `getArgumentCompletions` from existing names; prompts pre-filled with current values (`ui.input(name, defaultValue)`); optional rename prompt; notify result. |
| `/codepi-task-delete [name]` | Completions; `ui.confirm` before deleting; notify. |
| `/codepi-task-run [name]` | Completions; runs through the shared backend with a live `ctx.ui.setWidget("codepi-task", [...])` progress widget; final notify with exit status + truncated output (or full-output temp path when truncated). Timeout applies. |

## Execution backend sharing

`codepi-task.ts` will **import from its sibling `./codepi-bash.ts`** (same
directory) and reuse the exported, unit-tested pieces:
`createVscodeBashOperations`, `joinCommands`, `resolveCwd`,
`cleanTerminalOutput`, `BashOutputAccumulator`, `readModeFromBranch`.

- pi loads extensions through jiti, which resolves relative imports between
  sibling files (this is the documented multi-file extension pattern); importing
  the module only evaluates its side-effect-free top level — the codepi-bash
  factory is **not** invoked by the import.
- The smoke test (`smoke-load.mjs`, same jiti setup) loads `codepi-task.ts` and
  will fail loudly if the sibling import breaks — verifiable in step 1 of the
  implementation.
- **Fallback** (documented, only if jiti proves flaky): the host puts
  `createVscodeBashOperations` on the existing `globalThis.__codepiVscode`
  bridge in `src/extension.ts` activate (host imports it from
  `resources/extensions/codepi-bash.ts`; esbuild already bundles that file when
  imported), and `codepi-task.ts` reads it from the bridge — the pattern
  codepi-context uses. `codepi-bash.ts` itself stays untouched in either case.

## Registration plumbing (host changes)

The extension must become a toggleable bundled resource, mirroring
`codepi-bash`/`codepi-context` exactly:

1. **`src/pi-store.ts`**
   - `BUNDLED_RESOURCES`: add
     `{ id: "codepi-task", label: "Project tasks (.pi/tasks.json)", kind: "extension", enabledByDefault: true }`.
   - `BundledResourceConfig.bundledExtensions`: add `"codepi-task": boolean`.
   - `readBundledResourceConfig`: default `true` + read branch.
   - `getEnabledBundledResources`: extend the id union cast.
   - Ask-mode defaults + migration (see "Read-only tasks & Ask mode").
2. **`src/pi-runtime-config.ts`** — add `["codepi-task", "codepi-task.ts"]` to
   the bundled list in `buildPiRuntimeResourcePaths`; extend the filter's id
   union cast.
3. **`src/settings-view.ts`** — `isBundledResourceId`: add `"codepi-task"`.
4. **`src/shared/settings-protocol.ts`** — `BundledResourceRow.id` union: add
   `"codepi-task"`.
5. **`src/extension-snapshot.ts`** — update the "Bundled toggles" comment to
   list `codepi-task` (enabled computation is generic — no code change needed).
6. **`resources/extensions/codepi-modes.ts`** — Ask-mode baseline +=
   `codepi-task-run`, `codepi-task-list`.
7. **`src/__tests__/pi-resource-policy.test.ts`** — add the new entry to the
   expected `BUNDLED_RESOURCES` list (test fails otherwise).
8. **`resources/extensions/__tests__/smoke-load.mjs`** — load
   `codepi-task.ts` expecting the 5 tools, 5 commands, and events
   `before_agent_start` / `agent_start` / `tool_result` / `agent_end`.

The webview Extensions tab and Settings dashboard pick the new resource up
automatically (snapshot/dashboard are driven by `BUNDLED_RESOURCES` and the
loader).

## New files

### `resources/extensions/codepi-task.ts`

Structure (mirroring codepi-bash's layout):

- **Constants**: `TASK_WHEN` enum, `DEFAULT_TASK_TIMEOUT_SECONDS`,
  `TASK_NAME_RE`, `NUDGE_ENTRY_TYPE = "codepi-task:nudge"`,
  task-store type (`Record<string, TaskDef>`), tool descriptions +
  `promptGuidelines` ("Use codepi-task-run for build/test/lint/package steps
  defined in .pi/tasks.json instead of raw bash…").
- **Pure helpers (exported, unit-tested)**:
  - `tasksPathForCwd(cwd)` → `join(cwd, CONFIG_DIR_NAME, "tasks.json")`
  - `readTasksFile(path)` — defensive parse; throws clear errors on malformed
    JSON / wrong shape; returns `{ tasks }` map + preserves unknown top-level
    keys for rewrites.
  - `validateTaskName(name)` → error string | null
  - `normalizeWhen(value)` → one of TASK_WHEN or default `"anytime"`
  - `normalizeTimeout(value)` → number or default
  - `normalizeReadOnly(value)` → boolean
  - `buildTaskStore(...)` / `applyEdit(store, fields)` / `applyDelete(store, name)`
  - `formatTaskList(store, filter)` → display text
  - `buildTasksPromptSection(store)` → markdown section or `undefined`
  - `shouldNudge({ mutated, ranTask, hasAfterImplement, enabled })`
  - `readTaskReminderSettings(settings)` → `{ injectPrompt, remindAfterImplement }`
  - `readAgentMode(branch)` → `"ask" | "plan" | "implement"` (replay of
    `codepi-modes:mode` entries, used by the read-only gate)
  - `buildPermissionQuestion(action, taskSummary)` → suggested
    ask_user_question payload (question text, body, options)
- **Factory** (`export default function (pi)`):
  - `registerTool` × 5 (create/edit/delete/list/run).
  - `registerCommand` × 5 with `getArgumentCompletions` for edit/delete/run.
  - `pi.on("before_agent_start")` — prompt injection.
  - `pi.on("agent_start")` / `pi.on("tool_result")` / `pi.on("agent_end")` —
    nudge tracking + send.
  - `getVscode()` is not needed: the backend comes from codepi-bash.ts.

### `resources/extensions/__tests__/codepi-task.test.ts`

Vitest with the same hermetic-settings + mock-pi patterns as
`codepi-modes.test.ts`:

- Parsing: valid map, malformed JSON throws, wrong shape, unknown fields
  preserved across edit.
- Validation: name regex (spaces, dots, leading digit), command joining
  (`joinCommands` reuse), when/timeout/readOnly normalization.
- Store ops: create (exists → error), edit merge + rename, delete.
- cwd resolution relative to the tasks dir; run override precedence.
- List formatting + filters.
- **Permission gate**: unconfirmed create/edit/delete returns the ask
  instructions and does NOT write; `confirmed: true` writes; the generated
  question mentions what the task does and points to `.pi/tasks.json`.
- **Run gates**: bash-disabled → notify + throw; ask-mode + non-readOnly task
  → throw; ask-mode + readOnly task → runs; ask/auto bash mode → runs without
  dialog.
- Reminder settings defaults + defensive reads.
- Prompt section content (present/absent).
- `shouldNudge` truth table.
- Factory load: mock pi sees 5 tools, 5 commands, the event handlers.

## Implementation steps

1. **Backend-share spike (smallest risk first)**: temporarily import
   `./codepi-bash.ts` from a scratch file and run it through the smoke loader;
   if jiti resolves the sibling import, proceed with relative imports. If not,
   switch to the bridge fallback (host change in `src/extension.ts`).
2. **Write `resources/extensions/codepi-task.ts`** — pure helpers first
   (including permission-question + gates), then tools, commands, reminder
   hooks.
3. **Write `resources/extensions/__tests__/codepi-task.test.ts`** and make it
   pass (`npx vitest run resources/extensions/__tests__/codepi-task.test.ts`).
4. **Host plumbing** (steps under "Registration plumbing"): pi-store,
   pi-runtime-config, settings-view, settings-protocol, snapshot comment,
   codepi-modes baseline, pi-resource-policy test, smoke-load.mjs, and the
   updated baseline assertions in codepi-modes.test.ts / extension-snapshot
   tests.
5. **Verify**: `make verify` (check-types + unit + smoke). Manually F5 a
   session:
   - create a task via the tool → confirm it returns the ask instructions and
     does not write; approve via ask_user_question; retry with confirmed:true
     → file written.
   - run a readOnly task in Ask mode (allowed), a non-readOnly task in Ask
     mode (blocked with switch message), a task in bash-disabled mode
     (blocked with warning).
   - `/codepi-task-list`, edit/delete with confirmation.
   - prompt section appears; nudge fires after an edit-turn (or is suppressed
     when codepi-task-run already ran).
6. **Optional follow-up**: Settings-dashboard toggle for
   `codepi.tasks.remindAfterImplement` / `injectPrompt`.

## Risks / notes

- **`ask_user_question` dependency**: the permission flow assumes the
  `ask_user_question` tool exists in the agent runtime (it is a pi
  agent-runtime tool; CodePi's session-activity already special-cases it, and
  it is present in the user's sessions). The extension never imports it — it
  is an agent contract enforced by the `confirmed` gate. If a future runtime
  lacked it, the unconfirmed-result text should fall back to "ask the user via
  ask_user_question (or any other user-question mechanism)".
- **Trust model of `confirmed`**: the tool trusts `confirmed: true`; a
  misbehaving agent could skip the question. The alternative (the tool itself
  calling `ctx.ui.confirm`) is more airtight but does not surface in the
  conversation the way `ask_user_question` does — the user explicitly chose
  the ask_user_question flow.
- **Sibling import** is the only novel mechanism; smoke test + step 1 spike
  de-risk it. Fallback is documented.
- **Nudge noise**: gated by setting, only after edit-turns, skipped when
  `codepi-task-run` already ran; worst case the user turns it off in
  `codepi.tasks.remindAfterImplement`.
- **Ask-allowlist growth**: `codepi-task-run` joins the read-only baseline;
  the extension's own `readOnly` gate keeps it safe. Historical-default
  migration handles already-seeded settings.json files.
- **Dash tool names** diverge from the repo's snake_case convention
  (`web_search`, `fetch_content`, `get_editor_context`) — kept per explicit
  request; renaming later is mechanical.
- Task commands run with the same cwd/env semantics as codepi-bash (extension
  host env; `--noprofile --norc` minimal shell).
