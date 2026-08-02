Fixed Task 2 review findings.

Changed `writeCodePiSettingsMerge` to compare complete settings file content after the updater and immediately before atomic rename, retrying once against the latest content and failing without a write after repeated concurrent changes. Added a deterministic `beforeWriteCheck` test seam and test that injects a concurrent writer; the latest writer's keys are preserved on retry. Repaired the legacy fd-copy test by setting `HOME` to the fake home used by production `homedir()` and asserting copied contents plus executable mode.

Changed files:
- `src/pi-store.ts`
- `src/__tests__/pi-store.test.ts`

Validation:
- `npx vitest run src/__tests__/pi-store.test.ts src/__tests__/pi-resource-policy.test.ts` — 2 files, 28 tests passed.
- `npx tsc -p ./tsconfig.json --noEmit` — passed.

No runtime/dashboard/activation wiring was changed; that remains deferred per approved scope.

Concerns:
- The content check still cannot eliminate a writer racing between the final read and rename without an OS-level lock; it now meets the brief's required re-read/content-change detection and retry/fail behavior.