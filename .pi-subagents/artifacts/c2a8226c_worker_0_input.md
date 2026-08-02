# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
You are implementing Task 2 of the approved canonical Pi resources/settings plan. Read this first — it is your exact requirements: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-2-brief.md

Task 1 already added pure canonical/resource-policy helpers in src/pi-store.ts and commit 8a01240. Work in the current checkout as authorized; preserve all unrelated existing uncommitted changes and do not revert/reformat outside this task. Add safe CodePi namespace persistence and secure Pi JSON-file preparation helpers with focused TDD tests. Respect the approved decision that activation/runtime wiring is deferred to later tasks. Do not attempt Tasks 3-9. Commit only your task changes, self-review, and write the detailed report to /home/lutrarutra/dev/codepi/.superpowers/sdd/task-2-report.md. Do not create subagents. Return only status, commit(s), one-line test summary, concerns, and report path. If dirty-worktree staging cannot safely isolate your changes, stop BLOCKED.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-2-worker-output.md
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