# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
You are implementing Task 6 of the approved canonical Pi resources/settings plan. Read exact requirements first: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-6-brief.md

Task 5 already replaced the settings backend with the compact dashboard protocol (commands settings:get/setBundledResource/openFile/refresh/openSessions, credential-free DashboardData) and removed old form/save/import routes; the old webview consumer now fails to build. Work in the current dirty checkout as authorized; preserve unrelated files and same-file changes carefully. Rewrite the settings webview as the compact dashboard consuming the Task 5 protocol: Pi resources/package status card, CodePi defaults toggles, Pi files buttons opening real settings/models/auth in VS Code, refresh, sessions navigation, explicit note that toggles apply to new sessions and settings are per execution machine. Remove obsolete settings form/textarea components and CSS; build the webview successfully. While in these files, also address the two recorded Task 5 P2 items in the backend: use node:path.join for the settings path helper in settings-view.ts, and reject unknown bundled-resource ids before persisting toggles. Follow TDD where practical, run webview build + root lint/tests, commit only owned changes as safely as possible, self-review, and write detailed report to /home/lutrarutra/dev/codepi/.superpowers/sdd/task-6-report.md. Do not create subagents. Return only status, commits, tests/build, concerns, report path. If safe staging is impossible, stop BLOCKED.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-6-worker-output.md
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