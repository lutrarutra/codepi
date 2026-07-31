/**
 * Pure-logic sanity tests for the edit-review diff engine and edit application.
 * Run: node --experimental-strip-types scripts/review-diff-smoke.ts
 * (Node 22+ can strip types directly for these dependency-free modules.)
 */

import { computeHunks, countHunkLines, splitLines, contentHash } from "../src/review/diff.ts";
import { applyEditsToContent } from "../src/review/edit-apply.ts";
import { computeInverseEdit, lineStartOffset } from "../src/review/review-manager.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		failures++;
		console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

/** Apply an inverse edit to content and return the result (or 'STALE'). */
function applyInverse(
	content: string,
	oldText: string,
	newText: string,
	modifiedStart: number,
	modifiedEnd: number,
	originalContent?: string,
	originalStart = 1,
	originalEnd = 0,
): string {
	const hunk = {
		hunkId: "h-x",
		originalStartLine: originalStart,
		originalEndLine: originalEnd,
		modifiedStartLine: modifiedStart,
		modifiedEndLine: modifiedEnd,
		oldText,
		newText,
		status: "pending" as const,
	};
	const inv = computeInverseEdit(content, hunk, originalContent);
	if (!inv) return "STALE";
	return content.slice(0, inv.start) + inv.replacement + content.slice(inv.end);
}

console.log("splitLines:");
check("a\\nb → [a,b]", JSON.stringify(splitLines("a\nb")) === JSON.stringify(["a", "b"]));
check("a\\nb\\n → [a,b,'']", JSON.stringify(splitLines("a\nb\n")) === JSON.stringify(["a", "b", ""]));
check("'' → ['']", JSON.stringify(splitLines("")) === JSON.stringify([""]));

console.log("computeHunks:");
{
	// Pure insertion (new file)
	const h = computeHunks("", "line1\nline2\n");
	check("new file → 1 insert hunk", h.length === 1, JSON.stringify(h));
	check("insert hunk oldText empty", h[0]?.oldText === "");
	check("insert hunk newText has 2 lines", h[0]?.newText.split("\n").length === 2);
	const c = countHunkLines(h);
	check("counts added=2 removed=0", c.added === 2 && c.removed === 0, JSON.stringify(c));
}
{
	// Pure deletion
	const h = computeHunks("a\nb\nc\n", "a\nc\n");
	check("deletion → 1 hunk", h.length === 1, JSON.stringify(h));
	check("deletion hunk newText empty", h[0]?.newText === "");
	check("deletion hunk oldText = b", h[0]?.oldText === "b");
	check("modified start = 2", h[0]?.modifiedStartLine === 2);
}
{
	// Single replacement
	const h = computeHunks("a\nold\nc\n", "a\nnew\nc\n");
	check("replacement → 1 hunk", h.length === 1, JSON.stringify(h));
	check("oldText = old", h[0]?.oldText === "old");
	check("newText = new", h[0]?.newText === "new");
	check("modified range 2..2", h[0]?.modifiedStartLine === 2 && h[0]?.modifiedEndLine === 2);
}
{
	// Multiple disjoint replacements
	const h = computeHunks("a\nb\nc\nd\ne\n", "x\nb\nc\ny\ne\n");
	check("2 disjoint hunks", h.length === 2, JSON.stringify(h));
	check("first hunk oldText a newText x", h[0]?.oldText === "a" && h[0]?.newText === "x");
	check("second hunk oldText d newText y", h[1]?.oldText === "d" && h[1]?.newText === "y");
}
{
	// Insertion in the middle
	const h = computeHunks("a\nb\n", "a\nmid\nb\n");
	check("insertion → 1 hunk", h.length === 1, JSON.stringify(h));
	check("insert oldText '' newText 'mid'", h[0]?.oldText === "" && h[0]?.newText === "mid");
	check("modified start 2", h[0]?.modifiedStartLine === 2);
}
{
	// No change
	const h = computeHunks("same\n", "same\n");
	check("identical content → 0 hunks", h.length === 0);
}

