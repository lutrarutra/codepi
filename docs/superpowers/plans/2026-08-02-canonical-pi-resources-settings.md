# Canonical Pi Resources and CodePi Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each computer's `~/.pi/agent` the canonical Pi resource/package root while keeping CodePi sessions in VS Code storage, and replace the current settings UI with a compact dashboard plus native VS Code JSON-file actions.

**Architecture:** `src/pi-store.ts` owns the canonical agent path, CodePi session path, bundled-resource policy, safe settings merge, and legacy migration helpers. The extension passes the canonical agent directory to Pi's `DefaultResourceLoader`/runtime and an explicit VS Code session directory to every `SessionManager` call. CodePi-bundled extensions/themes remain additional, CodePi-only resources filtered by a `codepi` namespace in canonical `settings.json`; a small settings webview controls that namespace and opens the real Pi JSON files in VS Code.

**Tech Stack:** TypeScript, VS Code Extension API, `@earendil-works/pi-coding-agent` 0.80.1 SDK, Node `fs`/`path`/`os`, React 18 + Vite 5 settings webview, Vitest.

## Global Constraints

- The executing computer's `~/.pi/agent` is the canonical Pi `agentDir`; Remote-SSH uses the remote computer's own home directory.
- CodePi sessions remain under `context.globalStorageUri/sessions`; never use `~/.pi/agent/sessions` for CodePi session creation or listing.
- The Pi CLI is optional; the embedded SDK may install configured packages, but npm/bun/pnpm, Git, network access, and permissions are host prerequisites.
- Remove `noExtensions: true`; user packages/resources from canonical `settings.json` must load.
- CodePi-bundled resources stay inside the extension and are not copied/symlinked into `~/.pi/agent`.
- Missing `codepi` resource toggles default to enabled; explicit `false` disables a bundled resource.
- Never persist the implicit CodePi-only `nebula-pulse` theme name into canonical Pi settings; explicit user themes win.
- Settings writes preserve unknown keys, package declarations, credentials, and concurrent CLI changes; auth values never enter the webview protocol.
- The old in-sidebar full Pi form and rendered JSON textarea are removed; JSON files open in normal VS Code editors.
- Existing unrelated working-tree changes are not reverted or reformatted.
- Every task ends with focused tests/typechecks before its commit.

---

## File map and responsibility boundaries

- `src/pi-store.ts` — canonical agent/session paths, bundled-resource config parsing, locked CodePi namespace merge, safe JSON-file preparation, legacy migration helpers.
- `src/__tests__/pi-store.test.ts` — pure filesystem/path/config/migration tests.
- `src/shared/settings-protocol.ts` and `webview-ui/src/settings/types.ts` — small dashboard message/data contracts, kept in sync.
- `src/settings-view.ts` — dashboard backend, status collection, toggle persistence, native VS Code file opening.
- `webview-ui/src/settings/App.tsx` — compact dashboard only; no Pi settings form or JSON textarea.
- `webview-ui/src/settings/settings.css` — dashboard layout and controls.
- `src/extension.ts` — activation roots, migration hook, runtime loader, explicit session directory, bundled resource selection, reload/status integration.
- `src/views/session-tree.ts` — list/rename operations scoped to CodePi session directory.
- `src/__tests__/extension-storage.test.ts` (create if no suitable existing test exists) — session-root helper tests and isolated-home behavior.
- `src/__tests__/settings-protocol.test.ts` (create if needed) — pure dashboard/config contract tests.
- `docs/superpowers/specs/2026-08-02-canonical-pi-resources-settings-design.md` — approved behavior; update only if implementation decisions materially change it.

---

### Task 1: Add canonical path and bundled-resource policy primitives

**Files:**

- Modify: `src/pi-store.ts`
- Modify: `src/__tests__/pi-store.test.ts`
- Create: `src/__tests__/pi-resource-policy.test.ts` if keeping policy tests separate is clearer

**Interfaces:**

