Status: DONE

Commit: 3e20104 test: cover explicit CodePi session routing

Tests: `npx vitest run src/__tests__/extension-storage.test.ts src/__tests__/pi-store.test.ts src/__tests__/pi-resource-policy.test.ts` — 3 files, 30 tests passed; `npx tsc -p ./tsconfig.json --noEmit` passed.

Concerns: The unrelated 2339a90 history and dirty `src/views/session-tree.ts` changes were preserved; only the owned test file was staged.

Report: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-3-report.md