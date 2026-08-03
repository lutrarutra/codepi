# Task for reviewer

Review Task 7 for spec compliance and code quality. Read brief /home/lutrarutra/dev/codepi/.superpowers/sdd/task-7-brief.md, report /home/lutrarutra/dev/codepi/.superpowers/sdd/task-7-report.md, spec docs/superpowers/specs/2026-08-02-canonical-pi-resources-settings-design.md, plan docs/superpowers/plans/2026-08-02-canonical-pi-resources-settings.md, and diff package /home/lutrarutra/dev/codepi/.superpowers/sdd/review-12b3b3d..7981f5f.diff. Review read-only. Binding constraints: one-time migration of legacy <globalStorage>/agent config into canonical ~/.pi/agent only when canonical files absent; legacy CodePi sessions copied once into new globalStorage/sessions when destination empty; never touch/inspect ~/.pi/agent/sessions; context.globalState one-time prompt marker; copy-based/idempotent; secure auth handling; obsolete import flow removed cleanly; no unrelated changes. Do not run broad suites or mutate files. Return required verdict, strengths, issues by severity with file:line, and Task quality verdict. Do not create subagents.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-7-review.md
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