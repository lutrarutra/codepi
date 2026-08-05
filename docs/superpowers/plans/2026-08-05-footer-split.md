# Two-Row Responsive Codepi Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the codepi footer's combined `left │ right` content overflows the terminal width, split it into two rows (left above, right below, bottom row right-aligned) instead of truncating the right side with `...`.

**Architecture:** The footer is a single extension file (`resources/extensions/codepi-footer.ts`) whose `render(width): string[]` returns one line today. The SDK natively supports multi-row footers (the built-in footer returns up to 3 lines; the footer container measures the returned line count), so the change is purely inside `render`: a width fit-check that keeps the existing single-line path when it fits, and returns two rows otherwise. Both rows keep the existing 1-cell side margins; each row truncates with `...` only when it alone overflows (very narrow terminals).

**Tech Stack:** TypeScript, `@earendil-works/pi-tui` (`visibleWidth`, `truncateToWidth`), vitest.

## Global Constraints

- Scope is exactly two files: `resources/extensions/codepi-footer.ts` and `resources/extensions/__tests__/codepi-footer.test.ts`. No other files.
- Single line when `visibleWidth(left) + visibleWidth(midSep) + visibleWidth(right) <= innerWidth`; `innerWidth = max(1, width - 2)`; `MARGIN = 1`.
- Split layout: row 1 = left, flush left; row 2 = right, right-aligned to `innerWidth`.
- In split mode the right side is **never** collapsed with `...` — per-row truncation happens only when a single row alone exceeds the window.
- A right-less footer (defensive branch; today's right side always contains at least model + thinking level) never splits — single row, truncated as today.
- The `│` mid-separator exists only in single-line mode.
- No hysteresis, no stat dropping, no config setting.

---

### Task 1: Responsive two-row footer split (TDD)

**Files:**

- Modify: `resources/extensions/codepi-footer.ts` — the tail of `render()` (from the `// Pad left side so right side is right-aligned` comment through the closing `];` of the `return` statement).
- Test: `resources/extensions/__tests__/codepi-footer.test.ts` — replace the existing `"truncates the footer to the terminal width"` test and append a new `describe("codepi-footer: responsive split", ...)` block.

**Interfaces:**

- Consumes: existing `loadFooter(modeStatus, bashStatus, branch)` helper, `ICON_IMPLEMENT` (`\u{EAC4}`), `ICON_BASH` (`\u{EBCA}`) constants, and the `mockTheme` in the test file. The git branch renders as `theme.fg("toolDiffAdded", "\u{E0A0} " + branch)` — in mock-theme terms `{toolDiffAdded:<U+E0A0> main}` — assert with `"{toolDiffAdded:\u{E0A0} main}"`.
- Produces: `render(width)` returning `string[]` of length 1 (fits) or 2 (split), each row inset by one cell and padded to the full terminal width. Nothing else consumes this output beyond the TUI footer container.

- [ ] **Step 1: Replace the old truncation test and add the failing split tests**

In `resources/extensions/__tests__/codepi-footer.test.ts`, replace this test:

```ts
 it("truncates the footer to the terminal width", async () => {
  const { component } = await loadFooter("IMPLEMENT");
  const [line] = component.render(40);
  expect(line.length).toBeLessThanOrEqual(40 * 2); // ANSI codes inflate length
 });
```

with this two-row variant:

```ts
 it("keeps every row within the terminal width", async () => {
  const { component } = await loadFooter("IMPLEMENT");
  const lines = component.render(40);
  expect(lines).toHaveLength(2);
  for (const line of lines) {
   expect(line.length).toBeLessThanOrEqual(40 * 2); // ANSI codes inflate length
  }
 });
```

Then append this describe block at the end of the file:

```ts
describe("codepi-footer: responsive split", () => {
 // Mock-theme tokens inflate visible width, so a full footer (mode badge +
 // bash badge + branch) needs ~250 cells for a single line: 400 → one
 // line, 200 → two rows with every right-side segment intact (each row
 // alone still fits), 20 → per-row truncation.
 it("keeps a single line when everything fits", async () => {
  const { component } = await loadFooter("IMPLEMENT", "ask", "main");
  expect(component.render(400)).toHaveLength(1);
 });

 it("splits into two rows when the combined content overflows", async () => {
  const { component } = await loadFooter("IMPLEMENT", "ask", "main");
  const lines = component.render(200);
  expect(lines).toHaveLength(2);
  // Left row: stats, flush left.
  expect(lines[0].startsWith(" {success:↑}{text:0}")).toBe(true);
  // Right row: every right-side segment survives — no "..." collapse.
  expect(lines[1]).toContain(`{success:${ICON_IMPLEMENT} *implement*}`);
  expect(lines[1]).toContain(
   `{warning:${ICON_BASH} }{warning:*ask*}{dim:/allow}`,
  );
  expect(lines[1]).toContain("{toolDiffAdded:\u{E0A0} main}");
  expect(lines[1]).not.toContain("...");
 });

 it("right-aligns the bottom row", async () => {
  const { component } = await loadFooter("IMPLEMENT", "ask", "main");
  const lines = component.render(200);
  expect(lines).toHaveLength(2);
  // Bottom row: margin + lead padding + content spans the full inner
  // width — stripped of trailing pad, it ends exactly at the right
  // edge (1 + (200 - 2) = 199 cells).
  const stripped = lines[1].replace(/\s+$/, "");
  expect(stripped).toHaveLength(199);
  expect(stripped.startsWith("  ")).toBe(true); // margin + >= 1 lead space
 });

 it("keeps the left row flush left when split", async () => {
  const { component } = await loadFooter("IMPLEMENT", "ask", "main");
  const lines = component.render(200);
  expect(lines).toHaveLength(2);
  // Left row does NOT span the inner width: its content ends well
  // before the right edge (unlike the right-aligned bottom row).
  expect(lines[0].replace(/\s+$/, "").length).toBeLessThan(199);
 });

 it("truncates each row only when it alone overflows (very narrow)", async () => {
  const { component } = await loadFooter("IMPLEMENT", "ask", "main");
  const lines = component.render(20);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("...");
  expect(lines[1]).toContain("...");
 });

 it("insets both rows by one cell on each side", async () => {
  const { component } = await loadFooter("IMPLEMENT", "ask", "main");
  const lines = component.render(200);
  expect(lines).toHaveLength(2);
  expect(lines[0].startsWith(" ")).toBe(true);
  expect(lines[0].endsWith(" ")).toBe(true);
  expect(lines[1].startsWith(" ")).toBe(true);
  expect(lines[1].endsWith(" ")).toBe(true);
 });
});
```

Indentation in the actual file is tabs (markdown code blocks render spaces here) — apply the edits with the surrounding file's tab style.

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run resources/extensions/__tests__/codepi-footer.test.ts`
Expected: 17 tests total; the 6 split-behavior tests FAIL with `expected ... to have length 2` (current `render` always returns one line) and `lines[1]` undefined errors; the replaced width test also FAILS (expects 2 lines, gets 1); the other 10 existing tests still PASS. If nothing fails, the tests were written wrong — fix before continuing.

- [ ] **Step 3: Implement the split in `codepi-footer.ts`**

In `resources/extensions/codepi-footer.ts`, inside `render(width)`, replace this block (content verbatim; match the surrounding file's tab indentation):

```ts
     // Pad left side so right side is right-aligned
     const leftContent = left + midSep;
     const padNeeded = Math.max(
      1,
      innerWidth - visibleWidth(leftContent) - visibleWidth(right),
     );
     const pad = " ".repeat(padNeeded);

     const content = truncateToWidth(
      leftContent + pad + right,
      innerWidth,
     );
     return [
      " ".repeat(MARGIN) +
       content +
       " ".repeat(Math.max(0, width - MARGIN - visibleWidth(content))),
     ];
```

with this block (content verbatim; match the surrounding file's tab indentation):

```ts
     // Render one footer row: 1-cell margin on each side. Truncates
     // with "..." only when a single row alone overflows the window
     // (very narrow terminals — last resort).
     const makeRow = (content: string, rightAlign: boolean) => {
      const row =
       visibleWidth(content) <= innerWidth
        ? content
        : truncateToWidth(content, innerWidth);
      const lead = rightAlign
       ? " ".repeat(Math.max(0, innerWidth - visibleWidth(row)))
       : "";
      return (
       " ".repeat(MARGIN) +
       lead +
       row +
       " ".repeat(
        Math.max(0, width - MARGIN - visibleWidth(lead + row)),
       )
      );
     };

     // Single line when everything fits (current layout, right side
     // right-aligned via padding). Otherwise split into two rows:
     // left above, right below — the right side is never collapsed.
     const leftContent = left + midSep;
     if (
      right &&
      visibleWidth(leftContent) + visibleWidth(right) <= innerWidth
     ) {
      const padNeeded = Math.max(
       1,
       innerWidth - visibleWidth(leftContent) - visibleWidth(right),
      );
      return [makeRow(leftContent + " ".repeat(padNeeded) + right, false)];
     }
     if (!right) {
      // Right-less footer (defensive; today's right side always has
      // at least the model + thinking level): single truncated row.
      return [makeRow(left, false)];
     }
     return [makeRow(left, false), makeRow(right, true)];
```

Notes: `visibleWidth` and `truncateToWidth` are already imported at the top of the file — no import changes. `MARGIN`/`innerWidth` stay defined above this block — do not move them.

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `npx vitest run resources/extensions/__tests__/codepi-footer.test.ts`
Expected: all 17 tests PASS (6 new split tests + replaced width test + 10 existing).

- [ ] **Step 5: Run the full suite and type-check**

Run: `npx vitest run`
Expected: 474 tests pass (468 − 11 footer + 17 footer), 0 failures.

Run: `npm run check-types`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add resources/extensions/codepi-footer.ts resources/extensions/__tests__/codepi-footer.test.ts
git commit -m "feat: split codepi footer into two rows when content overflows"
```

Do NOT stage any other modified files (the tree contains unrelated uncommitted work: `package.json`, `src/extension.ts`, patch files, favicon media — leave them alone).