- Produces `getCanonicalAgentDir(): string` returning `join(homedir(), ".pi", "agent")`.
- Produces `getCodePiSessionDir(globalStoragePath: string): string` returning `join(globalStoragePath, "sessions")`.
- Produces `BUNDLED_RESOURCES` metadata for `custom-footer`, `filechanges`, and `nebula-pulse`, including stable ids, labels, kinds, and default-enabled state.
- Produces `readBundledResourceConfig(settings: unknown): BundledResourceConfig` with missing/invalid values defaulting to enabled.
- Produces `getEnabledBundledResources(settings: unknown): BundledResourceConfig` or an equivalent typed result consumed by `extension.ts` and `settings-view.ts`.

- [ ] **Step 1: Write failing path/policy tests**

Add tests covering:

```ts
it("uses the executing computer's ~/.pi/agent as the canonical agent dir", () => {
  expect(getCanonicalAgentDir()).toBe(join(homedir(), ".pi", "agent"));
});

it("keeps CodePi sessions below VS Code global storage", () => {
  expect(getCodePiSessionDir("/vscode/codepi")).toBe("/vscode/codepi/sessions");
});

it("enables every bundled resource when codepi settings are absent", () => {
  expect(readBundledResourceConfig({})).toEqual({
    bundledExtensions: { "custom-footer": true, filechanges: true },
    bundledThemes: { "nebula-pulse": true },
  });
});

it("honors explicit false values and ignores malformed values safely", () => {
  expect(readBundledResourceConfig({
    codepi: {
      bundledExtensions: { "custom-footer": false },
      bundledThemes: { "nebula-pulse": "off" },
    },
  })).toEqual({
    bundledExtensions: { "custom-footer": false, filechanges: true },
    bundledThemes: { "nebula-pulse": true },
  });
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
npx vitest run src/__tests__/pi-store.test.ts src/__tests__/pi-resource-policy.test.ts
```

Expected: FAIL because the new exports do not exist.

- [ ] **Step 3: Implement the pure helpers**

Keep the helpers independent of VS Code. Use `node:os`/`node:path`; do not use the existing `PI_CODING_AGENT_DIR` override for the canonical helper. Keep `getAgentDir()` as the configured runtime getter for tests/compatibility, but make activation set it to `getCanonicalAgentDir()`.

Use a stable typed shape:

```ts
export interface BundledResourceConfig {
  bundledExtensions: {
    "custom-footer": boolean;
    filechanges: boolean;
  };
  bundledThemes: {
    "nebula-pulse": boolean;
  };
}
```

For malformed `codepi`, malformed child objects, unknown keys, or non-boolean values, preserve safe defaults and never throw.

- [ ] **Step 4: Run focused tests and verify pass**

Run the same Vitest command. Expected: PASS for all new and existing pi-store tests.

- [ ] **Step 5: Commit**

```bash
git add src/pi-store.ts src/__tests__/pi-store.test.ts src/__tests__/pi-resource-policy.test.ts
git commit -m "feat: define canonical Pi and CodePi resource paths"
```

---

### Task 2: Make CodePi namespace writes safe and add native file preparation

**Files:**

- Modify: `src/pi-store.ts`
- Modify: `src/__tests__/pi-store.test.ts`
- Create: `src/__tests__/pi-settings-store.test.ts` if needed

**Interfaces:**

- Produces `updateBundledResourceConfig(settingsPath: string, config: BundledResourceConfig): void`.
- Produces `ensurePiJsonFile(file: "settings" | "models" | "auth"): string` or a path-based pure helper plus an extension wrapper.
- Produces `writeCodePiSettingsMerge(settingsPath, updater)` using the Pi settings lock when available or a lock-safe read/merge/write strategy.

- [ ] **Step 1: Write failing merge/security tests**

Cover:

```ts
it("writes codepi toggles without clobbering Pi packages or unknown settings", () => {
  writeJsonFileAtomic(settingsPath, {
    packages: ["npm:existing"],
    defaultModel: "gpt-5",
    unknownFutureKey: { enabled: true },
  });

  updateBundledResourceConfig(settingsPath, {
    bundledExtensions: { "custom-footer": false, filechanges: true },
    bundledThemes: { "nebula-pulse": true },
  });

  expect(readJsonFile(settingsPath)).toEqual({
    packages: ["npm:existing"],
    defaultModel: "gpt-5",
    unknownFutureKey: { enabled: true },
    codepi: {
      bundledExtensions: { "custom-footer": false, filechanges: true },
      bundledThemes: { "nebula-pulse": true },
    },
  });
});

it("creates auth.json with owner-only permissions", () => {
  const p = ensurePiJsonFileInDir(dir, "auth");
  expect(readJsonFile(p)).toEqual({});
  expect(statSync(p).mode & 0o777).toBe(0o600);
});
```

