## Review

- **Required verdict:** **Changes requested** (one major spec-compliance issue).
- **Task quality verdict:** **Good implementation with a major error-state regression; not ready to accept until the initial-load error is rendered.**

### Strengths

- `webview-ui/src/settings/App.tsx:126-238` implements the requested compact dashboard: Pi resources, CodePi defaults toggles, Pi file actions, refresh, Sessions navigation, and the per-machine/new-session notes.
- `webview-ui/src/settings/App.tsx:11-13, 41-47, 74, 89, 114` posts only the dashboard message commands represented by `SettingsMessage`; the removed form/schema/API-key/JSON-editor UI is absent from the changed App.
- `src/settings-view.ts:146-152` opens the real Pi files through `vscode.workspace.openTextDocument` and `showTextDocument`, rather than reproducing file contents in the webview.
- `src/settings-view.ts:129-131` rejects unknown bundled-resource IDs at runtime before persistence, satisfying the Task 5 P2 follow-up. `src/settings-view.ts:164-166` uses `node:path.join` for the settings path.
- `webview-ui/src/settings/settings.css:1-210` is a compact VS Code-variable-based layout with responsive stacking and visible focus styling; obsolete textarea/form layout rules were removed.
- The diff deletes the three obsolete settings components and keeps the change focused on the dashboard/protocol/backend path and ID fixes. The supplied report records a passing webview build, production build, typecheck, test run, and whitespace check.

### Issues by severity

- **Major — `webview-ui/src/settings/App.tsx:108-123`: initial-load errors are not displayed.** The message handler sets `error` on `settings:error` at lines 108-110, but the `if (!data)` branch immediately returns only the loading view at lines 118-123. Therefore any failure during the initial `settings:get` (for example, malformed `settings.json`, SDK import failure, or package-manager failure in `src/settings-view.ts:95-121`) leaves the dashboard stuck on “Loading CodePi settings…” with no error feedback. This violates the brief’s required loading/error state and makes recoverable setup failures appear hung. Render the error in the no-data branch (and provide a retry/Refresh action), or gate loading on an explicit loading state instead of solely on `data`.

### Notes / residual risks

- **Note — native host behavior remains manually unverified.** The report explicitly says Extension Development Host verification of file opening is still outstanding. The implementation path is correct by inspection (`src/settings-view.ts:146-152`), but this review did not launch VS Code.
- **Note — no new webview unit tests.** The report says the existing setup has no DOM harness. The production build and existing protocol tests provide useful coverage, but the initial-load error regression above would be straightforward to catch with a small component test if a harness is added.
- Existing unrelated worktree modifications and `.pi-subagents/artifacts/` were visible in status, but they are outside the reviewed commit/diff and were not treated as Task 6 changes.