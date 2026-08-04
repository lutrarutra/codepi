# Text Search (Ctrl+F) in the CodePi Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ctrl+F in the CodePi panel opens a VS Code-terminal-style find widget (top-right overlay) that live-searches the xterm buffer with highlights, an "x of y" counter, case/whole-word toggles, and next/prev navigation.

**Architecture:** All changes are webview-side (`webview-ui/`). A new `find.ts` module owns the `@xterm/addon-search` SearchAddon (buffer scanning, match decorations, results events) plus the widget DOM; `terminal.ts` gets small additive edits (create the widget, intercept Ctrl+F/Esc, focus guards). No extension-host, protocol, or `extension.ts` changes.

**Tech Stack:** TypeScript, xterm.js 6 (`@xterm/xterm`), `@xterm/addon-search@^0.16.0`, vite (IIFE bundle `terminal.js` with CSS inlined), VS Code theme CSS vars.

## Global Constraints

- Webview-only feature: no changes to `src/`, no protocol messages, no `extension.ts` edits.
- Only new dependency: `@xterm/addon-search@^0.16.0` (peer-compatible with `@xterm/xterm@^6`).
- Match colors follow VS Code semantics (verified against the built-in terminal): **other** matches use `--vscode-terminal-findMatchHighlightBackground` (yellow), **current** match uses `--vscode-terminal-findMatchBackground` (stronger accent). The addon's d.ts demands `#RRGGBB` for background colors but xterm's color parser accepts 8-digit hex/rgba — pass raw CSS var values through.
- The addon caps highlighted matches at 1000 (`highlightLimit` default); when exceeded, `onDidChangeResults` reports `resultIndex: -1` — the counter must show `1000+ matches` (not `x of y`).
- The addon re-runs the search automatically ~200ms after new output (`onWriteParsed` → `_updateMatches` with `noScroll`) — do not add our own re-search.
- `onDidChangeResults` only fires when `decorations` are passed to `findNext`/`findPrevious` — always pass them.
- Follow `terminal.ts` conventions: `cssVar(name, fallback)` helper, `isKey`/`ctrlLike` key matching, defensive try/catch around addon calls (terminal may be disposed).
- The webview has no unit-test harness (standing decision) — each task's test cycle is `tsc --noEmit` + vite build + the F5 checks listed in the task.
- The repo has uncommitted user WIP (Compact Mode etc.) — commit only this plan's files, never `git add -A`.
- The widget must render above the loading overlay (`#loading` is `z-index: 10`; widget `z-index: 30`).

---

### Task 1: Widget scaffold — DOM, open/close, key interception, focus guards

**Files:**

- Create: `webview-ui/src/terminal/find.css`
- Create: `webview-ui/src/terminal/find.ts` (scaffold: DOM + lifecycle, no search yet)
- Modify: `webview-ui/src/terminal/terminal.ts` (import, create widget, Ctrl+F + Esc key branches, focus guards, document fallback listener)

**Interfaces:**

- Produces: `createFindWidget(term: Terminal, container: HTMLElement): FindWidget` where `FindWidget = { open(): void; close(): void; isOpen(): boolean }` — Task 2 extends this module in place; the signature does not change.

- [ ] **Step 1: Create `webview-ui/src/terminal/find.css`**

```css
/* Ctrl+F find widget — mirrors the VS Code built-in terminal find box.
   Positioned top-right above the xterm grid and the loading overlay
   (z-index 10). Colors resolve live from VS Code theme variables. */
.codepi-find {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 30;
  display: none;
  align-items: center;
  gap: 2px;
  padding: 4px;
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  border-radius: 2px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  font-family: var(--vscode-font-family, sans-serif);
  font-size: 12px;
}
.codepi-find.open {
  display: flex;
}
.codepi-find-input {
  width: 180px;
  padding: 3px 6px;
  border: 1px solid transparent;
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, #cccccc);
  outline: none;
}
.codepi-find-input:focus {
  border-color: var(--vscode-focusBorder, #007fd4);
}
.codepi-find-toggle,
.codepi-find-btn {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  background: transparent;
  color: var(--vscode-foreground, #cccccc);
  cursor: pointer;
  border-radius: 2px;
}
.codepi-find-toggle:hover,
.codepi-find-btn:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
}
.codepi-find-toggle.active {
  border-color: var(--vscode-inputOption-activeBorder, #007fd4);
  background: var(--vscode-inputOption-activeBackground, rgba(0, 127, 212, 0.4));
}
.codepi-find-counter {
  min-width: 48px;
  text-align: center;
  color: var(--vscode-descriptionForeground, #a0a0a0);
  user-select: none;
}
.codepi-find-counter.no-results {
  color: var(--vscode-errorForeground, #f14c4c);
}
```

