## Review

### Required verdict
**FAIL — Task 5 is not spec-compliant yet.** The focused backend tests and lint pass, but two concrete blockers remain: the dashboard backend reads `auth.json` contents, and the old import-into-CodePi command remains exposed.

### Strengths
- **Compact protocol is present and mirrored.** `src/shared/settings-protocol.ts:5-54` and `webview-ui/src/settings/types.ts:5-64` define the dashboard data and only the five requested dashboard commands; the removed save/auth/models/JSON message variants are no longer in these protocol types.
- **Dashboard data is credential-free in its output shape.** `src/settings-dashboard.ts:24-45` emits paths, existence flags, resource state, and package status, without auth entries, model contents, or API keys.
- **Canonical directories are wired into the provider.** `src/extension.ts:249-256` passes `getCanonicalAgentDir()` and the runtime CodePi session directory; `src/pi-store.ts:21-27` resolves the canonical agent and session roots.
- **Bundled-resource persistence uses the safe namespace merge helper.** `src/settings-view.ts:128-140` reads the current policy, changes one stable resource ID, and calls `updateBundledResourceConfig`; `src/pi-store.ts:250-260` preserves unrelated settings through `writeCodePiSettingsMerge`.
- **Native file opening and auth permissions are implemented.** `src/settings-view.ts:143-149` ensures and opens the requested real file, and `src/pi-store.ts:226-241` applies `0600` to auth files (including existing files).
- Validation performed during review: `npm run lint` passed; `npx vitest run src/__tests__/settings-protocol.test.ts src/__tests__/pi-store.test.ts` passed (2 files, 26 tests); `git show --check 26bed1b` passed. The reported webview build failure is the expected old-consumer failure and is not counted as a blocker.

### Issues

#### Blocker
1. **`auth.json` is read and parsed by the dashboard backend.** `src/settings-view.ts:116-118` calls `readJsonFile(`${this.agentDir}/auth.json`)` to compute the existence flag. `readJsonFile` reads and parses the complete file (`src/pi-store.ts:145-156`), which violates the binding requirement that auth contents are never read/sent. It also means malformed or unreadable auth JSON can make `settings:get`/`settings:refresh` fail even though only existence is needed. Use a filesystem existence/stat check for the metadata and never invoke the JSON reader for auth.

#### Blocker
2. **The old import-into-CodePi action is still exposed.** `src/extension.ts:44` imports `runImportFlow`, and `src/extension.ts:524-536` still registers `codepi.importPiConfig`, invokes the old import flow, and reports “Imported into CodePi storage.” It is also exposed as a command in `package.json:145-146` (`CodePi: Import pi Configuration…`). Task 5 explicitly permits preserving a migration possibility only if needed for Task 7, not exposing the old import-into-CodePi action. Remove this user-facing command/menu route (or keep only a non-exposed migration seam for Task 7).

### Notes / residual risks
- The new protocol test (`src/__tests__/settings-protocol.test.ts:10-48`) tests the pure data builder and TypeScript message literals, but does not exercise `SettingsViewProvider` message handling. It therefore would not catch either blocker above, nor verify native VS Code opening, refresh callback behavior, or package-manager integration.
- `src/settings-dashboard.ts:48-50` constructs file metadata with a manual `/` separator instead of `node:path.join`. This is usable on POSIX and usually accepted by Windows, but `path.join(agentDir, filename)` would provide canonical platform paths consistently.
- The extension's refresh callback is invoked by the provider (`src/settings-view.ts:64-67`), but the callback supplied at `src/extension.ts:251-253` is currently a no-op. New sessions do recreate their settings manager from disk, so this does not by itself block the stated future-session behavior; host verification remains advisable.
- Webview build remains expected to fail until Task 6 rewrites the old consumer, as documented in the task report; it was not treated as a Task 5 blocker.

### Task quality verdict
**Needs changes before acceptance.** The implementation has a coherent compact protocol, canonical path wiring, safe toggle merge, native file actions, and passing focused validation. However, the auth read is a direct security/contract violation and the exposed import command directly violates route-removal scope. The task should not be accepted until both blockers are corrected and focused tests cover the backend-sensitive behavior.