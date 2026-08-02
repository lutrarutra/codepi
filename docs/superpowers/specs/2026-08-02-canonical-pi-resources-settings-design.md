# Canonical Pi Resources and CodePi Settings Redesign

## Status

Design approved in conversation; implementation is the next phase.

## Goal

Make each computer's `~/.pi/agent` the canonical Pi resource and package directory for both the Pi CLI and CodePi's embedded SDK, while keeping CodePi conversation sessions local to the computer and CodePi installation. The Pi CLI remains optional. Replace the current duplicated settings form/textarea UI with a small CodePi dashboard and native VS Code file actions.

## Scope

### In scope

- Use the executing computer's `~/.pi/agent` as CodePi's Pi `agentDir`.
- Keep CodePi session files in VS Code extension global storage, never in `~/.pi/agent/sessions`.
- Load user-installed Pi packages/resources from `~/.pi/agent` through Pi's normal `DefaultResourceLoader`.
- Keep the extension's `resources/extensions/*` and `resources/themes/nebula-pulse.json` as CodePi-only bundled defaults.
- Let users enable/disable bundled CodePi extensions and theme through a `codepi` namespace in `~/.pi/agent/settings.json` and through the rebuilt Settings dashboard.
- Replace the current in-sidebar settings form and rendered JSON textarea with a compact dashboard.
- Open `settings.json`, `models.json`, and `auth.json` in normal VS Code editors.
- Preserve existing user settings, package declarations, credentials, models, and unrelated settings keys.
- Provide package/resource status and reload controls in the dashboard.

### Out of scope

- Synchronizing a local host's `~/.pi` filesystem into a Remote-SSH guest.
- Copying CodePi-bundled resources into `~/.pi/agent` or making them automatically visible to the Pi CLI.
- Synchronizing `auth.json` or conversation sessions across machines.
- Reimplementing Pi's full settings schema in the CodePi sidebar.
- Adding a new remote package transport or dotfiles service.

## Storage model

On every machine where the extension host executes:

```text
~/.pi/agent/
├── settings.json       # Pi settings and package declarations
├── models.json
├── auth.json
├── extensions/
├── skills/
├── prompts/
├── themes/
├── npm/
└── git/
```

CodePi sessions use a separate per-extension directory:

```text
<context.globalStorageUri>/sessions/
```

The exact session directory is passed explicitly to every `SessionManager` call. CodePi must not rely on Pi's default session directory because that would resolve under `agentDir/sessions`.

The split is per execution machine. In Remote-SSH, both `~/.pi/agent` and CodePi's global storage are on the remote machine. The local host's resources/sessions are not implicitly visible remotely.

## Pi SDK integration

### Canonical agent directory

At activation:

1. Resolve `piAgentDir = join(os.homedir(), ".pi", "agent")`.
2. Create it if missing.
3. Set `PI_CODING_AGENT_DIR` to that path before any Pi SDK call.
4. Use the same path explicitly in `DefaultResourceLoader`, `createAgentSessionRuntime`, and any SDK service constructors.

The old first-run import from `~/.pi/agent` into VS Code storage is removed or reduced to a compatibility migration for settings previously stored by old CodePi versions. It must not copy the canonical Pi directory over itself and must not import Pi sessions into CodePi storage by default.

### User resources and packages

`DefaultResourceLoader` is created with `noExtensions: false` (or with the option omitted), so it loads:

- global resources under `~/.pi/agent`;
- packages declared by `~/.pi/agent/settings.json`;
- project resources subject to Pi's normal project trust behavior.

Pi's bundled SDK package manager may install a missing configured npm/Git package without the Pi CLI binary. If npm/bun/pnpm, Git, network access, or permissions are unavailable, CodePi reports the loader/package error clearly.

### CodePi-bundled resources

The following remain inside the CodePi extension installation:

- `resources/extensions/custom-footer.ts`
- `resources/extensions/filechanges.ts`
- `resources/themes/nebula-pulse.json`

They are supplied as additional resource paths, but only when enabled by CodePi's bundled-resource settings. They are not copied or symlinked into `~/.pi/agent`, so the Pi CLI does not load them merely because CodePi is installed.

