/**
 * Pure line-diff utilities for edit review.
 *
 * Implements a line-based Myers diff and turns it into hunks (contiguous
 * changed regions) with line ranges in both the original and modified content.
 * All helpers are synchronous and dependency-free so they can be unit tested.
 */

import type { EditHunk } from "./types";

export interface LineDiffOp {
	type: "equal" | "add" | "remove";
	oldLine: number; // 1-based line number in original (0 for adds)
	newLine: number; // 1-based line number in modified (0 for removes)
	text: string;
}

/**
 * Split text into lines WITHOUT dropping the trailing empty segment caused by
 * a final newline. `"a\nb"` → `["a", "b"]`; `"a\nb\n"` → `["a", "b", ""]`.
 * An empty string → `[""]`.
 */
export function splitLines(text: string): string[] {
	if (text.length === 0) return [""];
	const lines = text.split("\n");
	// split("\n") on "a\n" yields ["a", ""] which already represents the
	// trailing newline — keep it.
	return lines.length === 0 ? [""] : lines;
}

/**
 * Myers O(ND) diff over two line arrays. Returns a list of ops ordered
 * top-to-bottom. Prefers removals before additions at equal cost so that
 * replace blocks read "old lines then new lines" (like a normal diff).
 */
export function diffLines(a: string[], b: string[]): LineDiffOp[] {
	const n = a.length;
	const m = b.length;
	const max = n + m;
	if (n === 0) {
		return b.map((text, j) => ({ type: "add" as const, oldLine: 0, newLine: j + 1, text }));
	}
	if (m === 0) {
		return a.map((text, i) => ({ type: "remove" as const, oldLine: i + 1, newLine: 0, text }));
	}

	// Standard Myers: trace the shortest edit path with a 1D offset array.
	const v: number[] = new Array(2 * max + 1);
	const trace: number[][] = [];
	v[max + 1] = 0;
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])) {
				x = v[max + k + 1]; // down (insert)
			} else {
				x = v[max + k - 1] + 1; // right (delete)
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[max + k] = x;
			if (x >= n && y >= m) {
				// Backtrack to build the op list.
				const ops: LineDiffOp[] = [];
				let px = n;
				let py = m;
				for (let dd = d; dd > 0; dd--) {
					const vv = trace[dd];
					const kk = px - py;
					let prevK: number;
					if (kk === -dd || (kk !== dd && vv[max + kk - 1] < vv[max + kk + 1])) {
						prevK = kk + 1;
					} else {
						prevK = kk - 1;
					}
					const prevX = vv[max + prevK];
					const prevY = prevX - prevK;
					while (px > prevX && py > prevY) {
						ops.push({ type: "equal", oldLine: px, newLine: py, text: a[px - 1] });
						px--;
						py--;
					}
					if (px === prevX) {
						ops.push({ type: "add", oldLine: 0, newLine: py, text: b[py - 1] });
						py--;
					} else {
						ops.push({ type: "remove", oldLine: px, newLine: 0, text: a[px - 1] });
						px--;
					}
				}
				while (px > 0 && py > 0) {
					ops.push({ type: "equal", oldLine: px, newLine: py, text: a[px - 1] });
					px--;
					py--;
				}
				while (px > 0) {
					ops.push({ type: "remove", oldLine: px, newLine: 0, text: a[px - 1] });
					px--;
				}
				while (py > 0) {
					ops.push({ type: "add", oldLine: 0, newLine: py, text: b[py - 1] });
					py--;
				}
				ops.reverse();
				return ops;
			}
		}
	}
	// Unreachable for finite inputs; fall back to full replace.
	return [
		...a.map((text, i) => ({ type: "remove" as const, oldLine: i + 1, newLine: 0, text })),
		...b.map((text, j) => ({ type: "add" as const, oldLine: 0, newLine: j + 1, text })),
	];
}

