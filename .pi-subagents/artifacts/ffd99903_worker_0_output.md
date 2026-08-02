Status: DONE

Implemented Task 1 canonical path and bundled-resource policy primitives.

Commit:
- 8a01240 feat: define canonical Pi and CodePi resource paths

Changed files in commit:
- src/pi-store.ts
- src/__tests__/pi-resource-policy.test.ts

Implementation:
- Added `getCanonicalAgentDir()` for the executing computer's `~/.pi/agent`.
- Added `getCodePiSessionDir(globalStoragePath)` for CodePi sessions below VS Code global storage.
- Added stable `BUNDLED_RESOURCES` metadata for custom-footer, filechanges, and nebula-pulse.
- Added typed `BundledResourceConfig` parsing with enabled-by-default behavior and safe handling of malformed settings.
- Added `getEnabledBundledResources()` for later runtime/dashboard consumers.
- Updated `getAgentDir()` fallback to use the canonical helper while preserving `PI_CODING_AGENT_DIR` test/runtime override behavior.

Tests and validation:
- RED: `npx vitest run src/__tests__/pi-store.test.ts src/__tests__/pi-resource-policy.test.ts` initially failed with the expected missing-export/function errors for the new helpers.
- GREEN: `npx vitest run src/__tests__/pi-store.test.ts src/__tests__/pi-resource-policy.test.ts` — 2 files, 22 tests passed.
- Typecheck: `npx tsc -p ./tsconfig.json --noEmit` — passed with no output.
- Staging hygiene: `git diff --cached --check` passed before commit; after commit there are no staged files. Existing unrelated worktree changes remain untouched.

Self-review:
- Scope is limited to Task 1 helpers and focused policy tests.
- No VS Code imports or subagent work were added.
- Existing unrelated modifications in `src/pi-store.ts` and other files were not staged or reverted.

Residual risks:
- The policy parser currently returns safe defaults for malformed values; warning/reporting is intentionally deferred to later dashboard/runtime tasks.
- The new helpers are not yet wired into activation, runtime loading, session creation, or settings UI; those are later plan tasks.