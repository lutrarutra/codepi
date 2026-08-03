# Task for reviewer

Re-review Task 7 after the retry/marker fix. Read brief /home/lutrarutra/dev/codepi/.superpowers/sdd/task-7-brief.md, updated report /home/lutrarutra/dev/codepi/.superpowers/sdd/task-7-report.md, and diff package /home/lutrarutra/dev/codepi/.superpowers/sdd/review-7981f5f..3f0f899.diff. Review read-only. Verify: completion marker recorded only after successful migration so failures/declines retry on next activation; sessions-only prompt wording accurate; idempotence test asserts no second-invocation changes; prior Task 7 constraints still hold (canonical-preserving config copy, empty-destination session copy only, never touches ~/.pi/agent/sessions, secure auth, obsolete import flow removed, no unrelated changes). Do not run broad suites or mutate files. Return required verdict, strengths, remaining issues by severity with file:line, and Task quality verdict. Do not create subagents.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-7-rereview.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

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