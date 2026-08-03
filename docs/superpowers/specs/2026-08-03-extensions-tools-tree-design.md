# Extensions & Tools Sidebar Tab Design

## Status

Design approved in conversation; implementation is the next phase.

## Goal

Add a third tab ("Extensions") to the CodePi sidebar that scans what the user has installed for pi — bundled CodePi extensions, user extensions (`~/.pi/agent/extensions/`, project-local `.pi/extensions/`), and npm packages — and shows, in a tree view, which slash commands and tool calls come from which extension. The view also visualizes which tool calls are disabled in Ask (read-only) mode.

## Scope

### In scope

- New `codepi.extensions` webview tab in the existing `codepi-sessions` sidebar container, switched via the `codepi.sidebarTab` context key (same mechanism as Sessions/Settings).
- Probe scan: load all extensions through the pi SDK's `SettingsManager` + `DefaultResourceLoader` (the CLI's own startup path) **without starting a session**; snapshot the loaded `Extension` objects.
- Per-extension tree: commands (slash commands, with skill/prompt source tags) and tools (LLM tool calls, with Ask-mode status chips), plus metadata counts (events, flags, shortcuts, message renderers).
- "pi core" section: SDK builtin slash commands (`BUILTIN_SLASH_COMMANDS`) and tools (`allToolNames` / `createCodingToolDefinitions()` + CodePi's `createVscodeTools()`).
- Ask-mode visualization: per-tool chip (`✓ read-only safe` / `★ whitelisted` / `🔒 blocked in Ask mode`), mode header chip reflecting the live session when one is active, and a legend.
- Disabled-state display: bundled extensions toggled off in `codepi.bundledExtensions` settings shown grayed with a `disabled in settings` tag.
- Load-error reporting: extensions that failed to load listed in a collapsible section with per-file error text.
- Refresh button (re-probe with SDK `clearExtensionCache()`), search box, loading/error states in the webview.
- Unit tests for the snapshot builder + one probe integration test with a fixture extension.

### Out of scope

- Live push updates from running sessions (snapshot is point-in-time; refresh is explicit).
- Click-to-run/invoke commands or tools from the tree.
- Ask-mode filter toggle (explicitly declined; search box covers narrowing).
- Reaching into private SDK session internals (`_extensionRunner`) — the probe uses public loader APIs only.
- Webview-side SDK access; all data crosses the postMessage protocol as JSON.

## Background: what the SDK exposes

Verified against the bundled SDK (`@earendil-works/pi-coding-agent`):

- **Extension discovery** (`dist/core/extensions/loader.js`, `discoverAndLoadExtensions`): project-local `<cwd>/.pi/extensions/`, user-global `<agentDir>/extensions/` (files `*.ts`/`*.js`, subdirs with `index.ts`/`index.js`, or subdirs with `package.json` carrying a `pi` field), explicitly configured paths (CodePi bundled resources), and npm packages (resolved through `DefaultResourceLoader` — proven in an earlier probe run).
- **Loaded extension shape** (`Extension`): `commands: Map<string, RegisteredCommand>` (name, description, sourceInfo), `tools: Map<string, RegisteredTool>` (definition incl. name/label/description/parameters), `flags`, `shortcuts`, `handlers` (event handlers), `messageRenderers`.
- **`SourceInfo`**: `{ path, source, scope: "user"|"project"|"temporary", origin: "package"|"top-level", baseDir? }` — lets us classify each item's origin.
- **`SlashCommandInfo`**: `{ name, description, source: "extension"|"prompt"|"skill", sourceInfo }` — slash commands also come from skills and prompts, not only extensions.
- **Core enumerables**: `BUILTIN_SLASH_COMMANDS` (exported), `allToolNames` (exported set), `createCodingToolDefinitions(cwd, options)` (exported factory with labels/descriptions).
- **Probe feasibility proven**: an earlier standalone `.mjs` probe used `DefaultResourceLoader` + `SettingsManager` and loaded all installed extensions (bundled 0–4, agent dir 5–10, packages 11–25) with zero errors — extension factories run safely without a session.
- **Ask-mode policy** (codepi-modes extension): in Ask mode, any tool not in the allowlist is blocked in a `tool_call` backstop. Allowlist = `READ_ONLY_TOOL_BASELINE` (read/head/grep/find/ls/list_dir/find_files/get_diagnostics/ask_user_question/web_search/fetch_content/get_editor_context/get_git_diff) ∪ user's `codepi.modes.ask.allowedTools` from `settings.json`. `edit`/`write`/`bash`/third-party tools are blocked. The host already mirrors the baseline in `src/pi-store.ts` (`ASK_MODE_DEFAULT_ALLOWED_TOOLS`).

## Architecture

```
VS Code sidebar — codepi-sessions container
  Sessions │ Extensions │ Settings        (codepi.sidebarTab context key)

Host (src/)                              Webview (webview-ui/src/extensions/)
┌──────────────────────────────┐         ┌──────────────────────────────┐
│ extensions-view.ts           │◄───────►│ ExtensionsApp (React)        │
│  WebviewViewProvider         │ protocol│  mode header + legend        │
│  (mirrors settings-view.ts)  │  JSON   │  search box + refresh        │
│                              │         │  extension cards (commands,  │
│ extension-snapshot.ts        │         │   tools + ask chips)         │
│  probe: SettingsManager +    │         │  pi core card                │
│  DefaultResourceLoader       │         │  load-error section          │
│  → snapshot builder (pure)   │         └──────────────────────────────┘
└──────────────────────────────┘         built by vite → webview-ui/dist
shared/extensions-protocol.ts — ExtensionsMessage / ExtensionsReply
```

### New files

| File | Responsibility |
| --- | --- |
| `src/extension-snapshot.ts` | Probe + pure snapshot builder: load extensions via SDK loader, classify, compute chips, build JSON-safe snapshot. Caching + `clearExtensionCache` handling. |
| `src/extensions-view.ts` | `ExtensionsViewProvider` (`viewType = "codepi.extensions"`): webview registration, `getSnapshot`/`refresh` message handling, cached snapshot serving. |
| `src/shared/extensions-protocol.ts` | `ExtensionsMessage` / `ExtensionsReply` discriminated unions. |
| `webview-ui/src/extensions/` | React app: `main.tsx`, `App.tsx` (header/search/refresh), `SnapshotTree.tsx` (cards), `chips.tsx` (ask-mode chip + legend). |
| `webview-ui/extensions.html` | Vite entry (mirror `settings.html`); add to `vite.config.ts` inputs. |

### Modified files

| File | Change |
| --- | --- |
| `package.json` | New view `codepi.extensions` in `codepi-sessions` container, `"when": "codepi.sidebarTab == extensions"`; command `codepi.openExtensionsTab`. |
| `src/extension.ts` | Register `ExtensionsViewProvider` + `codepi.openExtensionsTab` command (same pattern as Settings, ~6 lines). |

## Data model

```ts
interface ExtensionsSnapshot {
  generatedAt: number;
  cwd: string;
  agentDir: string;
  mode: {
    active: boolean;                       // a pi session is running in a panel
    current?: "ask" | "plan" | "implement";
    sessionName?: string;
  };
  askPolicy: {
    baseline: string[];                    // READ_ONLY_TOOL_BASELINE (pi-store mirror)
    whitelisted: string[];                 // codepi.modes.ask.allowedTools from settings.json
  };
  extensions: ExtensionEntry[];
  core: { commands: CommandEntry[]; tools: ToolEntry[] };
  loadErrors: Array<{ path: string; error: string }>;
}

interface ExtensionEntry {
  displayName: string;                     // "codepi-bash" | "@juicesharp/rpiv-todo"
  path: string;                            // resolved path on disk
  source: "bundled" | "agent" | "project" | "package" | "other";
  enabled: boolean;                        // bundled: settings toggle; on-disk: true
  commands: CommandEntry[];
  tools: ToolEntry[];
  events: number; flags: number; shortcuts: number; messageRenderers: number;
}

interface CommandEntry {
  name: string;                            // without leading "/"
  description?: string;
  source: "extension" | "skill" | "prompt";  // SlashCommandInfo.source
}

interface ToolEntry {
  name: string;
  label: string;
  description: string;
  askMode: "safe" | "whitelisted" | "blocked";
}
```

### Classification rules (pure functions in `extension-snapshot.ts`)

- **source**: path prefix match against the CodePi bundled resources dir → `bundled`; under `<agentDir>/extensions` → `agent`; under `<cwd>/.pi/extensions` → `project`; under npm package roots or `SourceInfo.origin === "package"` → `package`; otherwise `other`.
- **enabled**: bundled → `readBundledResourceConfig(settings)` toggle (default true); everything on disk → `true`.
- **displayName**: file basename minus `.ts`/`.js`; package path (`node_modules/@scope/name/…`) → `@scope/name`; subdir extensions → directory name.
- **askMode** (per tool, applied identically to extension tools and core tools): name in settings whitelist → `whitelisted` (user explicitly listed it — wins); else in baseline → `safe`; else `blocked`.
- **Snapshot must be JSON-safe**: strip functions/symbols/cycles; maps → arrays.

## UI specification

### Header (always visible)

- Mode chip: `[ask] active — 🔒 tools are blocked` (warning color) / `[plan]` / `[implement] — no restrictions` / `No active session — showing policy`.
- Legend: `✓ read-only safe · ★ whitelisted (user) · 🔒 blocked in Ask mode`.
- Refresh button (`↻`) and search box (filters cards by extension name and item names).
- Generated-at timestamp (dim).

### Extension cards (one per `ExtensionEntry`)

- Title row: displayName + source badge (`bundled` / `agent` / `project` / `package`) + `disabled in settings` tag when `enabled === false` (whole card grayed).
- `Commands` group: `/name` rows with dim description and a source tag for `skill`/`prompt` sources.
- `Tools` group: `name` rows with dim label/description and the ask-mode chip.
- Dim metadata line: `N events · N flags · N shortcuts · N renderers`.
- Empty groups omitted; empty extension shows `no commands or tools`.

### pi core card

Same rendering; commands from `BUILTIN_SLASH_COMMANDS`, tools from `createCodingToolDefinitions(cwd)` + `getVscodeTools()`; chips computed with the same rules (`read` → safe, `edit`/`write`/`bash` → blocked, etc.).

### Load-error section (collapsible, error color)

`N extension(s) failed to load` — one row per entry: path + error text.

### States

- Loading: `Scanning extensions…` placeholder while the probe runs.
- Failure: banner with error text + `Retry` button.
- Empty: friendly empty state when nothing is installed.

## Data flow

1. Tab opens → webview sends `{ type: "getSnapshot" }` → host replies with the cached snapshot, or builds it on first request (async; webview shows the loading state meanwhile).
2. Snapshot build (`buildSnapshot()` in `extension-snapshot.ts`):
   - `SettingsManager.load(agentDir)` (fresh instance; same agentDir resolution as sessions: `getCanonicalAgentDir()`).
   - `DefaultResourceLoader(settings).load({ agentDir, cwd, noExtensions: false, additionalExtensionPaths, additionalThemePaths })` using `buildPiRuntimeResourcePaths(extensionResourcesDir, agentDir, settings)` — the exact path construction already used by live sessions, so the probe shows exactly what a new session would load. `cwd` = first workspace folder (same resolution as sessions, `vscode.workspace.workspaceFolders?.[0]`).
   - Enumerate `extensions` (commands/tools/flags/shortcuts/handlers) and `errors` from the result.
   - Core section: `BUILTIN_SLASH_COMMANDS` + `allToolNames`/`createCodingToolDefinitions(cwd)` + `getVscodeTools()` (fresh throwaway ReviewManager — review is only touched at execute time, never in the probe). The snapshot *builder* receives the core tool entries as an injected parameter so unit tests stay vscode-free.
   - Read whitelist from `<agentDir>/settings.json` (`codepi.modes.ask.allowedTools`); baseline from `src/pi-store.ts` mirror.
   - Read live mode: active session's branch custom entries (`codepi-modes:mode`) via the existing session-store access; no session → `active: false`.
3. Refresh button → webview sends `{ type: "refresh" }` → host calls the SDK `clearExtensionCache()`, rebuilds, replies with the new snapshot.
4. All replies JSON-serialized; `retainContextWhenHidden` like Settings.

## Error handling

- Loader-level failure (throws) → reply `{ ok: false, error }` → banner + Retry.
- Per-file load errors → `loadErrors` array in the snapshot (never fatal; extensions that loaded still appear).
- Malformed settings/whitelist → defensive fallback to baseline (same defensiveness as `readAskAllowedTools` in codepi-modes).
- Probe runs entirely on public SDK loader APIs in-process; it cannot mutate live sessions (a fresh `SettingsManager` + loader instance; no session objects are touched).

## Testing

- **Unit (vitest, existing suite)**:
  - Source classification: bundled / agent / project / package / other path fixtures.
  - `enabled` from `readBundledResourceConfig` (toggled-off bundled extension → `enabled: false`).
  - `askMode`: baseline tool → `safe`; user-whitelisted → `whitelisted` (incl. a tool in both lists → whitelisted wins); others → `blocked`.
  - displayName derivation (file, subdir, npm package).
  - load-error propagation into `loadErrors`.
  - JSON-safety: snapshot round-trips through `JSON.parse(JSON.stringify())` with identical shape.
- **Probe integration test**: fixture temp `agentDir/extensions/fake-ext.ts` registering one command + one tool → `buildSnapshot` returns it with both items and the right source tag. (Loader-in-process pattern already proven by the earlier probe run.)
- **Core-section unit test**: builder takes injected `coreTools`/`coreCommands` (no `vscode` import in the builder module) — fixture entries assert chips and ordering.
- **Webview**: components kept thin and stateless; verified manually via `npm run dev` (no React test infra in this repo — not added in this feature).

## Deferred / future

- Live push updates from sessions (approach C) if staleness ever matters.
- Click actions (run command / open extension file).
- Ask-mode filter toggle.
- Package-level manifest details (versions, descriptions from `package.json`).