- [ ] **Step 2: Create `webview-ui/src/terminal/find.ts` (scaffold)**

```ts
import type { Terminal } from "@xterm/xterm";
import "./find.css";

export interface FindWidget {
 open: () => void;
 close: () => void;
 isOpen: () => boolean;
}

/**
 * Ctrl+F find widget for the TUI panel — mirror of the VS Code built-in
 * terminal find box: top-right overlay, live incremental search over the
 * whole xterm buffer, all matches highlighted, "x of y" counter, case +
 * whole-word toggles, prev/next navigation.
 *
 * Scaffold stage: DOM + lifecycle (Task 2 wires the xterm search addon).
 * Keystrokes land in the widget's own <input> while open, so nothing leaks
 * to pi.
 */
export function createFindWidget(
 term: Terminal,
 container: HTMLElement,
): FindWidget {
 // Search state (remembered for the panel's lifetime).
 const query = "";
 let open = false;

 // Widget DOM (built lazily on first open).
 let bar: HTMLDivElement | null = null;
 let input: HTMLInputElement | null = null;
 let counter: HTMLSpanElement | null = null;
 let caseBtn: HTMLButtonElement | null = null;
 let wordBtn: HTMLButtonElement | null = null;

 const close = (): void => {
  if (!open) return;
  open = false;
  if (bar) bar.classList.remove("open");
  term.focus();
 };

 const buildBar = (): void => {
  bar = document.createElement("div");
  bar.className = "codepi-find";
  bar.setAttribute("role", "search");

  input = document.createElement("input");
  input.className = "codepi-find-input";
  input.type = "text";
  input.placeholder = "Find";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Find in terminal");

  counter = document.createElement("span");
  counter.className = "codepi-find-counter";

  caseBtn = makeButton(
   "codepi-find-toggle",
   "Match Case",
   "Toggle case-sensitive search",
  );
  caseBtn.textContent = "Aa";
  wordBtn = makeButton(
   "codepi-find-toggle",
   "Match Whole Word",
   "Toggle whole-word search",
  );
  wordBtn.textContent = "ab|";
  const upBtn = makeButton(
   "codepi-find-btn",
   "Previous Match",
   "Previous match",
  );
  upBtn.textContent = "↑";
  const downBtn = makeButton(
   "codepi-find-btn",
   "Next Match",
   "Next match",
  );
  downBtn.textContent = "↓";
  const closeBtn = makeButton(
   "codepi-find-btn",
   "Close (Esc)",
   "Close find",
  );
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", close);

  input.addEventListener("keydown", (e: KeyboardEvent) => {
   if (e.key === "Escape") {
    e.preventDefault();
    close();
   } else if (
    (e.ctrlKey || e.metaKey) &&
    (e.code === "KeyF" || e.key.toLowerCase() === "f")
   ) {
    // Ctrl+F while open: refocus + select all (VS Code behavior).
    e.preventDefault();
    input?.select();
   }
  });

  // Clicks inside the bar must never bubble to the container's
  // mousedown → term.focus() listener (which would steal input focus).
  bar.addEventListener("mousedown", (e) => e.stopPropagation());

  bar.append(input, caseBtn, wordBtn, upBtn, downBtn, counter, closeBtn);
  container.appendChild(bar);
 };

 const show = (): void => {
  if (open) {
   // Already open: refocus + select all (VS Code behavior).
   input?.focus();
   input?.select();
   return;
  }
  open = true;
  if (!bar) buildBar();
  bar?.classList.add("open");
  input!.value = query; // restore last query
  input!.focus();
  input!.select();
 };

 return { open: show, close, isOpen: () => open };
}

function makeButton(
 className: string,
 title: string,
 ariaLabel: string,
): HTMLButtonElement {
 const b = document.createElement("button");
 b.className = className;
 b.title = title;
 b.setAttribute("aria-label", ariaLabel);
 b.type = "button";
 return b;
}
```

