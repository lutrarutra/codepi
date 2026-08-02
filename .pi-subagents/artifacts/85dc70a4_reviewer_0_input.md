# Task for reviewer

Review Task 2 for spec compliance and code quality. Read the exact brief at /home/lutrarutra/dev/codepi/.superpowers/sdd/task-2-brief.md, report at /home/lutrarutra/dev/codepi/.superpowers/sdd/task-2-report.md, and diff package at /home/lutrarutra/dev/codepi/.superpowers/sdd/review-8a01240..022a1c1.diff. Review read-only. Binding constraints: safe CodePi namespace updates preserve unknown/package/settings data; malformed settings are not overwritten; JSON files are initialized safely; auth.json is mode 0600; no activation/runtime/dashboard wiring in this task; preserve unrelated working-tree changes. Pay special attention to the worker's best-effort concurrency guard and mixed pre-existing hunks. Do not run broad suites or mutate files. Return required spec verdict, strengths, issues by severity with file:line evidence, and Task quality verdict. Do not create subagents.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-2-review.md
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