Also test malformed `settings.json` is not overwritten by a toggle update and that missing settings/models files are created as `{}`.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npx vitest run src/__tests__/pi-store.test.ts src/__tests__/pi-settings-store.test.ts
```

Expected: FAIL for the new merge/file helpers.

- [ ] **Step 3: Implement locked merge and file preparation**

Prefer the SDK's `SettingsManager.create(cwd, agentDir)` setters only if the required `codepi` unknown key can be preserved; otherwise use a small filesystem helper. The helper must:

1. read the current JSON;
2. reject malformed JSON without writing;
3. shallow-copy top-level keys;
4. replace only `codepi.bundledExtensions` and `codepi.bundledThemes`;
5. write atomically;
6. preserve `auth.json` mode `0600`.

Do not add a new runtime dependency just for locking. If no lock package is directly available to the extension bundle, use a same-file temporary/rename strategy and document that the next runtime loader/settings write must be serialized through the existing Pi settings manager; do not overwrite a file after a stale read. The implementation should re-read immediately before the atomic write and fail/retry once if the file changed.

- [ ] **Step 4: Run focused tests and verify pass**

Run the same Vitest command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pi-store.ts src/__tests__/pi-store.test.ts src/__tests__/pi-settings-store.test.ts
git commit -m "feat: safely persist CodePi resource preferences"
```

---

### Task 3: Introduce explicit CodePi session directory helpers and route session tree calls

**Files:**

- Modify: `src/pi-store.ts`
- Modify: `src/extension.ts`
- Modify: `src/views/session-tree.ts`
- Modify: `src/__tests__/pi-store.test.ts`
- Create/modify: `src/__tests__/extension-storage.test.ts`

**Interfaces:**

- `getCodePiSessionDir(globalStoragePath: string): string` from Task 1 is used everywhere.
- `SessionTreeProvider` accepts `sessionDir: string` in its constructor or a getter callback.
- All `SessionManager` calls in CodePi pass `codePiSessionDir` explicitly.

- [ ] **Step 1: Add failing session-root tests**

Test a fake global storage root and assert the session directory is not under the canonical agent root. Add source-level or mocked SDK tests for the required calls:

```ts
expect(SessionManager.create).toHaveBeenCalledWith(workspaceRoot, codePiSessionDir);
expect(SessionManager.list).toHaveBeenCalledWith(workspaceRoot, codePiSessionDir);
expect(SessionManager.listAll).toHaveBeenCalledWith(codePiSessionDir);
```

