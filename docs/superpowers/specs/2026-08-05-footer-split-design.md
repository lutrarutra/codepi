# Design: Two-row responsive codepi footer

**Date:** 2026-08-05
**Status:** Approved (design review)
**Scope:** `resources/extensions/codepi-footer.ts` + `resources/extensions/__tests__/codepi-footer.test.ts` only.

## Problem

The codepi footer renders a single line: `left │ right` (left = token/cost/context stats, right = mode badge, model, thinking level, bash badge, git branch), with the right side right-aligned via padding. When the combined content exceeds the terminal width, `truncateToWidth` cuts the tail — the **right side collapses with `...`** and its information (git branch, bash mode, thinking level, model) is lost.

## Goal

Keep the single-line layout when everything fits. When it does not fit, **split into two rows** instead of truncating: left on top, right below. Both rows keep the existing 1-cell side margins.

## Behavior

### Fit check

After building `left` and `right` exactly as today:

- **Fits** (`visibleWidth(left) + visibleWidth(midSep) + visibleWidth(right) <= innerWidth`): render exactly as today — one line, `left │ right`, right side right-aligned via padding, `truncateToWidth` no longer needed in this path.
- **Does not fit**: return two rows.

### Split layout

```
  ↑1.2k │ ↓3.4k │ 🧠 567 │ $0.003 │ 25%/200k
                            🛡 ask/allow • claude-x • ● high •  main
```

- **Row 1**: left content, flush left.
- **Row 2**: right content, **right-aligned** to `innerWidth` (bottom row keeps its edge position, mirroring single-line mode).
- The `│` mid-separator appears only in single-line mode.
- Each row keeps the 1-cell left margin and trailing pad to the terminal edge (preserves the existing inset look: `line.startsWith(" ") && line.endsWith(" ")`).

### Per-row truncation fallback

If a single row alone exceeds the window (very narrow terminal), that row is truncated with `...` — last resort only. In split mode the right side is otherwise **never** collapsed; its content is always preserved.

If the right side is empty (no mode/model/level/branch parts), the footer never splits: a right-less footer falls back to single-row truncation exactly as today (no empty second row).

## Non-goals

- No hysteresis: resizing exactly at the boundary flips between 1 and 2 rows. Accepted — matches the built-in footer's simplicity.
- No stat dropping / priority-based compaction (approach B was considered and rejected).
- No always-two-rows mode (approach C rejected — wastes a row in wide windows).
- No config setting; the split is purely width-driven.

## Technical notes

- The SDK footer API `render(width: number): string[]` supports multiple rows natively — the built-in footer already returns up to 3 lines (`pwd`, stats, extension statuses), and the footer container in interactive-mode's VStack measures the returned line count. No layout plumbing changes needed.
- `innerWidth = width - 2` (1-cell margin each side), `MARGIN = 1`.
- `truncateToWidth(text, maxWidth)` (from `@earendil-works/pi-tui`) keeps its `...` default; used only for the per-row fallback.

## Testing

New tests in `resources/extensions/__tests__/codepi-footer.test.ts`:

1. **Wide render → single line**: `render(400)` returns exactly 1 line containing both left and right segments.
2. **Narrow render → two rows, right side intact**: at a width where the combined content overflows, `render()` returns 2 lines; row 0 contains the left stats; row 1 contains the right segments (mode badge, model, level, branch) **without** `...` truncation.
3. **Bottom row right-aligned**: row 1's leading padding width equals `innerWidth - visibleWidth(right)`.
4. **Ultra-narrow → per-row truncation**: at a width where even one row alone overflows, that row is truncated and ends with `...`.
5. **Margins preserved**: both rows start with a leading space and end with a trailing space.

Existing 11 footer tests remain green: they destructure only row 0, and their wide renders (200/400) still produce a single line. The existing "truncates the footer to the terminal width" test at `render(40)` now produces 2 rows; its assertion (`line[0].length <= 80`) still holds and may be extended to assert the two-row split.

## Files touched

- `resources/extensions/codepi-footer.ts` — the render change only.
- `resources/extensions/__tests__/codepi-footer.test.ts` — new split-behavior tests.
