# Task for reviewer

Review Task 4 for spec compliance and code quality. Read brief /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-brief.md, report /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-report.md, and diff package /home/lutrarutra/dev/codepi/.superpowers/sdd/review-3e20104..dab94b0.diff. Review read-only. Binding constraints: canonical executing-computer ~/.pi/agent before SDK use; CodePi sessions remain explicit VS Code globalStorage/sessions; normal user packages/resources load with noExtensions not true; bundled CodePi resources remain CodePi-only and obey explicit false; user/project extension precedence over bundled; shared SettingsManager; implicit nebula-pulse theme is non-persistent and explicit user theme wins; rpiv-todo path is agentDir-relative; preserve unrelated worktree changes. Check actual SDK semantics for DefaultResourceLoader/extensionsOverride/theme initialization and report any concrete issues by file:line. The obsolete legacy import prompt is expected to remain until Task 7; note it but do not treat that alone as a blocker. Do not run broad suites or mutate files. Return required verdict, strengths, issues by severity, and Task quality verdict. Do not create subagents.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-review.md
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