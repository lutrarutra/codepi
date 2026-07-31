# CodePi Settings: Migration to VSCode Storage + Sidebar GUI

**Date:** 2026-07-31
**Status:** Implemented 2026-07-31 (see `docs/superpowers/plans/2026-07-31-settings-gui.md`; plan executed incl. Task 7b — import button + custom source path)
**Approved design** (pending implementation plan — superseded)

## Problem

CodePi shares pi's config (`~/.pi/agent`) with the pi CLI because the SDK resolves
`getAgentDir()` from `$PI_CODING_AGENT_DIR` or `~/.pi/agent` at call time. The user
wants:

1. The extension's config to live in **VSCode's dedicated per-extension storage**
   (`context.globalStorageUri`), fully **separate** from the pi CLI's `~/.pi`.
2. A **settings GUI in the sidebar** covering everything pi stores (settings.json,
   auth.json, models.json), built as a schema-driven form plus a raw JSON editor.

## Approach (agreed)

- **Redirect via env var** `PI_CODING_AGENT_DIR` → `globalStorageUri/agent` set in
  `activate()` before the first SDK use. Pi's own code then reads/writes all config
  and sessions under that directory with its own formats and locking.
- **Sidebar tabs via view `when` clauses**: sessions `TreeView` and a new settings
  `WebviewView` both live in the existing `codepi-sessions` activity-bar container;
  a context key (`codepi.sidebarTab`) toggles which is visible. Native tree is kept
  as-is (preview/double-click behavior preserved).

## Section 1 — Storage layout & redirect

```
<globalStorageUri>/agent/
  settings.json      — pi global Settings (flat JSON)
  auth.json          — Record<providerId, Credential>, written 0o600
  models.json        — custom model definitions (typebox-validated by pi)
  models-store.json  — auto-refreshed provider catalogs (pi-owned; NOT GUI-edited)
  sessions/          — session files (<agentDir>/sessions/<encoded-cwd>/ by default)
  skills/ prompts/ themes/ — pi convention dirs
```

- `activate()`: `process.env.PI_CODING_AGENT_DIR = join(globalStorageUri.fsPath, "agent")`
  + `mkdirSync(..., { recursive: true })` before any `getPi()`.
- Replace the module-level `agentDir` const (`src/extension.ts:41`) and the copy in
  `src/views/session-tree.ts:89` (both `~/.pi/agent`) with a single shared module
  **`src/pi-store.ts`**: `configure(context)` + `getAgentDir()` — one source of truth
  for the tree, session paths, and imports.
- `SessionManager.create(cwd, undefined, workspaceRoot)` then writes sessions under
  `globalStorage/agent/sessions/` automatically; session code unchanged.
- `codepi.piPath` configuration (custom SDK path override) stays.

### First-run import

On activation, if `~/.pi/agent` contains any of `{settings.json, auth.json, models.json}`
**and** the extension store is empty (no marker), show a modal:
"Found existing pi configuration at ~/.pi/agent" with buttons:
**Import (config + sessions)** / **Import config only** / **Start fresh**.

- Import copies the files; auth.json keeps mode 0o600.
- Any choice writes a marker (`context.globalState` key `codepi.importPrompted`) so it
  never asks again.
- A `codepi.importPiConfig` command remains available in the settings GUI for later.
- Sessions stay 100% inside the extension's storage afterwards; pi CLI keeps its own
  `~/.pi` untouched.

## Section 2 — Sidebar tabs (native views + when clauses)

```jsonc
// contributes.views["codepi-sessions"]
{ "id": "codepi.sessionsList", "name": "Sessions", "when": "codepi.sidebarTab == sessions" },
{ "id": "codepi.settings",     "name": "Settings", "type": "webview", "when": "codepi.sidebarTab == settings" }
```

- Commands: `codepi.openSettingsTab` / `codepi.openSessionsTab` → `setContext("codepi.sidebarTab", …)`.
  Default `"sessions"` set at activation.
- Sessions view title bar: **gear icon** (view/title menu, `when: view == codepi.sessionsList`)
  → `openSettingsTab`.
- Settings webview header: tab strip `[Sessions] [Settings]` — clicking Sessions runs
  `openSessionsTab`.
- Settings webview registered with `retainContextWhenHidden: true` (form state survives
  tab switches).

### Webview plumbing

- New second Vite entry (`webview-ui/src/settings/…`) producing its own HTML bundle.
- Extension loads chat HTML for the custom editor, settings HTML for the sidebar view
  (existing webview-asset helper extended to two pages).

### Messages (settings view ⇄ extension)

- `{ command: "settings:get" }` → `{ command: "settings:data", settings, auth, models, catalog }`
- `{ command: "settings:save", scope, value }` → validate + write + ack/errors
- `{ command: "settings:saveJson", file, text }` → validate + write or line-level JSON errors

