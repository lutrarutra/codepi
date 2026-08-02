## Review

- Correct:
  - `src/pi-store.ts:243-253` updates only `settings.codepi.bundledExtensions` and `settings.codepi.bundledThemes`, shallow-copies the existing `codepi` object, and preserves top-level Pi/unknown keys. The required package/default-model/unknown-key case is covered by `src/__tests__/pi-store.test.ts:80-101`.
  - `src/pi-store.ts:204-205` parses before producing a new value, so malformed JSON throws without reaching the write; `src/__tests__/pi-store.test.ts:133-143` verifies the original malformed bytes remain unchanged.
  - `src/pi-store.ts:154-160` uses a same-directory temporary file followed by rename, and `src/pi-store.ts:219-239` initializes missing settings/models/auth JSON as `{}`. Auth files are explicitly chmod'ed to `0600` at `src/pi-store.ts:225-233`; the focused test verifies this at `src/__tests__/pi-store.test.ts:127-131`.
  - The submitted package diff contains only `src/pi-store.ts` and `src/__tests__/pi-store.test.ts`; no activation, dashboard, or runtime wiring hunk is present in `8a01240..022a1c1`. The many other working-tree changes shown by `git status` are outside this package and were not touched by the commit.
  - Focused validation passed: `npx vitest run src/__tests__/pi-store.test.ts src/__tests__/pi-settings-store.test.ts` reported 23 passing tests. There is no `pi-settings-store.test.ts`; Vitest ran the existing `pi-store.test.ts` only.

- Fixed: none (review-only; no files were modified).

- Blocker:
  - **Concurrency guard does not meet the stated re-read/changed-file safety requirement.** `writeCodePiSettingsMerge` reads the JSON once at `src/pi-store.ts:203-205`, then only compares `exists`, `mtimeMs`, and `size` at `src/pi-store.ts:206-207` before writing at line 208. It neither re-reads the file immediately before the rename nor compares content. A concurrent writer can replace the file between the `statSync` check and `renameSync`, or can write different JSON with the same size/mtime (mtime granularity/coalescing), and this updater then overwrites that writer's settings. The documented “one retry against the newest file” is therefore not reliable. This is especially important because the brief explicitly requires a re-read, fail/retry-on-change strategy and calls out the concurrency guard as a binding safety constraint.

- Issue (medium):
  - The concurrency test is not a concurrency/retry test. `src/__tests__/pi-store.test.ts:145-153` performs one ordinary update and never causes a file change between the initial snapshot and the pre-write check. It cannot detect the guard's false-negative or retry behavior. Add a deterministic test seam (or injected read/stat/write hook) that changes the file during the update, then assert the latest Pi keys survive or the operation fails after the documented retry.
  - The new legacy-`fd` test does not put the fake binary where the implementation looks. The test creates `dir/fake-home/.pi/agent/bin/fd` at `src/__tests__/pi-store.test.ts:274-280`, while production code searches `homedir()` at `src/pi-store.ts:303-306`; it never changes `HOME`/mocks `homedir`, and only asserts that `bin` exists at lines 281-283. Thus the test passes even if the fd-copy loop is broken and does not test the behavior its title claims.

- Note:
  - The commit also adds `ensureDefaultTheme` and `ensureRuntimeTools` (`src/pi-store.ts:255-324`) plus their tests. They are not part of the brief's requested namespace merge/file-initialization API. They do not add wiring in this package diff, so this is scope creep rather than a direct activation/runtime violation; keeping them should require an explicit task boundary decision. In particular, `ensureDefaultTheme` uses an unguarded read/whole-file write at `src/pi-store.ts:266-274`, unlike the guarded CodePi merge path.
  - `ensurePiJsonFileInDir` only checks existence at `src/pi-store.ts:225`; an existing directory, symlink, or malformed settings/models file is returned rather than validated. This is not a failure of the explicitly tested “missing file” requirement, but callers should not assume the helper guarantees a valid JSON object for pre-existing paths.

## Verdict

- **Required spec verdict: NOT COMPLIANT pending a concurrency fix.** Namespace preservation, malformed-file non-overwrite, safe missing-file initialization, auth mode, and no wiring in the package diff are implemented and tested, but the required best-effort guard is only metadata-based and has a check-to-rename race.
- **Task quality verdict: Needs changes.** The core merge is readable and focused, but the central concurrency claim is stronger than the implementation, and the retry/fd tests do not exercise what they claim.