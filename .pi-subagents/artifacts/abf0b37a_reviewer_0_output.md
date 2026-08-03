## Review

### Required verdict
**PASS / attested.** The complete `3e20104..ccdec9b` package satisfies the Task 4 brief and the runtime-reload fix addresses the prior implicit-theme reload loss. I found no blocker or high-severity defect in the reviewed scope.

### Correct

- **Canonical roots are established before SDK use.** `activate()` computes the canonical `~/.pi/agent`, sets `PI_CODING_AGENT_DIR`, and creates it before any `getPi()`/SDK call (`src/extension.ts:173-178`). The runtime factory and `createAgentSessionRuntime` both use that same canonical `agentDir` (`src/extension.ts:1271-1279`, `src/extension.ts:1320-1324`).
- **Session storage is explicitly separate.** CodePi creates/opens/lists sessions using `getCodePiSessionDirForRuntime()` (`src/extension.ts:635-638`, `src/extension.ts:659-663`, `src/extension.ts:706-709`, `src/extension.ts:732-740`), while the Pi resource root is canonical. This avoids implicit/default session-root fallback.
- **Normal user resources remain enabled.** Loader options set `noExtensions: false` (`src/pi-runtime-config.ts:57-68`), and the actual loader receives those options plus canonical `agentDir` and shared settings manager (`src/extension.ts:1274-1282`). The SDK `DefaultResourceLoader` therefore retains its normal package/user/project discovery path.
- **Bundled resources are filtered and ordered deliberately.** CodePi policy selects resources in stable `BUNDLED_RESOURCES` order (`src/pi-store.ts:37-56`, `src/pi-store.ts:109-118`); the runtime filters non-existent bundled files (`src/extension.ts:1255-1260`) and resolves `rpiv-todo` below the supplied canonical agent root (`src/extension.ts:1261-1268`, `src/pi-runtime-config.ts:46-53`). `extensionsOverride` retains all base extensions but moves selected bundled entries to the end (`src/extension.ts:1282-1295`), preserving user/project order ahead of bundled collisions without manually filtering package resources.
- **One `SettingsManager` is shared.** The factory creates one manager using `opts.cwd` and canonical `agentDir`, then passes that exact object to both `DefaultResourceLoader` and `createAgentSession` (`src/extension.ts:1271-1282`, `src/extension.ts:1300-1308`).
- **Implicit theme is non-persistent and explicit themes win.** The helper only calls `applyOverrides` when the current setting is `undefined` and never invokes a persistence API (`src/pi-runtime-config.ts:109-118`). The initial application occurs after `await loader.reload()` (`src/extension.ts:1298-1299`), so the loader's settings reload cannot discard it. The tests cover the reload boundary and explicit user theme (`src/__tests__/pi-runtime-config.test.ts:44-67`, `src/__tests__/pi-runtime-config.test.ts:94-138`).
- **Later `AgentSession.reload()` is covered.** The wrapper reapplies the implicit theme inside the supported `beforeSessionStart` callback, after SDK settings/resource reload (`src/pi-runtime-config.ts:82-106`). Its enablement callback rebuilds policy from the current canonical settings file and current theme-file existence (`src/extension.ts:1310-1317`), so disabling/enabling the bundled theme is re-read rather than frozen at initial creation. The tests verify restoration, disabled behavior, and explicit-theme precedence across later reload (`src/__tests__/pi-runtime-config.test.ts:69-138`).
- **Caller callback is preserved.** The wrapper captures `options.beforeSessionStart`, invokes the CodePi override, then awaits the caller callback (`src/pi-runtime-config.ts:96-105`).
- **No unsafe SDK-internal patch was introduced.** The implementation uses the public `AgentSession.reload({ beforeSessionStart })` hook and wraps the session instance only to compose that supported callback (`src/pi-runtime-config.ts:82-106`); it does not patch SDK internals or persist a CodePi-only theme setting.
- **Legacy import remains intentionally deferred.** The old first-run import prompt/flow is still present (`src/extension.ts:279-304`), consistent with the brief/report's Task 7 ownership; Task 4 does not silently redesign migration.

### Fixed

- **Previous blocker verified resolved:** the implicit `nebula-pulse` override now runs after the initial loader reload and is reapplied after later `AgentSession.reload()` (`src/extension.ts:1298-1299`, `src/pi-runtime-config.ts:88-118`).

### Blocker

- None found.

### Note

- **Expected follow-up (not a Task 4 blocker):** legacy import UX/behavior still needs Task 7 treatment (`src/extension.ts:279-304`).
- **Residual verification:** the focused tests and typecheck validate wiring and policy, but actual VS Code extension-host startup/package loading remains an integration/manual check. No broad suite was run, per instruction.
- The reviewed commit package contains exactly `src/extension.ts`, `src/pi-runtime-config.ts`, and `src/__tests__/pi-runtime-config.test.ts`; unrelated working-tree changes/artifacts were not part of the reviewed package.

### Validation performed

- `npx vitest run src/__tests__/pi-runtime-config.test.ts src/__tests__/pi-store.test.ts` — **passed**, 2 files / 30 tests.
- `npx tsc -p ./tsconfig.json --noEmit` — **passed**, no output/errors.
- `git diff --check 3e20104..ccdec9b` — **passed**.
- Read-only inspection of the task brief, report, complete diff package, SDK `DefaultResourceLoader` and `AgentSession.reload` implementation, and session-storage call sites completed.

### Task quality verdict
**High quality / ready to accept.** The change is focused, typed, tested at the relevant pure seams, and aligns with the requested canonical-resource and reload lifecycle behavior. The remaining migration and integration notes are explicitly outside Task 4.