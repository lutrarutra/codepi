# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Fix the Task 4 blocker. Read /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-brief.md, /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-report.md, and /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-review.md first.

Required fix:
- In the runtime factory, ensure the implicit CodePi-only nebula-pulse theme override is applied after DefaultResourceLoader.reload() (which calls SettingsManager.reload() and otherwise erases applyOverrides), while preserving explicit user theme precedence and never persisting the override.
- Add a focused regression test in src/__tests__/pi-runtime-config.test.ts using a deterministic mocked/reload-like settings manager or pure helper that proves the effective implicit theme is reapplied after the loader reload boundary. Do not require a broad VS Code host test.
- Remove the unused duplicate defaultRuntimeResourceConfig helper if it is genuinely unused, or use the canonical policy helper instead; keep the implementation DRY.

Do not address the legacy import prompt (Task 7 owns it), do not broaden scope, and preserve unrelated dirty worktree changes/artifacts. Re-run covering tests (`src/__tests__/pi-runtime-config.test.ts` plus relevant pi-store/resource/session tests) and tsc; append exact fix evidence to /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-report.md; commit only the fix changes. Do not create subagents. Return only status, commit(s), one-line tests, concerns, and report path. If safe staging cannot isolate the fix, stop BLOCKED.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-fix-output.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```