## Section 3 — Settings GUI structure

- **One shared schema** `shared/pi-settings-schema.ts` (imported by the esbuild
  extension bundle AND the Vite webview) mirrors pi's `Settings` interface: sections +
  fields with key, label, type (`string | number | boolean | select | enum | string[] |
  object`), options, help text. A small validator walks the same schema — instant
  feedback in the webview, re-run in the extension before writing.
- Settings page internal tabs: **Form | JSON editor**.

**Form sections:**
1. **General** — default provider/model (selects fed from the 1008-model registry
   catalog), default thinking level, transport, theme, project trust, UI mode,
   compaction settings.
2. **Provider API keys** (auth.json) — bespoke list editor: row per provider (masked
   password field with "•••••• unchanged" placeholder; existing keys never round-trip
   to the webview as plaintext — only new values sent; or env-var name field),
   add/remove rows, OAuth entries read-only ("Logged in via OAuth").
3. **Custom models** (models.json) — list with add/edit/remove; form covers common
   fields (provider, id, name, context window, thinking map, routing…); per-model
   "Edit JSON" opens that model in the JSON editor validated against pi's models.json
   schema (pi's parse/validation errors surfaced in the GUI).
4. **Advanced** — remaining Settings fields grouped by pi categories (terminal, images,
   retry, markdown, warnings, skills, prompts, themes, analytics, network), collapsible.

**JSON editor tab:** full-file editors for `settings.json` / `auth.json` / `models.json`
(monospace textarea; Monaco not bundled in webviews by default) with **Validate & Save**:
parse + schema validation, line-level errors, no write on error.

**Save flow:** section Save buttons (or one Save with dirty tracking) → `settings:save`
per scope → extension validates, writes file (auth 0o600), acks — inline
"Saved"/error toasts. `settings:get` loads current contents + catalog on reveal.

## Section 4 — Data flow, writes & hot-apply

- **Atomic writes** (tmp file + rename) everywhere.
- **auth.json**: read current, merge only changed provider entries, atomic write
  (preserves OAuth entries created by chat `/login`).
- **settings.json / models.json**: atomic replace (pi snapshots settings at session
  start; writes only on explicit set-calls — race negligible).
- **Hot-apply** after save (in-extension event emitter → `settingsChanged` to open
  chat panels):
  - auth.json — no restart; pi resolves request auth at request time, next message
    uses the new key.
  - models.json — open panels re-fetch the model list if the registry exposes a
    reload, else selector refreshes on next session.
  - settings.json — attempt `SettingsManager.setGlobalSettings(...)` per open panel;
    on failure (or fields read only at startup like compaction/terminal) the GUI
    shows "applies to new sessions" under affected fields.

## Section 5 — Security, error handling, testing

**Security**
- auth.json mode 0o600 (mirrors pi's `FileAuthStorageBackend`).
- Keys masked; existing keys never round-trip to the webview; OAuth tokens never sent.
- Import copies auth.json keeping 0o600.

**Error handling**
- JSON parse errors → line/col messages, no write on error.
- Schema errors → field-level messages.
- Write failures → toast, form state kept.
- Import failure → surfaced, marker not written (retryable).

**Testing**
- New pure core (`src/pi-store.ts` + `shared/pi-settings-schema.ts` validator) gets a
  vitest unit suite (`npm test`): schema validation, auth merge, import behavior,
  atomic write.
- Manual verification via F5: redirect (new sessions land in
  `globalStorage/agent/sessions`), first-run prompt, tab toggle, save→file, JSON
  validation, key masking.

## File inventory

| File | Change |
| --- | --- |
| `package.json` | settings webview view + when-clauses, 3 commands (`openSettingsTab`, `openSessionsTab`, `importPiConfig`), view/title gear menu |
| `src/pi-store.ts` (new) | configure(context), getAgentDir, read/merge/write files, atomic write, import logic, marker |
| `src/settings-view.ts` (new) | WebviewViewProvider for `codepi.settings`, message handling, catalog fetch |
| `src/extension.ts` | env redirect + mkdir in activate; agentDir via pi-store; register settings provider + tab commands; settingsChanged emitter wired to chat panels |
| `src/views/session-tree.ts` | agentDir via pi-store |
| `shared/pi-settings-schema.ts` (new) | schema + validator, imported by extension and webview |
| `webview-ui/` | second entry (settings app: tabs, schema form renderer, keys editor, models editor, JSON editor), two-page build, HTML helper for two pages |

## Out of scope

- Editing `models-store.json` (pi-owned cache of provider catalogs).
- OAuth token editing (managed by pi login flows; shown read-only).
- Sync across machines (globalStorage is per-machine by design).