- [ ] **Step 3: Modify `webview-ui/src/terminal/terminal.ts` — import**

After the links import block (top of file, after `import { createOsc8LinkHandler, createTerminalLinkProvider } from "./links";`):

```ts
import { createFindWidget } from "./find";
```

- [ ] **Step 4: Modify `terminal.ts` — create the widget**

Immediately after `applyBackground();` (the call right after `term.open(container);`):

```ts
  const find = createFindWidget(term, container);
```

- [ ] **Step 5: Modify `terminal.ts` — Ctrl+F and Esc branches in the custom key handler**

In `term.attachCustomKeyEventHandler(...)`, insert these two branches between the Ctrl+D branch and the Shift+Enter branch (both are inside the handler, after `const ctrlLike = e.ctrlKey || e.metaKey;`):

```ts
   if (ctrlLike && isKey("f")) {
    // Ctrl+F: open the find widget (focus moves to its input, so
    // the handler's keydown+keypress double-fire never reaches here
    // twice; open() is idempotent anyway).
    e.preventDefault();
    find.open();
    return false;
   }
   if (e.key === "Escape" && find.isOpen()) {
    // Widget open but focus back on the terminal (clicked the grid):
    // Esc closes it instead of reaching pi.
    e.preventDefault();
    find.close();
    return false;
   }
```

- [ ] **Step 6: Modify `terminal.ts` — focus guards + document fallback listener**

Replace the two focus-stealers at the end of the init block:

```ts
  container.addEventListener("mousedown", () => term.focus());
  window.addEventListener("focus", () => term.focus());
```

with:

```ts
  container.addEventListener("mousedown", () => {
   // Clicks inside the find widget never reach here (its own mousedown
   // stops propagation); grid clicks refocus the terminal. When the
   // widget is open, xterm itself refocuses its textarea on grid
   // clicks — matching VS Code, where clicking the terminal while the
   // find box is open moves focus there and leaves the box open.
   if (!find.isOpen()) term.focus();
  });
  window.addEventListener("focus", () => {
   // Alt-tab back while the widget is open must not yank focus out of
   // the find input.
   if (!find.isOpen()) term.focus();
  });

  // Ctrl+F fallback: the custom key handler above only sees keystrokes
  // while xterm's textarea is focused; this catches the same chord when
  // focus sits on the webview body (e.g. right after panel creation).
  // open() is idempotent, so the double delivery (textarea case) is
  // harmless. Esc-close for the body-focus case is handled here too.
  document.addEventListener("keydown", (e: KeyboardEvent) => {
   if (find.isOpen()) {
    if (e.key === "Escape") {
     e.preventDefault();
     find.close();
    }
    return;
   }
   const ctrlLike = e.ctrlKey || e.metaKey;
   const isF = e.code === "KeyF" || e.key.toLowerCase() === "f";
   if (ctrlLike && isF) {
    e.preventDefault();
    find.open();
   }
  });
```

- [ ] **Step 7: Type check + build**

```bash
cd /home/lutrarutra/dev/codepi && npm run build
```

Expected: `tsc --noEmit` clean; webview vite build emits `webview-ui/dist/terminal.js` (now larger — contains the widget CSS inlined); extension build clean. No errors.

- [ ] **Step 8: F5 scaffold checks**

Run the Extension Development Host (F5), open/restore a CodePi session, then verify:

