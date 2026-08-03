# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Fix Task 7 review findings. Read /home/lutrarutra/dev/codepi/.superpowers/sdd/task-7-brief.md, /home/lutrarutra/dev/codepi/.superpowers/sdd/task-7-report.md, and /home/lutrarutra/dev/codepi/.superpowers/sdd/task-7-review.md.

Required fixes:
1. (medium) Failed accepted migrations must be retryable: do not record the completion marker (or make the marker state distinguish prompted vs completed) so that a failed/partial migration still prompts on the next activation; a successful migration suppresses future prompts. Consider marking completion only after migrateLegacyCodePiStorage succeeds; keep the user-notified semantics sane (e.g., marker set after success; failure leaves marker unset so prompt returns).
2. (low) Fix prompt wording so sessions-only legacy data is described accurately (legacy storage/configuration OR sessions), not always "found settings".
3. (low) Add an idempotence regression test: invoke migration twice on the same inputs and assert the second invocation makes no changes.

Preserve unrelated dirty files and same-file changes; do not rewrite history; do not broaden scope. Run focused legacy-migration/pi-store tests plus lint; append exact fix evidence to /home/lutrarutra/dev/codepi/.superpowers/sdd/task-7-report.md; commit only owned fixes. Do not create subagents. Return only status, commits, tests, concerns, report path. If safe staging is impossible, stop BLOCKED.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-7-fix-output.md
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