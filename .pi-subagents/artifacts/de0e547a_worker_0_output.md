Status: DONE

Commits:
- e0ce9c3 feat: migrate legacy CodePi storage safely
- 7981f5f refactor: remove obsolete legacy import helper

Tests:
- npx vitest run src/__tests__/legacy-migration.test.ts src/__tests__/pi-store.test.ts — passed (2 files, 24 tests)
- npm run lint — passed (TypeScript noEmit)
- npm run build — passed before final cleanup commit; final cleanup only removed obsolete helper/tests
- git diff --check — passed

Changed files:
- src/pi-store.ts
- src/extension.ts
- src/import-config.ts (deleted)
- src/__tests__/legacy-migration.test.ts
- src/__tests__/pi-store.test.ts

Concerns:
- VS Code Extension Development Host migration prompt behavior remains manual verification.
- Migration is copy-based and leaves legacy source intact by design.
- Canonical Pi sessions are never inspected or copied; only the explicitly supplied old CodePi session directory is migrated.

Report: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-7-report.md