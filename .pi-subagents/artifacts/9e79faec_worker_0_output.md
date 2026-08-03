Status: DONE

Commit: 46a660e fix: remove obsolete settings import route

Tests:
- npx vitest run src/__tests__/settings-protocol.test.ts src/__tests__/pi-store.test.ts src/__tests__/pi-resource-policy.test.ts — 3 files, 32 tests passed
- npm run lint — passed (tsc -p ./tsconfig.json --noEmit)
- git diff --check — passed

Changed files:
- package.json
- src/extension.ts
- src/settings-dashboard.ts
- src/settings-view.ts
- src/__tests__/settings-protocol.test.ts

Fixes:
- Dashboard file metadata now uses getDashboardFileStatus(), which checks settings/models/auth with existsSync/statSync only. auth.json is never read or parsed; malformed auth content cannot break dashboard metadata lookup. A malformed-auth regression test covers this.
- Removed obsolete codepi.importPiConfig manifest exposure, activation registration, runImportFlow import, and old first-run import prompt/import wording. Task 7 migration helpers remain unexposed in their source module.
- Dashboard JSON metadata paths use node:path.join.

Concerns:
- The webview build remains blocked by the old settings consumer and is intentionally deferred to Task 6.
- Existing unrelated dirty files and same-file changes were preserved and not staged.