- Ctrl+F with the panel focused opens the empty widget top-right; the input is focused.
- Typing while the widget is open does NOT appear in the TUI input line (nothing leaks to pi).
- Esc closes the widget; terminal focus + cursor restored.
- Ctrl+F again while open refocuses the input and selects its text.
- Clicking the widget's buttons/input never steals focus to the terminal.
- Clicking the terminal grid while the widget is open moves focus to the terminal; the widget stays open.
- Alt-tab away and back: the widget keeps input focus.
- Ctrl+C copy / Ctrl+V paste / Shift+Enter composer newline still work.

- [ ] **Step 9: Commit**

```bash
cd /home/lutrarutra/dev/codepi && git add webview-ui/src/terminal/find.css webview-ui/src/terminal/find.ts webview-ui/src/terminal/terminal.ts && git commit -m "feat: Ctrl+F find widget scaffold (DOM, open/close, key interception)"
```

---

### Task 2: Search engine — addon wiring, highlights, counter, navigation

**Files:**

- Modify: `webview-ui/src/terminal/find.ts` (replace the scaffold body with the full search implementation)
- Test: none (webview has no unit-test harness) — verify via build + F5

**Interfaces:**

- Consumes: `createFindWidget(term, container)` signature from Task 1 (unchanged); `@xterm/addon-search` `SearchAddon` (`findNext(term, opts)`, `findPrevious(term, opts)`, `clearDecorations()`, `clearActiveDecoration()`, `onDidChangeResults: IEvent<{resultIndex, resultCount}>`); `ISearchOptions = { regex?, wholeWord?, caseSensitive?, incremental?, decorations? }` where `decorations` requires `matchOverviewRuler` and `activeMatchColorOverviewRuler`.
- Produces: nothing new (module-internal).

- [ ] **Step 1: Add the dependency to `webview-ui/package.json`**

Add under `"dependencies"` (alphabetical, before `@xterm/xterm`):

```json
"@xterm/addon-search": "^0.16.0",
```

Then install:

```bash
cd /home/lutrarutra/dev/codepi && npm install --prefix webview-ui
```

Expected: installs `@xterm/addon-search@0.16.x` into `webview-ui/node_modules/` (the root lockfile does not cover `webview-ui/`).

- [ ] **Step 2: Rewrite `webview-ui/src/terminal/find.ts` with the full implementation**

Replace the entire file (keep the `FindWidget` interface and `makeButton` helper; add the addon, search state, counter, toggles, navigation):