If the current extension test harness cannot import `extension.ts` due to VS Code globals, add a pure helper test plus a focused grep/assertion test around an extracted `session-store.ts` helper instead of introducing a broad VS Code mock framework.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npx vitest run src/__tests__/extension-storage.test.ts src/__tests__/pi-store.test.ts
```

Expected: FAIL until explicit session directories are threaded through.

- [ ] **Step 3: Implement session directory routing**

In `activate(context)` compute:

```ts
const codePiSessionDir = getCodePiSessionDir(context.globalStorageUri.fsPath);
fs.mkdirSync(codePiSessionDir, { recursive: true });
```

Store it in a module-level/context-scoped value used by session commands and providers. Change:

- new session creation to `SessionManager.create(workspaceRoot, codePiSessionDir)`;
- session open/restore to `SessionManager.open(path, codePiSessionDir, workspaceRoot)`;
- current-workspace listing to `SessionManager.list(workspaceRoot, codePiSessionDir)`;
- all-session lookup to `SessionManager.listAll(codePiSessionDir)`;
- session tree listing to `SessionManager.list(this.cwd, this.sessionDir)`;
- rename/open flows to use the explicit directory when a future branch/new session can be created.

Do not call `SessionManager.listAll()` without an argument. Do not use the SDK's default `getAgentDir()` session root.

- [ ] **Step 4: Run focused tests and inspect call sites**

Run:

```bash
npx vitest run src/__tests__/extension-storage.test.ts src/__tests__/pi-store.test.ts
rg 'SessionManager\.(create|open|list|listAll)' src
```

Expected: tests pass and every persistent call has the explicit CodePi session directory.

- [ ] **Step 5: Commit**

```bash
git add src/pi-store.ts src/extension.ts src/views/session-tree.ts src/__tests__/extension-storage.test.ts src/__tests__/pi-store.test.ts
git commit -m "fix: keep CodePi sessions in VS Code storage"
```

---

### Task 4: Wire canonical Pi resources into the embedded runtime

**Files:**

- Modify: `src/extension.ts`
- Modify: `src/pi-store.ts` if resource path construction is extracted
- Modify: `src/__tests__/pi-store.test.ts`
- Create/modify: `src/__tests__/pi-runtime-config.test.ts`

**Interfaces:**

- Runtime builder consumes `getCanonicalAgentDir()`, `readBundledResourceConfig()`, and `getCodePiSessionDir()`.
- Runtime builder produces a loader with canonical `agentDir`, `noExtensions !== true`, selected additional paths, and a separate session manager.

- [ ] **Step 1: Write failing runtime configuration tests**

Test the extracted pure builder/config function or a mocked `DefaultResourceLoader` call:

```ts
expect(loaderOptions.agentDir).toBe(canonicalAgentDir);
expect(loaderOptions.noExtensions).not.toBe(true);
expect(loaderOptions.additionalExtensionPaths).toEqual(expect.arrayContaining([
  customFooterPath,
  fileChangesPath,
]));
expect(loaderOptions.additionalThemePaths).toContain(nebulaPulsePath);
```

Also test explicit `false` removes the corresponding additional path, and the `rpiv-todo` lookup is relative to `agentDir/npm/node_modules/...`, not `os.homedir()` hard-coded independently.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npx vitest run src/__tests__/pi-runtime-config.test.ts
```

Expected: FAIL because activation still uses VS Code agent storage, disables all extensions, and hard-codes the todo path.

- [ ] **Step 3: Set the canonical agent root before SDK use**

At the top of `activate(context)`:

```ts
const piAgentDir = getCanonicalAgentDir();
setAgentDir(piAgentDir);
fs.mkdirSync(piAgentDir, { recursive: true });
```

Remove the old `globalStorageUri/agent` assignment. Keep `globalStorageUri/sessions` only for CodePi sessions.

- [ ] **Step 4: Create a shared SettingsManager and effective bundled theme override**

Inside the runtime factory, create one `SettingsManager` for `opts.cwd` and `piAgentDir`, read the canonical settings, parse the CodePi namespace, and apply `theme: "nebula-pulse"` only in memory when the user has no explicit theme and the bundled theme is enabled. Pass the same `settingsManager` to `DefaultResourceLoader` and `createAgentSession`.

Do not call `ensureDefaultTheme()` in its old form because it writes `theme` into canonical settings. Replace it with a non-persistent effective-theme helper or remove it.

- [ ] **Step 5: Enable normal user resources and order bundled extensions after user extensions**

Construct the loader with:

```ts
const loader = new pi.DefaultResourceLoader({
  cwd: opts.cwd,
  agentDir: piAgentDir,
  settingsManager,
  additionalExtensionPaths: enabledBundledExtensions,
  additionalThemePaths: enabledBundledThemes,
  noExtensions: false,
});
```

Use `extensionsOverride` to move bundled extension objects to the end of `base.extensions` while retaining user/project extension order. This preserves user replacement precedence for command/tool names. Do not filter `DefaultResourceLoader`'s package resources manually.

- [ ] **Step 6: Route the SDK runtime through the same agent/session roots**

Pass:

```ts
return pi.createAgentSession({
  resourceLoader: loader,
  settingsManager,
  cwd: opts.cwd,
  agentDir: piAgentDir,
  sessionManager: opts.sessionManager,
  // existing tools/options remain unchanged
});
```

