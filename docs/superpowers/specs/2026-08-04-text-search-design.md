# Text Search (Ctrl+F) in the CodePi Panel — Design

## Status

Design approved in conversation; implementation is the next phase.

## Goal

Pressing Ctrl+F while the CodePi panel (the embedded pi TUI webview) is focused brings up a search field pinned to the **top-right corner** of the panel — the same interaction as the VS Code built-in terminal's find widget. The search runs over the session's terminal buffer (current screen + scrollback) and supports live incremental search, match highlighting, and next/previous navigation.

## Scope

### In scope

- Ctrl+F interception in the TUI webview (xterm.js host) while the panel is focused; opens the find widget. Ctrl+F always opens find, even when pi's multi-line composer editor is open (user decision; matches the VS Code terminal, which also hijacks Ctrl+F from readline apps).
- A find widget that mirrors the VS Code built-in terminal find widget:
  - input box with live incremental search as you type;
  - all matches highlighted in the buffer (VS Code terminal colors via `--vscode-*` CSS vars), current match in a stronger accent;
  - "x of y" result counter (red "0 of 0" when no matches);
  - Aa case-sensitive toggle and ab| whole-word toggle (codicon glyphs; text fallback if codicon font unavailable);
  - previous/next chevron buttons;
  - Enter / Shift+Enter / ↑ / ↓ navigation; Esc closes;
  - query + toggle state remembered while the panel is alive (reopening restores them; reopening Ctrl+F refocuses input and selects all).
- Search covers the whole xterm buffer (scrollback 10000 lines), including content scrolled off-screen.

### Out of scope

- Regex search (the real VS Code terminal find widget has none; plain-text search only).
- Host-side / extension-host involvement of any kind — no protocol changes, no `extension.ts` changes. The buffer lives in the webview; search is purely webview-side.
- Search over files, git history, or anything outside the terminal buffer.
- A find widget in the Settings/Extensions tabs (they are separate webviews; this feature targets the TUI panel only).
- Persisting query/toggles across panel close/reopen (per-panel memory only, matching the VS Code terminal).

## Approach

**Official xterm search addon + a custom DOM find widget** (user-selected over hand-rolled buffer scanning and over host-side search).

- `@xterm/addon-search@^0.16.0` (same org as `@xterm/xterm` 6, tiny, official) does the hard parts: buffer scanning, case-insensitive matching, whole-word boundaries, live incremental search, match decoration highlighting with a distinct current-match accent, and an `onDidChangeResults` callback for the counter.
- The widget itself is ~150 lines of new webview code: a DOM overlay bar styled with `--vscode-*` CSS variables, positioned top-right above the terminal grid.
- Key interception slots into the existing `attachCustomKeyEventHandler` in `terminal.ts`; keystrokes while the widget is open land in the real `<input>` and never reach pi.

## Architecture

All changes are in the webview layer (`webview-ui/`). No extension-host, protocol, or `extension.ts` changes.

### Components

- **`webview-ui/src/terminal/find.ts`** (new): `createFindWidget(term, container)` → `{ open, close, isOpen }`.
  - Owns the `SearchAddon` instance, the widget DOM (built lazily on first open, reused), and all search state (query, caseSensitive, wholeWord, last counter values).
  - `open()`: builds/shows the bar, focuses the input, selects the prior query text.
  - `close()`: clears the search (addon `clearDecorations()`), hides the bar, returns focus to the terminal (`term.focus()`).
  - Input events → `addon.findNext(query, { incremental: true, caseSensitive, wholeWord, decorations })`; counter from `onDidChangeResults({ resultIndex, resultCount })`.
  - Widget buttons: Aa, ab|, ↑, ↓, × — each wired to the same search path.
  - Internal key handling on the input: Enter → next, Shift+Enter → previous, ↑/↓ → prev/next, Esc → close, Ctrl+F → refocus + select all.
- **`webview-ui/src/terminal/find.css`** (new): widget styling. Imported from `find.ts`; vite inlines it into `terminal.js` at runtime via the same `<style>` injection mechanism that bundles `links.css` today (verified: the terminal IIFE build has no HTML entry, so vite embeds CSS into the JS).
- **`webview-ui/package.json`**: add `@xterm/addon-search@^0.16.0` (peer-compatible with the pinned `@xterm/xterm@^6`).

### Changes to `terminal.ts` (small, additive)

- After `term.open(container)`: `const find = createFindWidget(term, container)`.
- In the existing `attachCustomKeyEventHandler`, add a branch: `ctrlLike && isKey("f")` → `e.preventDefault(); find.open()` (idempotent — second Ctrl+F refocuses + selects all), return `false`. Note: `ctrlLike` covers Ctrl on all platforms; Cmd+F on macOS handled by the same branch via `e.metaKey` (matches the existing Ctrl+C/V/D handling).
- Focus guards on the two existing focus-stealers so the widget keeps input focus:
  - `container.addEventListener("mousedown", () => term.focus())` — guard with `find.isOpen()`; also `e.stopPropagation()` on widget mousedown so clicks inside the bar never bubble.
  - `window.addEventListener("focus", () => term.focus())` — guard with `find.isOpen()` (alt-tab back must not yank focus out of the input).
- The `SearchAddon` decorations option needs the experimental decoration API; `allowProposedApi: true` is already set on the Terminal instance (line ~190) — no change needed.

### Data flow

