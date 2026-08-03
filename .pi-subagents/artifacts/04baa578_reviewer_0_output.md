## Review

### Verdicts

- **Required spec verdict: COMPLIANT for commit `3278734` itself.** The Task 3 implementation routes the session directory explicitly at every inspected persistent call site, and the directory is `join(globalStoragePath, "sessions")`.
- **Diff-package verdict: NOT CLEAN / blocked for packaging.** The requested range `0a60c28..3278734` includes the unrelated ancestor commit `2339a90` and a large amount of unrelated source, resource, binary, and generated-artifact content. The four-file Task 3 commit is focused, but the supplied range is not a Task 3-only package.
- **Task quality verdict: Needs changes.** The implementation is small and coherent, but the source-level regression test does not comprehensively enforce the stated contract and is whitespace-sensitive.

### Correct

- `src/pi-store.ts:25-28` defines `getCodePiSessionDir(globalStoragePath)` as `<globalStoragePath>/sessions`, satisfying the required VS Code globalStorage session root and avoiding the canonical `~/.pi/agent/sessions` default.
- `src/extension.ts:180-186` computes the helper from `context.globalStorageUri.fsPath`, creates the directory recursively, and passes the resulting directory to `new SessionTreeProvider(...)`.
- All persistent extension call sites inspected in the committed file have an explicit session directory: restore/open at `src/extension.ts:214-218`, create at `src/extension.ts:635-638`, open at `src/extension.ts:659-663`, workspace list at `src/extension.ts:706-709` and `src/extension.ts:732-735`, and all-session lookup at `src/extension.ts:738-741`.
- `src/views/session-tree.ts:85-87` stores the constructor argument, and session-tree rename/open and listing pass it at `src/views/session-tree.ts:122` and `src/views/session-tree.ts:147`. There is no no-argument `SessionManager.listAll()` in the inspected `src` call sites.
- The Task 3 commit itself is appropriately narrow: `git show --stat 3278734` reports only `src/extension.ts`, `src/views/session-tree.ts`, `src/__tests__/extension-storage.test.ts`, and `src/__tests__/pi-store.test.ts` (68 insertions, 10 deletions). No `src/pi-store.ts` change was needed because the helper came from the earlier task.
- No files were modified by this review. `git status --porcelain=v2` showed no staged files; the existing tracked edits to `src/__tests__/extension-storage.test.ts` and `src/views/session-tree.ts`, plus untracked `.pi-subagents/artifacts/*`, remain untouched as required.

### Blocker

- **High — unrelated/staging-contaminated review package:** `git diff --stat 0a60c28..3278734` reports 62 files and `7105 insertions(+), 835 deletions(-)`, including `.pi-subagents/artifacts/*`, docs, fonts, bundled extensions/themes, webview terminal code, review/TUI rewrites, package metadata, and test deletions. `git show --stat 2339a90` identifies the source: the ancestor commit `2339a90` (message `hmm`) alone adds 59 unrelated files and `7040 insertions(+), 828 deletions(-)` before the four-file Task 3 commit. This violates the requested expectation that unrelated changes be preserved rather than included in the Task 3 package. The implementation commit is focused, but the supplied range must be split/cleaned or explicitly excluded before the package can be accepted as a Task 3 deliverable.

### Issues by severity

- **Medium — test coverage does not prove every persistent call has an explicit directory:** `src/__tests__/extension-storage.test.ts:20-31` asserts only that `listAll()` has no empty argument list, checks one formatting-specific `create` and `listAll` substring, and checks tree `list`/`open`. It does not assert the extension's restore/open calls (`src/extension.ts:214-218`, `:659-663`) or either `SessionManager.list` call (`:706-709`, `:732-735`) has the explicit directory. A future regression could remove the directory from those calls while this test still passes. The manual call-site inspection found the current implementation correct, but the test should use a call-site-aware regex/parser or explicit assertions for all required calls.
- **Low — source-level test is formatting brittle:** The test requires exact multiline whitespace at `src/__tests__/extension-storage.test.ts:22-23` and exact single-line tree calls at `:24-25`. In the current dirty checkout, the unrelated formatting-only edit in `src/views/session-tree.ts:167-172` wraps the tree `list` call, causing `npx vitest run src/__tests__/extension-storage.test.ts src/__tests__/pi-store.test.ts` to fail despite the call still passing `this.sessionDir`. Assertions should normalize whitespace or match the call semantically. This is a test-maintenance defect, not a session-routing defect in commit `3278734`.

### Validation

- Focused command run: `npx vitest run src/__tests__/extension-storage.test.ts src/__tests__/pi-store.test.ts` — **failed**: `src/__tests__/pi-store.test.ts` passed all 24 tests, while the source-level extension test failed only because the current uncommitted tree formatting no longer contains the exact string `SessionManager.list(this.cwd, this.sessionDir)`.
- Read-only diff inspection: `git show --stat 3278734`, `git diff --stat 0a60c28..3278734`, `git diff-tree --no-commit-id --name-status -r 3278734`, `git status --porcelain=v2`, and focused `rg` call-site inspection. No broad suite was run.
- The implementer report's claimed focused run and typecheck are not independently treated as proof of the current checkout state; the focused run above is the observed result under the preserved dirty worktree.

### Residual risks

- The broad `0a60c28..3278734` range cannot be safely reviewed as a Task 3-only change until the unrelated ancestor/staging content is separated.
- The current source-level test can produce false failures on harmless formatting and false passes for extension call sites it does not inspect.
- Manual inspection verified current `src` call sites, but no VS Code-host integration test verifies that activation initializes the directory before a command or serializer invokes a session operation.