Create `createAgentSessionRuntime` with `agentDir: piAgentDir` and `sessionManager` already created against `codePiSessionDir`.

- [ ] **Step 7: Run focused tests and static checks**

Run:

```bash
npx vitest run src/__tests__/pi-runtime-config.test.ts src/__tests__/pi-store.test.ts
rg 'globalStorageUri.*agent|noExtensions: true|SessionManager\.listAll\(\)|os\.homedir\(\),\s*"\.pi"' src
```

Expected: no old runtime-agent/no-extension/default-session patterns remain; focused tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/extension.ts src/pi-store.ts src/__tests__/pi-runtime-config.test.ts src/__tests__/pi-store.test.ts
git commit -m "feat: load canonical Pi resources in CodePi"
```

---

### Task 5: Replace the settings backend protocol with a dashboard/native-file API

**Files:**

- Modify: `src/shared/settings-protocol.ts`
- Modify: `webview-ui/src/settings/types.ts`
- Rewrite: `src/settings-view.ts`
- Modify: `src/extension.ts` registration callback if needed
- Create/modify: `src/__tests__/settings-protocol.test.ts`

**Interfaces:**

- `DashboardData` contains `agentDir`, `sessionDir`, bundled resource rows, package count/missing count, and JSON file existence/path metadata; never auth values.
- Messages include `settings:get`, `settings:setBundledResource`, `settings:openFile`, `settings:refresh`, and `settings:openSessions`.
- Replies include `settings:data`, `settings:saved`, `settings:error`, and `settings:opened`/status as needed.

- [ ] **Step 1: Write failing protocol/data tests**

Test that dashboard data contains paths/status but no `key`, `token`, or credential values, and that toggle messages identify only stable resource ids:

```ts
expect(JSON.stringify(data)).not.toContain("sk-");
expect(data.bundledResources).toEqual(expect.arrayContaining([
  expect.objectContaining({ id: "custom-footer", enabled: true }),
]));
```

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npx vitest run src/__tests__/settings-protocol.test.ts
```

Expected: FAIL until the new protocol types/data helpers exist.

- [ ] **Step 3: Define the compact protocol in both TypeScript mirrors**

Use a stable union such as:

```ts
export type SettingsMessage =
  | { command: "settings:get" }
  | { command: "settings:setBundledResource"; id: string; enabled: boolean }
  | { command: "settings:openFile"; file: "settings" | "models" | "auth" }
  | { command: "settings:refresh" }
  | { command: "settings:openSessions" };
```

Mirror the same definitions in `webview-ui/src/settings/types.ts`. Remove `saveSettings`, `saveAuth`, `saveModels`, `saveJson`, and `importConfig` from the dashboard protocol.

- [ ] **Step 4: Implement backend dashboard data and native file actions**

`SettingsViewProvider` should:

1. read canonical settings safely;
2. derive bundled-resource enabled state using the Task 1 policy helper;
3. inspect package declarations using a `DefaultPackageManager`/`DefaultResourceLoader` configured with canonical `agentDir` (or a pure settings/package status helper if the SDK requires async setup);
4. return only package counts/missing status, not auth contents;
5. on `settings:setBundledResource`, update only the `codepi` namespace with the Task 2 merge helper;
6. on `settings:openFile`, call `ensurePiJsonFile`, then `workspace.openTextDocument` and `window.showTextDocument`;
7. create `auth.json` with mode `0600` and never read/send its contents;
8. on `settings:refresh`, resend data and invoke the supplied `onConfigSaved` callback so future sessions use current settings;
9. keep `settings:openSessions` behavior.

Use labels/path details that make it clear settings/models/auth are real files under the current computer's `~/.pi/agent`.

- [ ] **Step 5: Remove old import/save code and old SDK model/auth UI backend**