CodePi's own extension resources are loaded in addition to user resources. User resources must have precedence on command/tool collisions: the resource-loader extension override reorders CodePi-bundled extensions after user/project extensions before the extension runner binds them. This makes a user replacement effective without modifying the bundled files. Themes use Pi's normal name de-duplication with user/project resources first, so a user theme with the same name overrides the bundled theme. Existing CodePi integration with `filechanges` and the review manager remains intact.

## Bundled-resource configuration

Use a namespaced, CodePi-specific object in the global Pi settings file:

```json
{
  "codepi": {
    "bundledExtensions": {
      "custom-footer": true,
      "filechanges": true
    },
    "bundledThemes": {
      "nebula-pulse": true
    }
  }
}
```

The `codepi` object is an extension-owned forward-compatible namespace. Pi ignores unknown settings keys, and CodePi preserves the object when writing other settings.

### Default behavior

- Missing `codepi` object: all shipped defaults are enabled.
- Missing individual resource key: that resource is enabled.
- Explicit `false`: that resource is not passed to the Pi loader.
- Explicit `true`: that resource is passed to the Pi loader.
- Invalid `codepi` shape: report a settings warning, use safe defaults for missing/invalid toggles, and do not discard user data.

### Theme behavior

`nebula-pulse` is a CodePi-only additional theme. CodePi must not write `"theme": "nebula-pulse"` into canonical `settings.json`, because the Pi CLI cannot see the CodePi-only theme file.

When no explicit user `theme` is configured and the bundled theme is enabled, CodePi supplies `nebula-pulse` as the runtime default. An explicit user `theme` in `~/.pi/agent/settings.json` wins. If the bundled theme is disabled and no explicit theme is configured, Pi's normal theme detection/default is used.

Create one `SettingsManager` per CodePi runtime and share it with both `DefaultResourceLoader` and `createAgentSession`. After loading the canonical global/project settings, if the merged setting has no explicit `theme` and `nebula-pulse` is enabled, call `settingsManager.applyOverrides({ theme: "nebula-pulse" })` in memory before constructing the session. Reapply this non-persistent override after every settings reload before resource/theme reload. The resource loader's `additionalThemePaths` registers the bundled theme before `InteractiveMode` initializes its theme registry. Never persist this implicit theme to `settings.json`; explicit user themes always remain authoritative.

## Settings dashboard

The existing settings UI is replaced rather than extended.

### Dashboard sections

1. **Pi resources**
   - Display the canonical agent directory, with a button to open/reveal it.
   - Display configured package count and whether configured package paths are missing.
   - Refresh/reload the current CodePi resource view.

2. **CodePi defaults**
   - One toggle per bundled resource:
     - Custom footer
     - File changes/review integration
     - Nebula Pulse theme
   - Show that these resources are bundled with CodePi and are not installed into the Pi CLI's resource tree.
   - Save toggles to `settings.json` under `codepi` while preserving all other JSON keys.
   - Reload active sessions or clearly state that toggles apply to newly created sessions if live reload cannot safely rebind the current TUI.

3. **Pi files**
   - `Open settings.json`
   - `Open models.json`
   - `Open auth.json`
   - Use VS Code's `workspace.openTextDocument(vscode.Uri.file(path))` and `window.showTextDocument`.
   - Create an empty valid object file when needed before opening, except `auth.json`, which must retain secure `0600` permissions when created.
   - Never display credential values in the webview.

4. **Import/migration**
   - Remove the old “copy ~/.pi into CodePi storage” wording and action.
   - On upgrade, if the legacy CodePi directory `<globalStorageUri>/agent` contains settings/auth/models and the canonical `~/.pi/agent` has no corresponding files, offer one explicit migration into `~/.pi/agent`. Preserve existing canonical files, copy no sessions by default, and explain that the Pi CLI will use the migrated files too.
   - If legacy sessions exist at `<globalStorageUri>/agent/sessions`, copy them once to the new CodePi session directory `<globalStorageUri>/sessions` when the destination is empty. Never inspect, copy, or import `~/.pi/agent/sessions`.

### Native JSON editor behavior

