## Review

- **Verdict: Approve with a minor test-quality follow-up (no implementation blocker).** The changed implementation matches the Task 8 intent, focused validation passes, and the package-status path is read-only/credential-free. One requirement is only partially attested by the tests: the fake-agent test does not assert aggregate counts, and the runtime test exercises the new helper twice rather than invoking the actual `createAgentSessionRuntime` factory twice.

- **Correct:** `src/settings-dashboard.ts:26-40` constructs `SettingsManager.create(cwd, agentDir)` and `DefaultPackageManager({ cwd, agentDir, settingsManager })`, then calls only `listConfiguredPackages()`. It maps only `source`, `scope`, and an installed boolean; no credentials or auth content are read. `src/settings-view.ts:95-109` supplies the canonical agent directory and workspace cwd to this seam.

- **Correct:** `src/__tests__/settings-protocol.test.ts:37-69` creates an isolated fake agent directory, writes `settings.json` with `npm:installed` and `npm:missing`, creates only the installed package path, and observes the expected user-scope rows at lines 54-57. It explicitly identifies the missing source at lines 58-62 and verifies the missing package directory remains absent at lines 63-65, demonstrating no install/network side effect. The test passed against the installed SDK.

- **Correct:** `src/settings-protocol.test.ts`'s mapping test (current file `src/__tests__/settings-protocol.test.ts:71-105`) asserts the dashboard aggregate values `configured: 2`, `installed: 1`, and `missing: 1`, and preserves both entries. Together with the fake-agent test this verifies the status shape and aggregation, although the aggregate assertion is not fed directly from the SDK collection in the same test.

- **Correct:** `src/pi-runtime-config.ts:62-71` calls `readSettings()` inside each helper invocation. `src/extension.ts:1267-1273` calls this seam inside the runtime factory, so each newly-created runtime reads current settings/toggles rather than an activation-time snapshot. The test at `src/__tests__/pi-runtime-config.test.ts:36-59` changes the settings between calls and verifies `custom-footer` is removed while `filechanges` remains enabled. The production call site also keeps `auth.json` out of this path; it reads only `getSettingsPath()`/`settings.json`.

- **Correct:** The resource seams retain production-compatible arguments: `SettingsManager.create(opts.cwd, agentDir)` and `buildCurrentPiRuntimeResourcePaths(extensionDir, agentDir, readSettings)` are used at the runtime-factory boundary. `collectConfiguredPackageStatus` mirrors the production SDK construction in the dashboard provider.

- **Fixed/verified:** The formatting-only `isBundledResourceId` hunk is reverted in the current worktree (`src/settings-view.ts:144-150` is multiline as in the baseline). The review package itself contains the cosmetic flattening in `d27c851..0537d41` at `src/settings-view.ts:147-149`; this is formatting contamination only and has no behavioral impact.

- **Remaining issue (Medium, test coverage):** `src/__tests__/settings-protocol.test.ts:37-69` does not assert `configured`, `installed`, and `missing` counts for the rows obtained from `collectConfiguredPackageStatus`; those count assertions are in a separate mapping-only test at lines 93-105. The implementation's `buildDashboardData` counts are correct, but the requested fake-agent end-to-end status test does not itself attest the full rows-plus-counts result.

- **Remaining issue (Low, test coverage):** `src/__tests__/pi-runtime-config.test.ts:36-59` invokes `buildCurrentPiRuntimeResourcePaths` twice, not the actual `pi.createAgentSessionRuntime` callback. It proves the call-time seam rereads changed settings, while `src/extension.ts:1267-1273` visibly wires that seam into the factory, but it does not prove through an integration-style test that a second SDK-created runtime receives the changed resource set. No production bug is demonstrated.

- **Residual risk (cosmetic only):** The supplied review diff includes the temporary return-expression reformat in `src/settings-view.ts`; current file state has the revert. No functional formatting contamination was found.

- **Task quality verdict:** **Good implementation; accept with the two non-blocking test-attestation notes above.** No blocker found.

### Validation

- `npx vitest run src/__tests__/settings-protocol.test.ts src/__tests__/pi-runtime-config.test.ts src/__tests__/pi-store.test.ts` — passed, 3 files / 33 tests.
- `git diff --check d27c851..0537d41` — passed.
- No broad suite was run, per instruction. No source files were mutated; only this review artifact was written.
- No staged files were present when checked; existing unrelated/uncommitted worktree changes were preserved.