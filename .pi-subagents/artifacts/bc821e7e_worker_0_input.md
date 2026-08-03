# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Fix Task 3 review findings. Read /home/lutrarutra/dev/codepi/.superpowers/sdd/task-3-brief.md, /home/lutrarutra/dev/codepi/.superpowers/sdd/task-3-report.md, and /home/lutrarutra/dev/codepi/.superpowers/sdd/task-3-review.md.

Required fixes only:
1. Strengthen src/__tests__/extension-storage.test.ts so it verifies every persistent SessionManager call in src/extension.ts and src/views/session-tree.ts has the explicit CodePi session directory: create, all open calls, all list calls, and listAll. Use whitespace-normalized or otherwise formatting-insensitive matching; do not assert brittle exact line formatting.
2. Preserve the current dirty checkout's unrelated changes in src/views/session-tree.ts and src/__tests__/extension-storage.test.ts; only stage the test fix hunk(s) you own. Do not rewrite the pre-existing 2339a90 history or touch unrelated files.
3. Run the focused extension-storage/pi-store/resource-policy tests and tsc; append exact fix evidence to /home/lutrarutra/dev/codepi/.superpowers/sdd/task-3-report.md; commit only the test fix. Do not create subagents. Return only status, commit, tests, concerns, report path. If safe staging cannot isolate the fix, stop BLOCKED.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-3-fix-output.md
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