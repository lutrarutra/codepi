# TL;DR Activity Line: readable live state (tool name + spinner, one-line thoughts)

**Status:** Plan — approved design decisions, not yet implemented
**Date:** 2025-XX-XX
**Scope:** `CompactTurnSummary` in the pi dist patch + its tests. No changes to
`resources/extensions/codepi-tldr.ts` (it only flips compact mode on/off).

## Background

In TL;DR mode, each turn renders as a `CompactTurnSummary` row:

```
⠋ ✓11 ✗1 tools · ↑12.3k ↓4.5k 󰟶 1.2k · $0.42 · 32s · model   ← stats row (TruncatedText, 1 row)
latest thought / tool call (muted)                              ← activity line (plain Text — wraps)
```

The component lives in the pi dist patch:

- `patches/@earendil-works+pi-coding-agent+0.83.0.patch` (source of truth, committed)
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/compact-summary.js` (working copy, gitignored — tests import it directly)

### Current problems (verified in the dist)

1. **Activity line is a plain `Text`** (`new Text("", 2, 0)`) — it wraps to a
   second row when content exceeds terminal width. The stats row already uses
   `TruncatedText` for exactly this reason; the activity row doesn't.
2. **Updates on every streaming event**: `addThinkingDelta` fires per
   `thinking_delta` (word-by-word), `notePartialResult` fires per
   `tool_execution_update` — the muted line rushes by, unreadable.
3. **Tool-running shows name + first arg** (`summarizeToolCall`: e.g.
   `bash ls -la /very/long/path`) and gets overwritten by the tool's streaming
   output (`notePartialResult`) — no spinner anywhere on the activity line.
4. **Spinner only exists on the stats row** (accent, first char, live turns only).

## Target behavior (user-approved)

| State | Activity line |
| --- | --- |
| Tool running | `⠋ bash ls -la /very/long/path…` — tool **name + primary parameter**, collapsed to one line with `...`; no streaming output |
| Thinking | `⠋ current thought…` — first line of the current thought, clipped to **one row** with `...`, spinner on the same row |
| Turn live, no activity yet | `⠋` alone (spinner only) |
| Turn finished | static muted text, no spinner (unchanged from today) |

**Refresh policy (final, user-approved): 1.5 s sampling.** A change of
activity kind (thought ↔ tool) shows immediately; refreshed text of the
same activity (a streaming thought, or a newer tool call while another
runs) is sampled at most once per 1.5 s, showing the newest content at
check time. If nothing new arrived since the last display (e.g. a tool
that is taking a while), nothing is updated — the spinner keeps animating
at 80 ms regardless. Streaming tool output is ignored entirely.

- **Single spinner total**: the spinner moves to the activity line; the stats
  row becomes a stable record while live (counts, tokens, cost, ticking
  elapsed). No double animation.
- **Never wraps**: the activity line becomes a `TruncatedText` — guaranteed one
  terminal row; `truncateToWidth` appends `...` automatically when clipped.
- Persisted/finished turns keep `summarizeToolCall` (name + arg) for the
  static record — the "name only" rule applies to the live indicator.

## Design — changes to `compact-summary.js`

### 1. Activity line becomes `TruncatedText`

- Replace `this.activityLine = new Text("", 2, 0)` with
  `new TruncatedText("", 2, 0)` (same 2-col indent; `render(width)` clips to
  `width - 4`, never emits a second row, appends `...` when truncated).
- Remove the now-unused `Text` import (line 9 keeps `Container, TruncatedText`).

### 2. Spinner moves to the activity line

- `getStatsText()`: delete the `if (!this.finished) parts.push(spinnerFrame)`
  block — the stats row no longer carries the live spinner.
- `updateStatsLine()` builds the live activity text as
  `safeThemeFg("accent", SPINNER_FRAMES[frame]) + " " + safeThemeFg("muted", text)`
  when the turn is live; plain muted text when finished (today's behavior).
- The existing 80 ms interval keeps driving frames + elapsed + re-renders.

### 3. Tool-running state: name + spinner only

- `noteToolCall(name, args, id)`: dedupe by id and bump `toolsRunning` exactly
  as today; additionally store `this.runningToolName = name` (most recently
  started wins when several run concurrently). Do **not** call
  `summarizeToolCall` — args are dropped for the live line.
- `notePartialResult(partial)`: **suppressed while `toolsRunning > 0`** — no
  activity update (kills the output-streaming flicker). Keep the method (the
  interactive-mode calls it); it just no-ops during a run.
- `toolEnded(...)`: decrement/counters as today, clear `runningToolName`; then
  flush a pending thought if one arrived during the run, else clear the line
  (spinner alone).

### 4. Activity sampling: one line + 1.5 s refresh

- `addThinkingDelta(delta)`: append to the 600-char rolling buffer and set
  `pendingThought = { kind: "thought", text: firstLineOf(buffer) }` (newest
  wins) — display update happens via `maybeUpdateActivity()`.
- `maybeUpdateActivity()` (called from every event handler and the 80 ms
  spinner tick): the effective newest activity is the running tool name when
  a tool runs, else the newest thought. Kind changes (thought ↔ tool) show
  immediately; same-kind refreshes are gated on
  `Date.now() - lastDisplayAt >= ACTIVITY_REFRESH_INTERVAL_MS` (1500). The
  displayed `latestActivity` snapshot is what the row renders — live state
  only feeds the sampler.
- `notePartialResult`: no-op — output is never shown ("ignore everything
  else").
- Result: spinner animates smoothly; the activity text changes at most once
  per second, always clipped to one row with `...`.

### 5. Exports (for tests)

- Export `ACTIVITY_REFRESH_INTERVAL_MS = 1500` and a pure helper
  `formatActivityLine({ live, runningToolName, thoughtText, spinnerFrame })`
  returning the styled or raw line text, so unit tests don't depend on
  pi-tui rendering or real timers. Mirror in `compact-summary.d.ts`.

## Patch workflow (important)

The committed source of truth is the patch file; tests import the node_modules
dist. Implementation order:

1. Edit `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/
   compact-summary.js` (+ `.d.ts` for the new exports).
2. Regenerate the patch: `npx patch-package` (updates
   `patches/@earendil-works+pi-coding-agent+0.83.0.patch`; node_modules stays
   patched, and it's gitignored anyway).
3. Run tests against the live dist, then `git diff -- patches/` to review the
   regenerated patch.

## Tests — `resources/extensions/__tests__/compact-summary.test.ts`

New cases (existing 16 must keep passing; no current test asserts the spinner
in `getStatsText`, so removing it is safe):

- `noteToolCall("bash", { command: "ls -la" }, "c1")` → live activity text
  contains the spinner char + `bash`, **not** `ls -la`.
- `formatActivityLine` unit tests: tool-running → name only; thinking →
  one-line text; empty live → spinner alone; finished → plain muted text.
- One-row guarantee: long thought → `summary.render(40)` returns exactly 2
  rows (stats + activity) and the activity row contains `...`.
- Throttle: `vi.useFakeTimers()` — `addThinkingDelta` then
  `advanceTimersByTime(499)` → text not flushed; `+1` more ms → flushed with
  the newest buffer content.

## Files touched

- `patches/@earendil-works+pi-coding-agent+0.83.0.patch` (regenerated)
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/compact-summary.js` (+ `.d.ts`) — gitignored working copy
- `resources/extensions/__tests__/compact-summary.test.ts` (new tests)

## Verification

- `npm test` (vitest) — full suite incl. new tests
- `npm run check-types`
- `npm run build`
- Manual: launch the extension, run a turn in TL;DR mode — confirm: `⠋ bash`
  while a tool runs (no output text, no args), `⠋ thought…` one row with
  spinner while thinking, no second-row wrap at narrow widths, static record
  (no spinner) after the turn ends.
