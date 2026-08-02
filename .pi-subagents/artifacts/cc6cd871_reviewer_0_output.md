## Review

### Spec Compliance verdict
**PARTIAL / NOT COMPLIANT with the complete Task 1 brief.** The new pure primitives are implemented correctly and the focused tests pass, but the brief explicitly requires activation to set the runtime agent directory to `getCanonicalAgentDir()`. The current activation code still redirects Pi to VS Code global storage's `agent` directory. Consequently, the canonical path and CodePi session-storage policy are not effective in the running extension.

- **Blocker:** `src/extension.ts:157-162` still computes `path.join(context.globalStorageUri.fsPath, "agent")` and calls `setAgentDir(agentDir)`. This violates the binding constraint that the executing computer's `~/.pi/agent` is canonical and contradicts Task 1's Step 3 instruction to make activation set `getCanonicalAgentDir()`. The new `getCanonicalAgentDir()` export is therefore unused by activation.
- **Major residual integration issue:** Because activation still sets the old agent directory, the existing session calls continue to use the wrong/default session location. For example, `src/extension.ts:621` calls `SessionManager.create(workspaceRoot)` and `src/extension.ts:642-646` calls `SessionManager.open(sessionPath, undefined, workspaceRoot)`; `src/extension.ts:689`, `:712-716` omit the explicit CodePi session directory as well. `src/views/session-tree.ts:122` and `:147` do the same. The required `getCodePiSessionDir(globalStoragePath)` primitive is not consumed anywhere in the changed package or current runtime. This may be deferred to the subsequent session-wiring task, but it remains a concrete risk against the stated binding constraint.
- **Major residual integration issue:** The parser honors explicit `false`, but no runtime consumer uses `readBundledResourceConfig()` or `getEnabledBundledResources()` (`src/pi-store.ts:72-118` are the only implementations/usages). `src/extension.ts:1247-1281` unconditionally passes both bundled extension paths and the bundled theme to the loader. Thus a persisted false toggle would not affect actual resource loading yet. The implementer report acknowledges this as deferred; it should not be mistaken for end-to-end compliance.
- **Major residual policy issue:** `src/extension.ts:164-166` still calls `ensureDefaultTheme()`, and `src/pi-store.ts:167-184` documents/writes `theme: "nebula-pulse"` into `settings.json`. With canonical `~/.pi/agent` settings, this would persist the CodePi-only theme name into settings the Pi CLI can read, contrary to the broader spec's CodePi-only theme rule. This is pre-existing/outside the two-file diff, but must be addressed by the later runtime integration work.

### Correct
- `src/pi-store.ts:20-23` implements `getCanonicalAgentDir()` as `join(homedir(), ".pi", "agent")` without consulting the env override, matching the required pure helper semantics.
- `src/pi-store.ts:25-28` implements `getCodePiSessionDir(globalStoragePath)` as `join(globalStoragePath, "sessions")`.
- `src/pi-store.ts:30-56` provides stable metadata for all three required resources (`custom-footer`, `filechanges`, and `nebula-pulse`) with ids, labels, kinds, and enabled-by-default state.
- `src/pi-store.ts:58-107` uses a typed config shape, treats missing values as enabled, accepts explicit booleans including `false`, ignores malformed/non-record child values and non-boolean toggles, and does not throw for malformed input. Unknown keys are naturally ignored.
- `src/pi-store.ts:109-118` provides an enabled-resource result suitable for later consumers and returns copies rather than exposing the metadata array's object references.
- `src/__tests__/pi-resource-policy.test.ts:11-20` covers both path helpers; `:23-44` covers stable metadata; `:47-65` covers defaults plus explicit-false/malformed handling.
- Focused validation passed: `npx vitest run src/__tests__/pi-store.test.ts src/__tests__/pi-resource-policy.test.ts` reported 2 files and 22 tests passed. The implementer also reports `npx tsc -p ./tsconfig.json --noEmit` passed.
- `git diff --check 754da72..8a01240` passed, and the review package is limited to the intended new policy test plus `src/pi-store.ts`. No staged files were present; unrelated worktree changes were not modified.

### Fixed
- None. This was a read-only review and the checkout was not mutated.

### Task quality verdict
**GOOD for the pure-helper portion; INCOMPLETE for the explicit activation requirement and end-to-end policy behavior.** The implementation is small, readable, and focused, with useful tests. The report is accurate in noting that runtime/dashboard wiring is deferred, but that deferral leaves the canonical activation requirement in the brief unmet in the current state. The test suite also does not exercise `getEnabledBundledResources()` itself, nor does it test explicit `true`/malformed top-level variants independently; these are coverage improvements rather than proven defects.

### Residual risks
- Canonical resources remain redirected to `<globalStorage>/agent` until activation is changed.
- Session APIs remain capable of resolving sessions below the wrong Pi agent directory because the explicit CodePi session directory is not passed.
- Bundled toggles currently affect only a pure parser; runtime loading remains unconditional.
- The existing default-theme persistence path can write a CodePi-only theme name into canonical Pi settings once canonical activation is enabled.