Delete the old `runImportFlow` registration from the settings provider and remove unused imports. Keep a separate migration path only if Task 7 needs it; it must not be exposed as the old “import into CodePi storage” action.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npx vitest run src/__tests__/settings-protocol.test.ts src/__tests__/pi-store.test.ts
npm run lint
```

Expected: tests pass; typecheck may still fail only on the old webview until Task 6 rewrites it, so record exact errors and continue immediately to Task 6 rather than weakening types.

- [ ] **Step 7: Commit**

```bash
git add src/shared/settings-protocol.ts webview-ui/src/settings/types.ts src/settings-view.ts src/extension.ts src/__tests__/settings-protocol.test.ts
git commit -m "refactor: replace settings backend with dashboard protocol"
```

---

### Task 6: Rebuild the settings webview as a compact dashboard

**Files:**

- Rewrite: `webview-ui/src/settings/App.tsx`
- Rewrite: `webview-ui/src/settings/settings.css`
- Delete or stop importing: `webview-ui/src/settings/components/FormSection.tsx`, `AuthKeys.tsx`, `ModelsEditor.tsx` if unused
- Modify: `webview-ui/src/settings/types.ts` as required by Task 5
- Modify: `webview-ui/src/settings/main.tsx` only if entry behavior changes

**Interfaces:**

- Consumes the Task 5 dashboard protocol/data.
- Produces a webview with resource toggles, status cards, file-opening buttons, refresh, and sessions navigation.

- [ ] **Step 1: Replace the old component with the dashboard shell**

Implement `SettingsApp` with:

- loading/error state;
- “Pi resources” card showing `agentDir`, session directory, package counts, missing packages, and Refresh;
- “CodePi defaults” card rendering bundled resources by id with checkbox/toggle and description;
- “Pi files” card with buttons for `settings.json`, `models.json`, `auth.json`;
- note that settings are per execution machine and toggles apply to new sessions;
- buttons for Sessions and `settings:openSessions`;
- no `<textarea>`, no form schema imports, no API key inputs, and no JSON rendering.

Use `vscode.postMessage` only with the Task 5 message union.

- [ ] **Step 2: Replace CSS with a compact VS Code-native dashboard style**

Use VS Code variables, responsive stacked cards, accessible focus states, status/error colors, and a monospace path style. Avoid the old nested tab/form styles and avoid a fixed textarea layout.

- [ ] **Step 3: Remove obsolete UI components/imports**

Delete obsolete component files only if no other entry imports them. Otherwise leave them untouched but ensure they are not part of the settings bundle. Remove `react-markdown`/other dependencies only if no other webview uses them; do not make unrelated dependency changes.

- [ ] **Step 4: Build the webview**

Run:

```bash
npm --prefix webview-ui run build
```

Expected: PASS and generated settings assets exist under `webview-ui/dist`.

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/settings/App.tsx webview-ui/src/settings/settings.css webview-ui/src/settings/types.ts webview-ui/src/settings/main.tsx webview-ui/src/settings/components
 git commit -m "feat: rebuild CodePi settings dashboard"
```

---

### Task 7: Add explicit legacy-storage migration without importing host/remote Pi sessions

**Files:**

- Modify: `src/pi-store.ts`
- Modify: `src/extension.ts`
- Modify: `src/import-config.ts` only if reused for a new explicit migration flow
- Modify: `src/__tests__/pi-store.test.ts`
- Create/modify: `src/__tests__/legacy-migration.test.ts`

**Interfaces:**

- Produces `migrateLegacyCodePiStorage(legacyAgentDir, canonicalAgentDir, legacySessionDir, codePiSessionDir): MigrationResult`.
- Migration copies only missing config files into canonical `~/.pi/agent`, preserves existing canonical files, never copies `~/.pi/agent/sessions`, and moves old CodePi sessions only when the new CodePi session directory is empty.

- [ ] **Step 1: Write failing migration tests**

Cover:

```ts
it("copies legacy CodePi config only when canonical files are absent", () => {
  // legacy settings/auth/models exist; canonical settings exists
  // expect only auth/models to copy, settings to remain unchanged
});

it("migrates old CodePi sessions but never reads canonical Pi sessions", () => {
  // legacy agent/sessions has a session; canonical ~/.pi/agent/sessions has a sentinel
  // expect new globalStorage/sessions contains legacy session and sentinel remains untouched
});

it("does not overwrite a non-empty new CodePi session directory", () => {
  // expect no copy when destination already contains a session
});
```

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npx vitest run src/__tests__/legacy-migration.test.ts
```

Expected: FAIL until migration helper exists.

- [ ] **Step 3: Implement explicit migration**

Use `existsSync`, `statSync`, `cpSync`, `mkdirSync`, and secure auth mode handling. Return copied file/session names and skip reasons for the activation prompt. Make migration idempotent. Use a `context.globalState` marker so the prompt is shown once after the extension has enough context to decide.

- [ ] **Step 4: Replace old activation import prompt**

Remove the old prompt that asks to import `~/.pi/agent` into extension storage. Replace it with a prompt only when the old CodePi storage has content and canonical files are absent, explaining:

- source: old CodePi storage;
- destination: current computer's `~/.pi/agent`;
- CodePi sessions move only within the current computer's VS Code storage;
- remote hosts are not affected;
- `~/.pi/agent/sessions` is never copied.

- [ ] **Step 5: Run focused tests and commit**

```bash
npx vitest run src/__tests__/legacy-migration.test.ts src/__tests__/pi-store.test.ts
git add src/pi-store.ts src/extension.ts src/import-config.ts src/__tests__/legacy-migration.test.ts src/__tests__/pi-store.test.ts
git commit -m "feat: migrate legacy CodePi storage safely"
```

Expected: PASS.

---

### Task 8: Add resource reload/status behavior and verify package discovery

**Files:**

- Modify: `src/extension.ts`
- Modify: `src/settings-view.ts`
- Modify: `src/shared/settings-protocol.ts`
- Modify: `webview-ui/src/settings/types.ts`
- Modify: `webview-ui/src/settings/App.tsx`
- Create/modify: `src/__tests__/pi-runtime-config.test.ts`

**Interfaces:**

- Dashboard refresh reports canonical package declarations and missing installed paths.
- New sessions use the current toggles/settings; existing sessions are not falsely reported as rebound.
- Optional per-session reload is not implemented unless it can safely use Pi's `AgentSession.reload()` and existing TUI rebind hooks.

- [ ] **Step 1: Add package status tests**

Use a fake agent directory/settings with one installed and one missing package source. Assert the dashboard status reports counts/missing package names without credentials.

- [ ] **Step 2: Implement status collection**

Use `DefaultPackageManager` with `cwd`, canonical `agentDir`, and a `SettingsManager` to call `listConfiguredPackages()`. Map results to serializable status rows:

```ts
{ source: string; scope: "user" | "project"; installed: boolean }
```

Do not invoke network installation merely to display status. Resource loading may install configured packages during a new session according to Pi's SDK behavior; surface errors from that process in the existing TUI startup error path.

- [ ] **Step 3: Add dashboard refresh and explicit new-session copy**

After a toggle/save, return fresh dashboard data and state “Saved; applies to new sessions.” Ensure new `startTuiBackend` factories re-read settings/toggles for every new runtime rather than capturing stale activation-time values.

- [ ] **Step 4: Run focused tests and commit**

```bash
npx vitest run src/__tests__/pi-runtime-config.test.ts src/__tests__/settings-protocol.test.ts
 git add src/extension.ts src/settings-view.ts src/shared/settings-protocol.ts webview-ui/src/settings/types.ts webview-ui/src/settings/App.tsx src/__tests__/pi-runtime-config.test.ts src/__tests__/settings-protocol.test.ts
