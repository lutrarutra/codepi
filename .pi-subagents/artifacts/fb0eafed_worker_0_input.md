# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Resolve the remaining Task 4 review finding before acceptance. Read /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-brief.md, /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-report.md, and /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-rereview.md.

Requirement: the implicit CodePi-only nebula-pulse theme must be reapplied after every SettingsManager/resource-loader reload, not only initial runtime creation. Pi AgentSession.reload() calls SettingsManager.reload() and ResourceLoader.reload(), so implement a focused central hook/wrapper/helper that preserves explicit user themes, reads current bundled-resource enablement after reload where appropriate, applies the override in memory only, and does not persist it. Avoid unsafe broad monkey-patching if a clean existing SDK hook is available; keep the change compatible with the current 0.80.1 SDK and existing runtime architecture.

Add a deterministic regression test that models the later reload path and proves the implicit theme returns after settings reload, while explicit user theme and disabled bundled theme remain respected. Do not address legacy import (Task 7), dashboard (Tasks 5-8), or unrelated changes. Preserve the dirty checkout. Re-run covering pi-runtime-config/resource/session tests and tsc; append exact fix evidence to /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-report.md; commit only the fix. Do not create subagents. Return only status, commit(s), tests, concerns, report path. If the required hook would require an unapproved SDK patch or unsafe behavior, stop NEEDS_CONTEXT with evidence.

---
**Output:**
Write your findings to exactly this path: /home/lutrarutra/dev/codepi/.superpowers/sdd/task-4-reload-fix-output.md
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