1. Ctrl+F keydown on the xterm textarea → custom key handler → `find.open()` (widget shown, input focused).
2. Typing in the input → input event → `addon.findNext(query, opts)` with `incremental: true` → addon scans the buffer, applies match decorations, fires `onDidChangeResults`.
3. Counter renders `resultIndex+1 of resultCount` (or `0 of 0` in error red).
4. Enter/Shift+Enter/↑/↓ or chevron clicks → `findNext`/`findPrevious` with the same options (non-incremental) → counter updates.
5. Esc or × → `find.close()` → `clearDecorations()`, hide bar, `term.focus()`.
6. Keystrokes while the widget is open go to the `<input>`; they never reach `term.onData`, so pi never sees them.

## Widget UX

- Bar pinned top-right of the panel: `position: absolute; top: ~8px; right: ~8px; z-index` above the xterm grid and the loading overlay; VS Code find-widget border/background (`--vscode-editorWidget-background`, `--vscode-editorWidget-border`, `--vscode-input-background`, `--vscode-input-foreground`, focused `--vscode-focusBorder`).
- Element order (left → right): input, Aa, ab|, ↑, ↓, "x of y", ×.
- Toggle active state: `--vscode-inputOption-activeBorder` + active background, matching VS Code's widget.
- Match colors (VS Code semantics, matching the built-in terminal): other matches `var(--vscode-terminal-findMatchHighlightBackground, …)` (yellow), current match `var(--vscode-terminal-findMatchBackground, …)` (stronger accent); sensible dark/light fallbacks.
- Zero matches: counter in `--vscode-errorForeground` red.
- Codicons: VS Code injects the codicon font into webviews, so use `.codicon` classes (`codicon-case-sensitive`, `codicon-word-wrap`, `codicon-chevron-up/down`, `codicon-close`); if the font fails to render, the buttons still work (aria-labels + title tooltips).

## Edge Cases & Robustness

- **Disposed terminal:** every addon call is try/catch-wrapped (panel closed mid-search); widget quietly no-ops. The panel is gone anyway.
- **Rapid typing:** the addon runs synchronously over the buffer; no debounce (matches VS Code terminal). Stateless per call.
- **Panel hidden (background tab):** VS Code suspends hidden webviews; the widget is plain DOM and survives. `onDidChangeResults` may not fire while suspended; the counter catches up on the next keystroke.
- **Empty query:** no search, no highlights, counter cleared.
- **Regex-special characters:** plain-text search (addon default) — no escaping, no regex.
- **Theme switch:** widget colors resolve from CSS vars live; no code needed.
- **Buffer growth while open:** the addon re-runs the search automatically ~200ms after new output is written (`onWriteParsed` → `_updateMatches`, `noScroll`), so highlights track pi's output as it streams — better than the VS Code terminal, which only re-searches on the next keystroke. The active-match position is preserved.
- **Match-count cap:** the addon caps highlighted matches at 1000 (`highlightLimit`); when the cap is exceeded the result counter cannot report a current index (event `resultIndex: -1`) and shows `1000+ matches` instead of `x of y`.
- **Composer (Ctrl+E) open:** Ctrl+F still opens find (user decision); the composer's `tui.editor.cursorRight` Ctrl+F binding is shadowed while the panel is focused, exactly as the VS Code terminal shadows readline Ctrl+F. Right-arrow remains available for cursor movement.
- **Copy/paste/links:** existing Ctrl+C/Ctrl+V/link handlers untouched; the find branch is added alongside them in the same handler.
- **Key handler double-fire:** `attachCustomKeyEventHandler` runs for both keydown and the synthesized keypress; `open()` is idempotent (refocus + select all), so the two calls per Ctrl+F press are harmless.
- **Focus interplay while open:** clicking inside the widget keeps input focus; clicking the terminal body moves focus to the terminal while the widget stays open (same as VS Code's terminal) — keystrokes then reach pi until the input is clicked again. Esc pressed while focus is on the terminal also closes the widget (one extra branch in the key handler).

## Testing

The webview layer has no unit-test harness (standing decision; find is DOM glue over the addon — adding jsdom infra is out of scope). Verification:

1. **Type check:** `npm --prefix webview-ui run build` — `tsc --noEmit` catches addon API misuse and wiring errors in `terminal.ts`.
2. **Bundle check:** root `npm run build` — `webview-ui/dist/terminal.js` contains the addon + widget CSS (inlined).
3. **F5 manual checklist** (from the implementation plan, run against a real session):
   - Ctrl+F opens the widget top-right; input focused; prior query restored on reopen.
   - Typing searches incrementally; matches highlighted; counter correct; "0 of 0" red when no matches.
   - Enter/Shift+Enter/↑/↓ navigate and scroll the buffer; current-match accent follows.
   - Aa + whole-word toggles change results correctly (verify a case-sensitive query like `Git` vs `git`).
   - Esc closes; highlights cleared; focus + TUI cursor position restored.
   - Ctrl+C copy / Ctrl+V paste / Ctrl+click links still work.
   - Ctrl+F with the composer (Ctrl+E) open still opens find.
   - Clicking inside the widget never steals focus to the terminal; typing while open never reaches pi (no stray characters in the TUI input line).
   - A long session (scrolled-up scrollback) finds matches off-screen and scrolls to them.
   - Reopen after closing: query + toggles remembered.
   - Dark and light themes render the widget legibly; theme switch mid-search keeps colors correct.