The current in-sidebar JSON textarea and `settings:saveJson` flow are deleted. The dashboard only opens the real files in VS Code. Users can use VS Code's JSON language service, formatting, diagnostics, and source control directly. Toggling a bundled default is the only settings mutation performed by the dashboard; it uses a locked read/merge/write operation that preserves package declarations and unrelated keys.

## Settings protocol

Replace the current form-oriented protocol with a small dashboard protocol. It must support:

- initial dashboard data;
- bundled-resource toggle updates;
- open settings/models/auth file commands;
- refresh/reload;
- status/error replies;
- opening the Sessions tab.

The protocol must not contain plaintext auth values. It may include:

- agent directory path;
- session directory path;
- package/resource counts and missing status;
- bundled resource metadata and enabled flags;
- existence/path status for Pi JSON files.

## Session API requirements

Use an explicit CodePi session directory everywhere:

- `SessionManager.create(workspaceRoot, codePiSessionDir)`;
- `SessionManager.open(sessionPath, codePiSessionDir, workspaceRoot)` for restored/opened sessions;
- `SessionManager.list(workspaceRoot, codePiSessionDir)` in the tree/provider and command helpers;
- `SessionManager.listAll(codePiSessionDir)` for restore lookup.

`SessionManager.open` can derive a directory from an existing path, but CodePi should still pass `codePiSessionDir` to ensure future session replacement/branch flows remain in CodePi storage. Existing paths from an older CodePi version may be opened only if they are under the known CodePi storage directory; do not scan or import `~/.pi/agent/sessions`.

## Error handling

- Missing canonical `~/.pi/agent`: create it.
- Invalid `settings.json`: surface a readable error and avoid overwriting it from the dashboard; Pi SDK diagnostics remain available.
- Invalid `codepi` settings: use enabled-by-default behavior per resource and show a warning.
- Missing package runtime prerequisite: show the source and missing command/error.
- Missing bundled resource file after a damaged/incomplete extension install: omit it and report a CodePi error instead of crashing the session.
- Opening JSON files: create parent directories/files safely and preserve `auth.json` mode `0600`.
- Concurrent settings edits: use the existing Pi settings locking behavior or a read/merge/write operation that preserves unrelated keys and does not clobber CLI changes.
- Toggle changes: affect newly created sessions by default. The dashboard must say this explicitly. It may offer a separate reload action for the dashboard/status data, but it must not claim that already-running TUIs were rebound unless a safe `AgentSession.reload()`/TUI rebind path is implemented and tested.

## Testing and verification

Add or update tests for:

- canonical agent directory resolution and env override;
- CodePi session directory resolution and explicit session API arguments;
- bundled resource defaults and explicit false/true toggle handling;
- preserving unrelated Pi settings and package declarations when writing `codepi` toggles;
- invalid `codepi` settings fallback behavior;
- effective theme selection without persisting `nebula-pulse` into Pi settings;
- dashboard protocol messages and no credential leakage;
- native file-open command registration/behavior where VS Code mocks permit;
- resource loader configuration includes user resources and enabled CodePi additions, and no longer uses `noExtensions: true`;
- remote-like isolated homes keep resources/sessions separated from another home.

Verification should include TypeScript checks, unit tests, extension/webview builds, and diagnostics on edited files.

## Acceptance criteria

- A user-installed Pi package in the current computer's `~/.pi/agent/settings.json` is loaded by CodePi without the Pi CLI installed.
- A package installed by the CLI and one installed by CodePi use the same canonical package tree.
- CodePi sessions are written under VS Code global storage, not `~/.pi/agent/sessions`.
- Remote-SSH sessions stay on the remote computer.
- `custom-footer`, `filechanges`, and `nebula-pulse` work by default in CodePi.
- Users can disable each bundled resource from the Settings dashboard or by editing the `codepi` namespace in `~/.pi/agent/settings.json`.
- Explicit user theme/settings choices are not overwritten.
- The Settings dashboard no longer embeds a JSON textarea or duplicates the complete Pi settings form.
- Buttons open the real `settings.json`, `models.json`, and `auth.json` files in VS Code.
- No API key/token plaintext is sent to the webview.
