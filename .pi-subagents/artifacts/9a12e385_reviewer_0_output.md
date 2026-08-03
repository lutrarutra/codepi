## Review

### Spec verdict
**Pass.** The Task 3 fix addresses both prior findings:

- The production call-site inventory is complete. A direct `rg` over `src` found 8 persistent calls: extension `create` (1), `open` (2), `list` (2), `listAll` (1), plus session-tree `open` (1) and `list` (1). The calls shown in `src/extension.ts:214,635,659,706,732,738` and `src/views/session-tree.ts:143,170` all pass an explicit runtime/session directory.
- The updated source-level test normalizes whitespace at `src/__tests__/extension-storage.test.ts:5-7`, so line breaks, indentation, and spacing no longer affect matching. It separately counts call sites and verifies their argument patterns at lines 30-87.
- The focused regression test passes: `npx vitest run src/__tests__/extension-storage.test.ts` reported 1 file and 1 test passed.

### Correct
- `src/extension.ts:214` restores sessions with `SessionManager.open(sessionPath, getCodePiSessionDirForRuntime(), getWorkspaceRoot())`.
- `src/extension.ts:635-639` creates sessions with the workspace root and explicit CodePi directory.
- `src/extension.ts:659-664` opens sessions with the explicit directory and workspace root.
- `src/extension.ts:706-710` and `:732-736` list workspace sessions with the explicit directory; `:738-740` calls `listAll` with it as well.
- `src/views/session-tree.ts:143` passes `this.sessionDir` to rename/open and `:170-173` passes it to workspace listing.
- Activation initializes and creates the directory before provider/session use at `src/extension.ts:182-186`.
- The fix commit is narrowly scoped to `src/__tests__/extension-storage.test.ts`; it does not introduce unrelated production changes. `git diff --check 3278734..3e20104` passes.

### Fixed
- **Medium (prior finding):** persistent production call-site coverage is now enforced by call counts plus argument assertions for every currently present extension and session-tree call. The current source inventory agrees with those expected counts.
- **Low (prior finding):** formatting-sensitive literal substring checks were replaced by whitespace normalization plus regular-expression matching. The updated test passed against the current formatting.

### Remaining issues by severity
- **Blocker:** None found.
- **Medium:** None found.
- **Low:** None found.

### Residual risks
The test remains intentionally source-level rather than runtime/mocked SDK coverage, because the VS Code extension host cannot be imported by the current Vitest setup (as documented in the test comment). Its exact call-count assertions are somewhat coupled to the current call-site inventory, but that coupling is useful here: an added or removed production call causes the test to fail and prompts an explicit review. The report's broader focused Vitest run (30 tests across 3 files) and TypeScript check are recorded as passed in `task-3-report.md`; this re-review ran only the requested focused routing test and did not run broad suites.

### Task quality verdict
**Good / accepted.** The fix is minimal and directly resolves the medium and low findings. The regression test now checks all known production persistent calls and is insensitive to formatting whitespace. No additional change is required for Task 3.