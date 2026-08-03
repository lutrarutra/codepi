Status: DONE

Commit: d27c851 feat: report canonical Pi package status

Tests/build:
- npx vitest run src/__tests__/settings-protocol.test.ts src/__tests__/pi-runtime-config.test.ts — passed (2 files, 10 tests)
- npm run lint — passed (tsc -p ./tsconfig.json --noEmit)
- npm test -- --run — passed (14 files, 109 tests)
- npm run build — passed (webview and extension production builds)
- git diff --check — passed for owned staged changes

Changed files:
- src/settings-dashboard.ts
- src/settings-view.ts
- src/__tests__/settings-protocol.test.ts
- src/extension.ts

Implementation:
- Dashboard package status maps SDK DefaultPackageManager.listConfiguredPackages() entries to credential-free source/scope/installed rows and aggregate counts.
- Status collection is read-only and does not invoke network installation, matching the Task 8 brief; Pi resource loading reconciles configured packages when a new session starts.
- Runtime resource/toggle paths are rebuilt inside the new-session runtime factory, ensuring current canonical settings are read for every new session instead of activation-time snapshots.
- Existing same-file/unrelated worktree changes were preserved unstaged.

Concerns:
- Native VS Code file opening remains a manual Extension Development Host check from Task 6.
- No direct VS Code host test covers SettingsViewProvider; pure mapping and full suite/build pass.
- No dashboard install action was added because the approved brief explicitly requires status-only refresh and forbids network installation merely to display status.
- Existing unrelated unstaged changes remain in src/extension.ts and webview-ui/src/settings/App.tsx.

Report: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-8-report.md