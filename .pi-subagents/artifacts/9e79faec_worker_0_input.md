# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Fix Task 5 review blockers. Read /home/lutrarutra/dev/codepi/.superpowers/sdd/task-5-brief.md, /home/lutrarutra/dev/codepi/.superpowers/sdd/task-5-report.md, and /home/lutrarutra/dev/codepi/.superpowers/sdd/task-5-review.md.

Required fixes:
1. In settings dashboard data, determine auth.json existence/path metadata with fs.existsSync/statSync only; never read or parse auth.json, and ensure malformed/unreadable auth does not break settings:get/refresh. Add a focused test or pure helper test that proves auth contents are not passed through the dashboard data and malformed auth cannot cause a parse failure.
2. Remove the obsolete user-facing `codepi.importPiConfig` command/manifest exposure and old import handler/import wording from extension activation/settings backend. Preserve only a non-exposed migration seam for Task 7 if genuinely needed; do not implement Task 7 migration now. Update package.json only for the command removal, preserving unrelated manifest changes.
3. Use path.join for dashboard file metadata paths rather than manual separators.

Preserve unrelated dirty files and same-file changes. Do not rewrite history. Run focused settings-protocol/pi-store tests and tsc/lint; append exact fix evidence to /home/lutrarutra/dev/codepi/.superpowers/sdd/task-5-report.md; commit only owned fixes. Do not create subagents. Return only status, commits, tests, concerns, report path. If safe staging is impossible, stop BLOCKED.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-5-fix-output.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Review gate: required by reviewer.

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
    },
    {
      "id": "criterion-2",
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