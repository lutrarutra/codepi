Status: DONE

Commit:
- 7442a62 feat: rebuild CodePi settings dashboard

Tests/build:
- npm --prefix webview-ui run build — passed
- npm run build — passed
- npm run lint — passed
- npm test -- --run — passed (13 files, 107 tests)
- git diff --check — passed

Changed:
- Replaced old settings form/API/model/textarea UI with compact dashboard.
- Added Pi resource/package status, CodePi bundled-resource toggles, native VS Code JSON file buttons, refresh, sessions navigation, and per-machine/new-session notes.
- Deleted obsolete settings components.
- Fixed settings path helper to use node:path.join.
- Added runtime bundled-resource id validation before persistence.

Concerns:
- Native VS Code file-opening behavior still needs manual Extension Development Host verification.
- Existing unrelated dirty files/artifacts were preserved and not staged.

Report: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-6-report.md