/** Merge adjacent/overlapping ops into contiguous hunks. */
export function opsToHunks(ops: LineDiffOp[]): Array<{
	oldStart: number;
	oldEnd: number; // inclusive; 0 = empty
	newStart: number;
	newEnd: number; // inclusive; 0 = empty
	oldText: string;
	newText: string;
}> {
	const hunks: Array<{
		oldStart: number;
		oldEnd: number;
		newStart: number;
		newEnd: number;
		oldText: string;
		newText: string;
	}> = [];

	let cur: {
		oldStart: number;
		oldEnd: number;
		newStart: number;
		newEnd: number;
		oldLines: string[];
		newLines: string[];
		seenRemove: boolean;
		seenAdd: boolean;
	} | undefined;

	function flush() {
		if (!cur) return;
		hunks.push({
			oldStart: cur.oldStart,
			oldEnd: cur.seenRemove ? cur.oldEnd : 0,
			newStart: cur.newStart,
			newEnd: cur.seenAdd ? cur.newEnd : 0,
			oldText: cur.oldLines.join("\n"),
			newText: cur.newLines.join("\n"),
		});
		cur = undefined;
	}

	// Track the current line in each document as we walk the op list so we can
	// compute hunk start lines even when a hunk begins with a remove op (whose
	// op.newLine is 0).
	let oldLine = 0;
	let newLine = 0;

	for (const op of ops) {
		if (op.type === "equal") {
			oldLine = op.oldLine;
			newLine = op.newLine;
			flush();
			continue;
		}
		if (!cur) {
			cur = {
				oldStart: oldLine + 1,
				oldEnd: oldLine,
				newStart: newLine + 1,
				newEnd: newLine,
				oldLines: [],
				newLines: [],
				seenRemove: false,
				seenAdd: false,
			};
		}
		if (op.type === "remove") {
			cur.oldLines.push(op.text);
			cur.oldEnd = Math.max(cur.oldEnd, op.oldLine);
			cur.seenRemove = true;
			oldLine = op.oldLine;
		} else {
			cur.newLines.push(op.text);
			cur.newEnd = Math.max(cur.newEnd, op.newLine);
			cur.seenAdd = true;
			newLine = op.newLine;
		}
	}
	flush();

	// Merge adjacent hunks separated by NO equal line (can happen at block
	// boundaries when an add immediately follows a remove of a different hunk).
	const merged: typeof hunks = [];
	for (const h of hunks) {
		const last = merged[merged.length - 1];
		if (
			last &&
			last.oldEnd >= h.oldStart - 1 &&
			last.newEnd >= h.newStart - 1 &&
			last.oldEnd === h.oldStart - 1 &&
			last.newEnd === h.newStart - 1
		) {
			merged[merged.length - 1] = {
				oldStart: last.oldStart,
				oldEnd: h.oldEnd,
				newStart: last.newStart,
				newEnd: h.newEnd,
				oldText: `${last.oldText}${last.oldText && h.oldText ? "\n" : ""}${h.oldText}`,
				newText: `${last.newText}${last.newText && h.newText ? "\n" : ""}${h.newText}`,
			};
			continue;
		}
		merged.push(h);
	}
	return merged;
}

let hunkCounter = 0;

/** Compute hunks between original and modified content. */
export function computeHunks(
	originalContent: string,
	modifiedContent: string,
): EditHunk[] {
	const a = splitLines(originalContent);
	const b = splitLines(modifiedContent);
	const ops = diffLines(a, b);
	return opsToHunks(ops).map((h) => ({
		hunkId: `h-${++hunkCounter}`,
		originalStartLine: h.oldStart,
		originalEndLine: h.oldEnd,
		modifiedStartLine: h.newStart,
		modifiedEndLine: h.newEnd,
		oldText: h.oldText,
		newText: h.newText,
		status: "pending",
	}));
}

/** Count lines added/removed across hunks. */
export function countHunkLines(hunks: EditHunk[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const h of hunks) {
		if (h.oldText.length > 0) removed += h.oldText.split("\n").length;
		if (h.newText.length > 0) added += h.newText.split("\n").length;
	}
	return { added, removed };
}

/** Simple FNV-1a content hash (fast, adequate for stale detection). */
export function contentHash(content: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < content.length; i++) {
		hash ^= content.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
