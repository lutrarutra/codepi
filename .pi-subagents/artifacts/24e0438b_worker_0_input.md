# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
You are implementing Task 3 of the approved canonical Pi resources/settings plan. Read this first — exact requirements: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-3-brief.md

Task 1 provided getCodePiSessionDir in src/pi-store.ts; Task 2 provided persistence/file helpers. Work in the current dirty checkout as authorized, preserve unrelated existing changes, and do not revert/reformat outside Task 3. Route every CodePi SessionManager persistent operation to an explicit VS Code globalStorage/sessions directory. Be careful that the current src/extension.ts and src/views/session-tree.ts contain unrelated recent TUI work; make minimal call-site/constructor changes. Follow TDD, run focused tests/typecheck, commit only Task 3 changes as safely as possible, self-review, and write the detailed report to /home/lutrarutra/dev/codepi/.superpowers/sdd/task-3-report.md. Do not create subagents. Return only status, commits, one-line test summary, concerns, report path. If safe staging is impossible, stop BLOCKED and explain.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-3-worker-output.md
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