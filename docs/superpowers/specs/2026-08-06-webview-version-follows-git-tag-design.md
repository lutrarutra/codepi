# Design: webview-ui version follows the git tag

Date: 2026-08-06

## Problem

The root `package.json` version follows the latest git tag (e.g. `v0.1.0` → `0.1.0`)
via the Makefile's `_sync-version` rule, which runs before `make vsix` / `make
install`. The UI package `webview-ui/package.json` (`codepi-webview`) is hardcoded
to `0.0.0` and never synced, so the two packages drift.

## Goal

`webview-ui/package.json` (and its lockfile) follow the same git tag as the root
package, so both are always on the same version.

## Approach (chosen: extend `_sync-version`)

Mirror the existing root sync inside the Makefile `_sync-version` rule:

1. After the root sync, run the same guarded sync for the webview package:
   `npm --prefix webview-ui version "$(GIT_VERSION)" --no-git-tag-version
   --allow-same-version` — only when a valid semver tag exists and differs from
   the current webview version. npm updates `webview-ui/package-lock.json`
   automatically.
2. `make version` prints both the root effective version and the webview-ui
   package version, so alignment is easy to verify.
3. Update the Makefile header comment to mention both packages.

Rejected alternatives:

- **Standalone script** (`scripts/sync-version.mjs`): more flexible but adds a
  file and indirection for two shell lines; diverges from the existing pattern.
- **Build-time derivation (vite define)**: leaves `package.json` at `0.0.0` and
  doesn't touch the lockfile; sidesteps the ask instead of satisfying it.

## Non-goals

- No runtime/display changes — nothing reads the webview version in code.
- No new checks (CI/dev-mode version-mismatch guards) — not requested.
- The working-tree modification to `patches/…0.83.0.patch` is unrelated and left
  untouched.

## Next steps

- Implementation plan (writing-plans skill)
- Verification: `make version` shows aligned versions; `make _sync-version`
  bumps `webview-ui/package.json` + lockfile `0.0.0` → `0.1.0` (matching tag
  `v0.1.0`); no regression to root sync when no tag / invalid tag present.