```ts
import { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import "./find.css";

export interface FindWidget {
 open: () => void;
 close: () => void;
 isOpen: () => boolean;
}

/** Read a VS Code theme variable with a fallback (mirrors terminal.ts). */
function cssVar(name: string, fallback: string): string {
 const v = getComputedStyle(document.documentElement).getPropertyValue(name);
 return v.trim() || fallback;
}

/**
 * Ctrl+F find widget for the TUI panel — mirror of the VS Code built-in
 * terminal find box: top-right overlay, live incremental search over the
 * whole xterm buffer, all matches highlighted, "x of y" counter, case +
 * whole-word toggles, prev/next navigation.
 *
 * The SearchAddon does the buffer scanning and match decoration highlighting
 * (capped at 1000 matches — see the counter's "+ matches" fallback) and
 * re-runs the search itself ~200ms after new terminal output. Keystrokes
 * land in the widget's own <input> while open, so nothing leaks to pi.
 */
export function createFindWidget(
 term: Terminal,
 container: HTMLElement,
): FindWidget {
 const addon = new SearchAddon();
 term.loadAddon(addon);

 // Search state (remembered for the panel's lifetime).
 let query = "";
 let caseSensitive = false;
 let wholeWord = false;
 let open = false;

 // Result state, fed by addon.onDidChangeResults.
 let resultCount = 0;
 let resultIndex = -1;

 // Widget DOM (built lazily on first open).
 let bar: HTMLDivElement | null = null;
 let input: HTMLInputElement | null = null;
 let counter: HTMLSpanElement | null = null;
 let caseBtn: HTMLButtonElement | null = null;
 let wordBtn: HTMLButtonElement | null = null;

 /** Terminal may be disposed while the widget is in use — never throw. */
 const safe = (fn: () => void): void => {
  try {
   fn();
  } catch {
   /* terminal disposed */
  }
 };

 // Match colors mirror the VS Code built-in terminal: other matches use
 // the "highlight" variable (yellow), the current match the "match"
 // variable (stronger accent). xterm's color parser accepts the themes'
 // 8-digit hex/rgba values despite the d.ts's "#RRGGBB" note.
 const decorations = (): {
  matchBackground?: string;
  matchBorder?: string;
  matchOverviewRuler: string;
  activeMatchBackground?: string;
  activeMatchBorder?: string;
  activeMatchColorOverviewRuler: string;
 } => ({
  matchBackground: cssVar(
   "--vscode-terminal-findMatchHighlightBackground",
   "#ea5c0055",
  ),
  matchBorder: "transparent",
  matchOverviewRuler: "transparent",
  activeMatchBackground: cssVar(
   "--vscode-terminal-findMatchBackground",
   "#d186167e",
  ),
  activeMatchBorder: "transparent",
  activeMatchColorOverviewRuler: "transparent",
 });

 const searchOptions = (incremental: boolean) => ({
  incremental,
  caseSensitive,
  wholeWord,
  decorations: decorations(),
 });

 const updateCounter = (): void => {
  if (!counter) return;
  counter.classList.remove("no-results");
  if (!query) {
   counter.textContent = "";
   return;
  }
  if (resultCount === 0) {
   counter.textContent = "0 of 0";
   counter.classList.add("no-results");
   return;
  }
  // resultIndex is -1 when the 1000-match highlight cap is exceeded.
  counter.textContent =
   resultIndex >= 0
    ? `${resultIndex + 1} of ${resultCount}`
    : `${resultCount}+ matches`;
 };

 /** Live re-search from the current buffer position (per keystroke). */
 const runSearch = (): void => {
  query = input?.value ?? "";
  if (!query) {
   safe(() => addon.clearDecorations());
   resultCount = 0;
   resultIndex = -1;
   updateCounter();
   return;
  }
  safe(() => addon.findNext(query, searchOptions(true)));
 };

 const next = (): void => {
  if (!query) return;
  safe(() => addon.findNext(query, searchOptions(false)));
 };
 const prev = (): void => {
  if (!query) return;
  safe(() => addon.findPrevious(query, searchOptions(false)));
 };

 const toggleCase = (): void => {
  caseSensitive = !caseSensitive;
  caseBtn?.classList.toggle("active", caseSensitive);
  caseBtn?.setAttribute("aria-pressed", String(caseSensitive));
  if (query) safe(() => addon.findNext(query, searchOptions(false)));
 };
 const toggleWord = (): void => {
  wholeWord = !wholeWord;
  wordBtn?.classList.toggle("active", wholeWord);
  wordBtn?.setAttribute("aria-pressed", String(wholeWord));
  if (query) safe(() => addon.findNext(query, searchOptions(false)));
 };

 const close = (): void => {
  if (!open) return;
  open = false;
  safe(() => addon.clearDecorations());
  if (bar) bar.classList.remove("open");
  term.focus();
 };

 const buildBar = (): void => {
  bar = document.createElement("div");
  bar.className = "codepi-find";
  bar.setAttribute("role", "search");

  input = document.createElement("input");
  input.className = "codepi-find-input";
  input.type = "text";
  input.placeholder = "Find";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Find in terminal");

  counter = document.createElement("span");
  counter.className = "codepi-find-counter";
  counter.setAttribute("aria-live", "polite");

  caseBtn = makeButton(
   "codepi-find-toggle",
   "Match Case",
   "Toggle case-sensitive search",
  );
  caseBtn.textContent = "Aa";
  wordBtn = makeButton(
   "codepi-find-toggle",
   "Match Whole Word",
   "Toggle whole-word search",
  );
  wordBtn.textContent = "ab|";
  const upBtn = makeButton(
   "codepi-find-btn",
   "Previous Match",
   "Previous match",
  );
  upBtn.textContent = "↑";
  const downBtn = makeButton(
   "codepi-find-btn",
   "Next Match",
   "Next match",
  );
  downBtn.textContent = "↓";
  const closeBtn = makeButton(
   "codepi-find-btn",
   "Close (Esc)",
   "Close find",
  );
  closeBtn.textContent = "×";
  caseBtn.addEventListener("click", toggleCase);
  wordBtn.addEventListener("click", toggleWord);
  upBtn.addEventListener("click", prev);
  downBtn.addEventListener("click", next);
  closeBtn.addEventListener("click", close);

  // Typing → live incremental search. No debounce: the addon scans
  // synchronously and the VS Code terminal doesn't debounce either.
  input.addEventListener("input", runSearch);
  input.addEventListener("keydown", (e: KeyboardEvent) => {
   if (e.key === "Escape") {
    e.preventDefault();
    close();
   } else if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) prev();
    else next();
   } else if (e.key === "ArrowUp") {
    e.preventDefault();
    prev();
   } else if (e.key === "ArrowDown") {
    e.preventDefault();
    next();
   } else if (
    (e.ctrlKey || e.metaKey) &&
    (e.code === "KeyF" || e.key.toLowerCase() === "f")
   ) {
    // Ctrl+F while open: refocus + select all (VS Code behavior).
    e.preventDefault();
    input?.select();
   }
  });
  // Current-match accent disappears when focus leaves the widget
  // (matches VS Code's terminal; the next search restores it).
  input.addEventListener("blur", () =>
   safe(() => addon.clearActiveDecoration()),
  );

  // Clicks inside the bar must never bubble to the container's
  // mousedown → term.focus() listener (which would steal input focus).
  bar.addEventListener("mousedown", (e) => e.stopPropagation());

  bar.append(input, caseBtn, wordBtn, upBtn, downBtn, counter, closeBtn);
  container.appendChild(bar);
 };

 const show = (): void => {
  if (open) {
   // Already open: refocus + select all (VS Code behavior).
   input?.focus();
   input?.select();
   return;
  }
  open = true;
  if (!bar) buildBar();
  bar?.classList.add("open");
  input!.value = query; // restore last query
  updateCounter();
  input!.focus();
  input!.select();
  // Re-apply highlights immediately (VS Code restores them on reopen).
  if (query) safe(() => addon.findNext(query, searchOptions(false)));
 };

 addon.onDidChangeResults((e) => {
  resultIndex = e.resultIndex;
  resultCount = e.resultCount;
  updateCounter();
 });

 return { open: show, close, isOpen: () => open };
}

function makeButton(
 className: string,
 title: string,
 ariaLabel: string,
): HTMLButtonElement {
 const b = document.createElement("button");
 b.className = className;
 b.title = title;
 b.setAttribute("aria-label", ariaLabel);
 b.type = "button";
 return b;
}
```

