# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Fix Task 2 review findings in the current checkout. Read the existing task brief /home/lutrarutra/dev/codepi/.superpowers/sdd/task-2-brief.md, implementer report /home/lutrarutra/dev/codepi/.superpowers/sdd/task-2-report.md, and reviewer report /home/lutrarutra/dev/codepi/.superpowers/sdd/task-2-review.md first.

Required fixes:
1. Correct writeCodePiSettingsMerge's concurrency safety to satisfy the brief: re-read current settings immediately before the write/rename, detect content changes (not only mtime/size), and retry once or fail without overwriting newer Pi settings. Preserve unrelated keys and keep atomic same-directory writes.
2. Add a deterministic test seam/test that actually changes settings between the initial read and pre-write check and proves the latest writer is preserved or the operation fails safely after the documented retry.
3. Repair the legacy fd-copy test so it mocks/sets the home path the production code actually reads, and assert the copied fd behavior rather than only bin directory existence.

Do not broaden scope or revert unrelated dirty-worktree changes. Preserve the approved decision that activation/runtime/dashboard wiring is deferred. Re-run the covering tests and tsc, append a fix report with exact commands/results to /home/lutrarutra/dev/codepi/.superpowers/sdd/task-2-report.md, and commit only the fix changes. Do not create subagents. Return only status, commit(s), one-line tests, concerns, and report path. If safe staging is impossible, stop BLOCKED.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-2-fix-output.md
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