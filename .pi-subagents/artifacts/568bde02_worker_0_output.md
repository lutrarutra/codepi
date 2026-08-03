Status: DONE

Commit:
- 38405e7 fix: reapply bundled theme after Pi reload

Tests: `npx vitest run src/__tests__/pi-runtime-config.test.ts src/__tests__/pi-store.test.ts src/__tests__/pi-resource-policy.test.ts src/__tests__/extension-storage.test.ts` — 4 files, 35 tests passed; `npx tsc -p ./tsconfig.json --noEmit` passed.

Concerns: Legacy import prompt remains intentionally deferred to Task 7. The SDK reload-boundary regression is covered by a deterministic pure test; no broad VS Code host test was added. Unrelated dirty files/artifacts were preserved and no files remain staged.

Report: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-report.md