console.log("applyEditsToContent:");
{
	const out = applyEditsToContent("a\nb\nc\n", [{ oldText: "b", newText: "B" }], "f.txt");
	check("replace b→B", out === "a\nB\nc\n", JSON.stringify(out));
}
{
	// Multiple disjoint edits, applied in reverse internally
	const out = applyEditsToContent("one\ntwo\nthree\n", [
		{ oldText: "one", newText: "1" },
		{ oldText: "three", newText: "3" },
	], "f.txt");
	check("two disjoint edits", out === "1\ntwo\n3\n", JSON.stringify(out));
}
{
	// Duplicate oldText must throw
	let threw = false;
	try {
		applyEditsToContent("a\nb\na\n", [{ oldText: "a", newText: "x" }], "f.txt");
	} catch {
		threw = true;
	}
	check("duplicate oldText throws", threw);
}
{
	// Missing oldText must throw
	let threw = false;
	try {
		applyEditsToContent("a\nb\n", [{ oldText: "zzz", newText: "x" }], "f.txt");
	} catch {
		threw = true;
	}
	check("missing oldText throws", threw);
}
{
	// Overlapping edits must throw
	let threw = false;
	try {
		applyEditsToContent("abcdef", [
			{ oldText: "abc", newText: "X" },
			{ oldText: "bcd", newText: "Y" },
		], "f.txt");
	} catch {
		threw = true;
	}
	check("overlapping edits throw", threw);
}
{
	// CRLF preservation
	const out = applyEditsToContent("a\r\nb\r\nc\r\n", [{ oldText: "b", newText: "B" }], "f.txt");
	check("CRLF preserved", out === "a\r\nB\r\nc\r\n", JSON.stringify(out));
}
{
	// CRLF normalization for matching: LF oldText matches CRLF file, and the
	// matched region is fully replaced by the model's newText (Pi semantics).
	const out = applyEditsToContent("a\r\nb\r\nc\r\n", [{ oldText: "a\nb", newText: "AB" }], "f.txt");
	check("LF multi-line oldText matches CRLF file", out === "AB\r\nc\r\n", JSON.stringify(out));
}
{
	// Zero effective edits → "No changes made" error.
	let threw = false;
	try {
		applyEditsToContent("", [], "f.txt");
	} catch {
		threw = true;
	}
	check("empty edits throw", threw);
}

console.log("contentHash:");
{
	check("hash stable", contentHash("hello") === contentHash("hello"));
	check("hash differs", contentHash("hello") !== contentHash("hellp"));
}

console.log("computeInverseEdit (hunk rejection):");
{
	// Deletion reject: "a\nb\nc\n" → "a\nc\n" removes "b" at anchor line 2.
	const out = applyInverse("a\nc\n", "b", "", 2, 0);
	check("deletion restore in middle", out === "a\nb\nc\n", JSON.stringify(out));
}
{
	// Deletion at start of file.
	const out = applyInverse("c\n", "a\nb", "", 1, 0);
	check("deletion restore at start", out === "a\nb\nc\n", JSON.stringify(out));
}
{
	// Deletion at EOF without trailing newline: "a\nb" → "a" removes "b".
	const out = applyInverse("a", "b", "", 2, 0);
	check("deletion restore at EOF (no trailing NL)", out === "a\nb", JSON.stringify(out));
}
{
	// Deletion at EOF with trailing newline: "a\nb\n" → "a\n".
	const out = applyInverse("a\n", "b", "", 2, 0);
	check("deletion restore at EOF (trailing NL)", out === "a\nb\n", JSON.stringify(out));
}
{
	// Modification reject: "a\nnew\nc\n" → "a\nold\nc\n".
	const out = applyInverse("a\nnew\nc\n", "old", "new", 2, 2, "a\nold\nc\n", 2, 2);
	check("modification revert", out === "a\nold\nc\n", JSON.stringify(out));
}
{
	// Multi-line modification revert.
	const out = applyInverse("a\nx\ny\nc\n", "old1\nold2", "x\ny", 2, 3, "a\nold1\nold2\nc\n", 2, 3);
	check("multi-line modification revert", out === "a\nold1\nold2\nc\n", JSON.stringify(out));
}
{
	// Insertion reject (oldText empty → delete the inserted block INCLUDING its
	// trailing newline — previously left an empty line behind).
	const out = applyInverse("a\nmid\nb\n", "", "mid", 2, 2, "a\nb\n");
	check("insertion revert (delete incl. newline)", out === "a\nb\n", JSON.stringify(out));
}
{
	// Duplicated snippet: newText appears earlier in the file; the hunk points
	// at line 4, so the earlier occurrence must NOT be touched.
	const out = applyInverse("x\ny\nx\nx\n", "A", "x", 4, 4, "x\ny\nx\nA\n", 4, 4);
	check("duplicate text anchored to correct line", out === "x\ny\nx\nA\n", JSON.stringify(out));
}
{
	// Wrong location → stale (undefined).
	const out = applyInverse("a\nnew\nc\n", "old", "NEW", 2, 2, "a\nold\nc\n", 2, 2);
	check("mismatched content → stale", out === "STALE", JSON.stringify(out));
}
{
	// CRLF preserved through a modification revert using REAL raw hunk texts
	// (lines keep their \r).
	const out = applyInverse("a\r\nnew\r\nc\r\n", "old\r", "new\r", 2, 2, "a\r\nold\r\nc\r\n", 2, 2);
	check("CRLF modification revert", out === "a\r\nold\r\nc\r\n", JSON.stringify(out));
}
{
	// Trailing-newline fidelity: original had "\n", modified dropped it.
	const out = applyInverse("a\nnew", "old", "new", 2, 2, "a\nold\n", 2, 2);
	check("restores trailing newline", out === "a\nold\n", JSON.stringify(out));
}
console.log("lineStartOffset:");
{
	check("line 1 → 0", lineStartOffset("a\nb\n", 1) === 0);
	check("line 2 → 2", lineStartOffset("a\nb\n", 2) === 2);
	check("line 3 → 4", lineStartOffset("a\nb\n", 3) === 4);
	check("line beyond EOF → length", lineStartOffset("a\n", 5) === 2);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
