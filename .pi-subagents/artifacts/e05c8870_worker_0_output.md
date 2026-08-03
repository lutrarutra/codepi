Status: DONE

Commits:
- 3f0f899 fix: make legacy migration retryable

Tests:
- npx vitest run src/__tests__/legacy-migration.test.ts src/__tests__/pi-store.test.ts — passed (2 files, 25 tests)
- npm run lint — passed (tsc -p ./tsconfig.json --noEmit)
- git diff --cached --check — passed before commit for owned fixes

Changed files:
- src/extension.ts
- src/__tests__/legacy-migration.test.ts
- .superpowers/sdd/task-7-report.md (ignored report artifact updated, not committed)

Fixes:
- Completion marker `codepi.legacyMigrationPrompted.v1` is now written only after migration succeeds. Accepted migrations that throw leave the marker unset and can be retried on the next activation; declining also leaves it unset for a future prompt.
- Prompt wording now accurately covers “legacy storage/configuration or sessions,” including sessions-only cases.
- Added an idempotence regression test invoking migration twice, asserting no second copy, expected skip results, and unchanged destination contents.

Concerns:
- Recursive session copy remains non-transactional and could leave a partial destination if interrupted; this was outside the requested narrow fix scope.
- Unrelated same-file dirty changes in src/extension.ts, src/__tests__/legacy-migration.test.ts, and src/pi-store.ts remain unstaged and were preserved.
- No files remain staged after commit.

Report: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-7-report.md