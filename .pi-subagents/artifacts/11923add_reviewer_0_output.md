## Review

**Verdict: PASS WITH NON-BLOCKING ISSUES**

### Correct
- `src/pi-store.ts:367-417` implements the requested explicit four-path migration API. Config copying is limited to `settings.json`, `auth.json`, and `models.json`; existing canonical targets are skipped rather than overwritten (`:376-393`), and copied auth is normalized to owner-only `0600` (`:384-391`).
- The helper does not derive or inspect `<canonicalAgentDir>/sessions`; session input is an explicit `legacySessionDir` (`src/pi-store.ts:360-371`). The added regression test leaves a canonical Pi-session sentinel untouched (`src/__tests__/legacy-migration.test.ts:55-77`).
- Legacy CodePi sessions are copied only when the explicit new CodePi session directory is empty (`src/pi-store.ts:395-417`). A non-empty destination is preserved and reported as `destination-not-empty`; the corresponding test passes (`src/__tests__/legacy-migration.test.ts:79-98`).
- Activation uses the executing machine's canonical agent directory and a separate VS Code global-storage session directory before invoking the migration (`src/extension.ts:233-247`). The prompt is gated by `context.globalState` key `codepi.legacyMigrationPrompted.v1` (`src/extension.ts:125-153`) and explains the local/remote and canonical-session boundaries (`src/extension.ts:156-160`).
- The obsolete interactive import helper is deleted (`src/import-config.ts`), and its old force-overwrite tests/helper are removed from `src/__tests__/pi-store.test.ts`. No references to `runImportFlow` or `importLegacyConfig` remain in `src`.
- Focused validation passed: `npx vitest run src/__tests__/legacy-migration.test.ts src/__tests__/pi-store.test.ts` reported 24/24 tests passing. `git diff --check 12b3b3d..7981f5f` passed. The submitted task report also records the TypeScript/lint and build checks.

### Fixed
- None (review-only; no source files were modified).

### Blocker
- None found.

### Issues by severity
- **Medium — failed migration cannot be retried automatically:** `src/extension.ts:161` writes the one-time prompt marker before invoking `migrateLegacyCodePiStorage` at `:164-170`. If the user accepts and the copy fails (including a partial filesystem copy), the catch at `:180-184` reports the error but the next activation suppresses the prompt permanently. This leaves legacy data unmigrated and can also leave a non-empty partial session destination that prevents a subsequent idempotent attempt (`src/pi-store.ts:406-413`). The marker should be recorded after a successful migration, or a separate “prompted”/“migration completed” state should allow retry after failure.
- **Low — prompt text is inaccurate for sessions-only legacy data:** `src/extension.ts:156-160` always says “found settings from an older CodePi storage location,” but the prompt can also be triggered solely by old sessions (`:145-150`) with no legacy config files. The wording should describe “legacy CodePi storage/configuration or sessions” so the user is not told settings were found when only sessions exist.
- **Low — migration tests do not assert idempotent re-invocation:** The three tests cover missing-file copying, canonical-session isolation, and non-empty destination protection, but do not call the helper twice and verify no changes on the second call. The implementation appears idempotent for normal successful copies, but an explicit second-call assertion would protect this binding requirement.

### Residual risks
- No VS Code host-level test exercises the prompt decision, globalState persistence, or migration failure path. This is consistent with the task report's stated residual risk, but the Medium retry issue should be addressed before relying on migration in hostile/unreliable filesystem conditions.
- Session migration uses a direct recursive `cpSync` rather than a transactional staging/rename operation (`src/pi-store.ts:415`); a copy interruption can leave a partial destination. Combined with the marker ordering above, this is the principal operational risk.

### Task quality verdict
The task implementation is focused and substantially spec-compliant: it preserves canonical files, keeps CodePi sessions separate, does not inspect canonical Pi sessions, secures copied auth, and removes the obsolete import flow. Acceptable to proceed after addressing the retry/marker ordering concern; no blocker is present for the normal successful path.