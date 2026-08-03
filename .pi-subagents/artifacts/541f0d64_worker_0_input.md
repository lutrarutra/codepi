# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Complete Task 8 review follow-ups. Read /home/lutrarutra/dev/codepi/.superpowers/sdd/task-8-brief.md, /home/lutrarutra/dev/codepi/.superpowers/sdd/task-8-report.md, and /home/lutrarutra/dev/codepi/.superpowers/sdd/task-8-review.md.

Required:
1. Add the plan-required fake-agent package status test: create a temp fake agent directory/settings with one installed and one missing package source, instantiate SettingsManager/DefaultPackageManager with canonical agentDir (as settings-view.ts does), run status collection, and assert counts/missing names; also assert the collection does not perform network installation (e.g., verify only settings/installed-path reads happen, or that a missing package remains missing after collection).
2. Add a behavior-level test proving new-session runtime factories re-read settings/toggles: create a runtime with one toggle state, change settings.json, create a second runtime, and assert the second runtime's effective bundled-resource paths differ per the new state (no activation-time snapshot).
3. Revert the unrelated formatting-only hunk in src/settings-view.ts:152-157 if it can be cleanly isolated without touching owned logic; otherwise leave and report.

Preserve unrelated dirty files and same-file changes; do not rewrite history; keep scope narrow. Run focused settings-protocol/pi-runtime-config/pi-store tests plus lint; append exact evidence to /home/lutrarutra/dev/codepi/.superpowers/sdd/task-8-report.md; commit only owned changes. Do not create subagents. Return only status, commits, tests, concerns, report path. If safe staging is impossible, stop BLOCKED.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-8-fix-output.md
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