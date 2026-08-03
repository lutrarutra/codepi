# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
You are implementing Task 4 of the approved canonical Pi resources/settings plan. Read this first — exact requirements: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-brief.md

Previous approved work: Task 1 added canonical/resource helpers; Task 2 added safe settings merge/file helpers; Task 3 routed CodePi sessions explicitly (commits 8a01240, 0a60c28, 3278734, 3e20104). Work in the current dirty checkout as authorized. Preserve unrelated existing changes and avoid reverting/reformatting outside this task. This is the key integration task: activate with canonical ~/.pi/agent, keep CodePi sessions in globalStorage/sessions, load normal user packages/resources (remove noExtensions:true), filter/order CodePi bundled extensions/theme based on canonical settings without persisting nebula-pulse, share SettingsManager with loader/session, and use canonical agentDir for rpiv-todo. Make minimal integration changes and focused tests/config extraction where practical. Follow TDD, run focused tests/typecheck, commit only your task changes as safely as possible, self-review, and write detailed report to /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-report.md. Do not create subagents. Return only status, commits, one-line tests, concerns, report path. If dirty same-file staging is unsafe, stop BLOCKED.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-worker-output.md
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