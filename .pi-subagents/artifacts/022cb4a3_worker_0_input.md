# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
You are implementing Task 8 of the approved canonical Pi resources/settings plan. Read exact requirements first: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-8-brief.md

Prior tasks established canonical ~/.pi/agent roots, dashboard backend/protocol/webview, and legacy migration. Task 8 owns package status and refresh. Work in the current dirty checkout as authorized; preserve unrelated files and same-file changes carefully. Add accurate Pi package status reporting to the dashboard (declared packages vs installed/available, missing package detection), and a refresh/install action that uses the SDK's DefaultPackageManager (or equivalent approved SDK API) to reconcile missing configured packages into the canonical ~/.pi/agent package store, keeping the dashboard UI consistent and error states visible. Match the approved plan/spec; if the brief is unclear read docs/superpowers/specs/2026-08-02-canonical-pi-resources-settings-design.md and docs/superpowers/plans/2026-08-02-canonical-pi-resources-settings.md. Follow TDD, run focused tests/typecheck/build, commit only owned changes as safely as possible, self-review, and write detailed report to /home/lutrarutra/dev/codepi/.superpowers/sdd/task-8-report.md. Do not create subagents. Return only status, commits, tests/build, concerns, report path. If safe staging is impossible, stop BLOCKED.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-8-worker-output.md
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