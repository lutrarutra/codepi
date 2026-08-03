Status: DONE

Commit:
- ccdec9b fix: preserve bundled theme across Pi reloads

Tests:
- npx vitest run src/__tests__/pi-runtime-config.test.ts src/__tests__/pi-store.test.ts src/__tests__/pi-resource-policy.test.ts src/__tests__/extension-storage.test.ts — 4 files, 36 tests passed
- npx tsc -p ./tsconfig.json --noEmit — passed
- git diff --check -- src/extension.ts src/pi-runtime-config.ts src/__tests__/pi-runtime-config.test.ts — passed

Concerns:
- Legacy import remains deferred to Task 7 as requested.
- No broad SDK monkey-patch was used; the existing AgentSession.reload beforeSessionStart hook is wrapped.
- Unrelated dirty checkout files/artifacts remain untouched and unstaged.

Report: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-report.md