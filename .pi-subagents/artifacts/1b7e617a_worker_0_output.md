Status: DONE

Commit: 225c293 docs: document canonical Pi resources and CodePi sessions

Tests/build:
- npx tsc -p ./tsconfig.json --noEmit — passed
- npx tsc -p ./webview-ui/tsconfig.json --noEmit — passed
- npm run lint — passed
- npm test -- --run — passed (14 files, 108 tests)
- npm run build — passed (webview and extension production builds)
- dist/extension.js and webview-ui/dist/assets/settings.js exist
- git diff --check — passed

Changed files:
- README.md
- src/pi-store.ts
- src/__tests__/pi-store.test.ts

Implementation:
- README documents canonical current-computer ~/.pi/agent resources/packages, optional Pi CLI, separate VS Code global-storage sessions, Remote-SSH isolation, package synchronization, dashboard/native JSON settings, CodePi-only bundled defaults/toggles, package status, and legacy migration.
- Targeted audit found obsolete ensureDefaultTheme()/DEFAULT_THEME persistence code, which still encoded writing nebula-pulse into shared settings.json. Removed that helper and its persistence tests; runtime in-memory applyOverrides behavior remains covered.
- No stale settings save/import routes, noExtensions true, or implicit SessionManager.listAll() calls remain outside intentional audit matches.

Audits:
- rg obsolete-pattern audit passed with only intentional migration globalStorageUri/agent and in-memory/theme test matches.
- Additional canonical-root/session/default-theme audits passed.

Concerns:
- Extension Development Host/native JSON editor behavior and Remote-SSH/multi-home isolation remain manual checks not available in this shell.
- Existing unrelated dirty files and .pi-subagents/artifacts were preserved and remain unstaged.

Report: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-9-report.md