- [ ] **Step 3: Type check + build**

```bash
cd /home/lutrarutra/dev/codepi && npm run build
```

Expected: `tsc --noEmit` clean (if the addon types fail to resolve, verify `webview-ui/node_modules/@xterm/addon-search/package.json` `types` field points at `typings/addon-search.d.ts` and the package is in `webview-ui/package-lock.json`); vite build emits `terminal.js`; no errors.

- [ ] **Step 4: F5 search checks**

Run the Extension Development Host (F5), restore/open a CodePi session with some scrolled output, then verify:

- Type "the" (a common word): matches highlight yellow across the buffer; the current match has the stronger accent; counter reads "1 of N" and climbs to the right total.
- Typing further narrows incrementally; deleting back to empty clears highlights and the counter.
- Enter / ↓ step forward; Shift+Enter / ↑ step backward; the buffer scrolls when the match is off-screen; the current-match accent follows.
- The ↑/↓ chevron buttons navigate too.
- Aa toggle: with a query containing a capital (e.g. "README"), case-sensitive finds only exact-case matches; active-state border appears; off restores case-insensitive.
- Whole-word toggle: query "git" matches only standalone words, not "target" etc.
- Type a nonsense string: counter shows red "0 of 0", highlights cleared.
- Esc closes; all highlights gone; focus + TUI cursor restored.
- Close and reopen (Ctrl+F): the query and toggle states are restored, highlights re-applied.
- Click the terminal grid while the widget is open: current-match accent disappears (blur), the widget stays open; clicking back into the input restores it on the next search.
- While pi is generating output, matches for a live query re-highlight within ~200ms of new output without touching the current match.
- Search a term with >1000 occurrences (e.g. " " or "e" in a long session): the counter shows either "1000+ matches" or a capped "x of 1000" (never a wrong-looking "x of y" beyond the cap).

