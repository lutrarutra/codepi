Status: DONE_WITH_CONCERN

Commit: 0537d41 test: cover canonical package status and runtime refresh

Tests:
- npx vitest run src/__tests__/settings-protocol.test.ts src/__tests__/pi-runtime-config.test.ts src/__tests__/pi-store.test.ts — passed (3 files, 33 tests)
- npm run lint — passed (tsc -p ./tsconfig.json --noEmit)
- git diff --check — passed for owned Task 8 files before commit

Changed files:
- src/settings-dashboard.ts
- src/settings-view.ts
- src/extension.ts
- src/pi-runtime-config.ts
- src/__tests__/settings-protocol.test.ts
- src/__tests__/pi-runtime-config.test.ts
- .superpowers/sdd/task-8-report.md (report artifact, not committed)

Implemented:
- Added collectConfiguredPackageStatus(), using SettingsManager.create(cwd, agentDir) and DefaultPackageManager.listConfiguredPackages(), matching SettingsViewProvider’s SDK boundary.
- Added a fake-agent test with one installed and one missing npm package. It asserts exact source/scope/installed rows, verifies the missing source list, and confirms no missing package directory is created (status collection performs no installation/network side effect).
- Added buildCurrentPiRuntimeResourcePaths(), a call-time settings-reader seam used by startTuiBackend’s runtime factory.
- Added a behavior test that changes settings between two factory-style calls and verifies disabled custom-footer is absent while filechanges remains enabled on the second call.
- Reverted the unrelated formatting-only isBundledResourceId hunk in src/settings-view.ts.
- Appended exact follow-up evidence to task-8-report.md.

Concern:
- Existing unrelated formatting changes in src/__tests__/pi-runtime-config.test.ts and src/extension.ts were already present in the dirty checkout and were included when staging the owned files. They were not newly authored as part of the follow-up, but remain in commit 0537d41’s diff from d27c851. No unrelated files were staged; current unrelated dirty files remain untouched. History was not rewritten.

Worktree:
- No files staged after commit. Existing unrelated modifications remain in src/__tests__/legacy-migration.test.ts, src/pi-store.ts, src/views/session-tree.ts, webview-ui/src/settings/App.tsx, webview-ui/src/settings/settings.css, plus pre-existing artifact files.