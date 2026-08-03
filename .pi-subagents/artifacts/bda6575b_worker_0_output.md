Status: DONE_WITH_CONCERNS

Commit: 26bed1b refactor: replace settings backend with dashboard protocol

Test summary: `npx vitest run src/__tests__/settings-protocol.test.ts src/__tests__/pi-store.test.ts` — 2 files, 26 tests passed; `npm run lint` passed. Webview build is expected to fail until Task 6 rewrites the old settings consumer UI.

Concerns: Task 6 must replace the old settings App/components to consume the compact protocol; native file opening still needs VS Code host validation. Existing unrelated dirty files were preserved.

Report: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-5-report.md