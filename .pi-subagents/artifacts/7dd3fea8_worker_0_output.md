Status: DONE_WITH_CONCERNS

Commit: dab94b0 feat: load canonical Pi resources in CodePi

Test summary: 4 Vitest files, 33 tests passed; TypeScript check passed; diff checks passed.

Concerns: The old legacy import prompt/import flow remains intentionally for Task 7 and must be replaced before release; it is now obsolete because canonical ~/.pi/agent is active. Existing unrelated dirty files/artifacts were preserved and not staged.

Report: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-report.md