git commit -m "feat: report canonical Pi package status"
```

---

### Task 9: Full verification, diagnostics, and documentation alignment

**Files:**

- Modify: `README.md` if user-facing setup/storage behavior is documented
- Modify: `docs/superpowers/specs/2026-08-02-canonical-pi-resources-settings-design.md` only if implementation differs from approved design
- Modify: tests or source files only for verified defects found during this task

- [ ] **Step 1: Run language diagnostics before builds**

Run:

```bash
npx tsc -p ./tsconfig.json --noEmit
npx tsc -p ./webview-ui/tsconfig.json --noEmit
```

Fix only errors caused by this feature; do not touch unrelated pre-existing tool lint errors unless they block the build.

- [ ] **Step 2: Run the complete test suite**

```bash
npm test -- --run
```

Expected: all tests pass. If unrelated existing tests fail, record exact failures and distinguish them from feature regressions.

- [ ] **Step 3: Build extension and webview**

```bash
npm run build
```

Expected: successful webview and extension builds; `dist/extension.js` and settings assets exist.

- [ ] **Step 4: Run Pi-lens diagnostics on edited files**

Use `lens_diagnostics` mode `all` for edited source files. Resolve all blocking errors and actionable warnings introduced by this work.

- [ ] **Step 5: Run targeted source audits**

```bash
rg 'globalStorageUri.*agent|noExtensions: true|SessionManager\.listAll\(\)|settings:saveJson|settings:saveSettings|settings:saveModels|settings:saveAuth|Import pi configuration into CodePi|theme.*nebula-pulse' src webview-ui/src
```

Expected: no obsolete storage/settings UI paths remain, except intentional comments/tests documenting migration or implicit theme behavior.

- [ ] **Step 6: Manual extension-host checklist**

1. Start an Extension Development Host with a clean fake `HOME`/remote-like environment.
2. Confirm `~/.pi/agent` is created and no `~/.pi/agent/sessions` appears after creating a CodePi session.
3. Confirm the new session file is under VS Code global storage `sessions/`.
4. Put a package declaration in `~/.pi/agent/settings.json`; confirm CodePi loads/installs it without a Pi CLI binary when prerequisites exist.
5. Disable `filechanges` and `nebula-pulse` in the dashboard; create a new session and confirm they are absent/fallback behavior applies.
6. Open `settings.json`, `models.json`, and `auth.json`; verify each is a normal VS Code editor and `auth.json` has mode `0600` on POSIX.
7. Add a package via CLI on the same computer; refresh/create a CodePi session and confirm it is visible.
8. Repeat with Remote-SSH or two isolated fake homes; confirm resources and sessions do not cross machines.
9. Confirm API key values never appear in webview messages/logs.

- [ ] **Step 7: Update README/user-facing docs**

Document:

- CodePi uses the current computer's `~/.pi/agent` for Pi packages/resources;
- CodePi sessions remain computer-specific in VS Code storage;
- Remote-SSH uses the remote computer's own `~/.pi/agent` and storage;
- the Pi CLI is optional;
- package declarations/settings must be synchronized separately across SSH hosts;
- CodePi-bundled defaults are CodePi-only and configurable from Settings or the `codepi` namespace.

- [ ] **Step 8: Final commit**

```bash
git add README.md docs/superpowers/specs/2026-08-02-canonical-pi-resources-settings-design.md src webview-ui
 git commit -m "docs: document canonical Pi resources and CodePi sessions"
```

---

## Plan self-review

### Spec coverage

- Canonical `~/.pi/agent`: Tasks 1 and 4.
- Separate CodePi sessions and Remote-SSH isolation: Task 3 and Task 9 manual checklist.
- Normal Pi packages/resources and optional CLI: Task 4 and Task 8.
- CodePi-only bundled extensions/theme: Tasks 1 and 4.
- User toggles in `codepi` namespace and precedence: Tasks 1, 2, 4, and 8.
- Non-persisted default theme: Task 4 tests/implementation.
- Rebuilt dashboard and native VS Code JSON files: Tasks 5 and 6.
- Auth privacy and secure auth file handling: Tasks 2, 5, and 9.
- Legacy migration: Task 7.
- Error handling and verification: Tasks 2, 4, 7, 8, and 9.

### Placeholder scan

No `TBD`, `TODO`, `FIXME`, “implement later”, or undefined “write tests for the above” steps remain. Each task names files, interfaces, commands, and expected outcomes.

### Type consistency

- `getCanonicalAgentDir`, `getCodePiSessionDir`, `readBundledResourceConfig`, and `updateBundledResourceConfig` are introduced before consumers.
- `codePiSessionDir` is threaded from activation to extension/session tree/runtime calls.
- Dashboard message names are defined in Task 5 before the webview consumes them in Task 6.
- Migration and status helpers are introduced before activation/dashboard integration.
- The implicit-theme behavior is implemented through the SDK's `SettingsManager` and shared with the resource loader/session factory, matching the approved design.