- [ ] **Step 5: Commit**

```bash
cd /home/lutrarutra/dev/codepi && git add webview-ui/package.json webview-ui/package-lock.json webview-ui/src/terminal/find.ts && git commit -m "feat: live terminal search via xterm search addon (highlights, counter, navigation)"
```

---

### Task 3: Edge-case audit and full F5 checklist

**Files:** none expected (verification + fix-if-needed task; commit only if changes are required)

- [ ] **Step 1: Run the full project verification**

```bash
cd /home/lutrarutra/dev/codepi && npm test && npm run build
```

Expected: all 342 tests pass (the extension host is untouched — this guards against accidental scope creep), build clean.

- [ ] **Step 2: F5 edge-case checklist**

Run the Extension Development Host (F5) and verify each item from the spec's testing section:

1. Ctrl+F while pi's multi-line composer (Ctrl+E) is open still opens the find widget; typing in the find input does not edit the composer; closing returns focus to the composer intact.
2. Ctrl+C copy / Ctrl+V paste / Ctrl+click links / Ctrl+D blocking all still work with the widget closed (no regression).
3. Dark and light themes render the widget legibly; switching themes mid-search updates the widget and match colors (CSS vars resolve live).
4. Open the find widget, then close the panel tab while it's open; reopen the session — no errors in the DevTools console (`[CodePi-tui]` logs clean, no addon exceptions).
5. Rapid typing (paste a long string into the find input): no errors, counter settles correctly.
6. Search "vscode" with Aa off in a session that also contains "VSCode": both match; with Aa on only the exact case matches.
7. The widget never covers the loading overlay incorrectly: create a fresh panel, focus it during startup, press Ctrl+F — either the widget appears above the loading screen (z-index 30 > 10) or no-ops harmlessly before the terminal is ready; no errors either way.

If any check fails, fix the code (same files as Tasks 1–2) and re-run `npm run build` until all pass.

- [ ] **Step 3: Commit fixes (only if Step 2 found issues)**

```bash
cd /home/lutrarutra/dev/codepi && git add webview-ui/src/terminal/ && git commit -m "fix: find widget edge cases found in F5 audit"
```

If nothing needed fixing, skip this step.

---

### Task 4: Final verification and close-out

**Files:** none (verification + reporting task)

- [ ] **Step 1: Final full verification**

```bash
cd /home/lutrarutra/dev/codepi && npm test && npm run build
```

Expected: 342/342 tests pass, build clean. Then confirm the bundle actually contains the feature:

```bash
grep -c "codepi-find\|SearchAddon" webview-ui/dist/terminal.js
```

Expected: a count ≥ 1 (the widget CSS and the search addon are inlined in `terminal.js`).

- [ ] **Step 2: Confirm git state**

```bash
cd /home/lutrarutra/dev/codepi && git status --short && git log --oneline -5
```

Expected: only the plan's files committed (3 commits from Tasks 1–3 plus this plan's docs); user WIP files (`src/pi-store.ts`, `src/settings-dashboard.ts`, `codepi-compact.ts`, etc.) remain uncommitted and untouched.

- [ ] **Step 3: Report**

Summarize for the user: what was built, where (files), the verification evidence (test count, build, F5 checklist results), and the one known limitation (no webview unit-test harness; find behavior is covered by the F5 checklist).
