import type { Terminal } from "@xterm/xterm";

/**
 * pi-tui's full re-render (resize, a change above the viewport, a large
 * shrink) writes `\x1b[2J\x1b[H\x1b[3J` — clear screen, home, clear
 * scrollback — and then EVERY line of the transcript again, inside a
 * synchronized-output block (`\x1b[?2026h … \x1b[?2026l`).
 *
 * CodePi used to strip the scrollback clear to protect the reader's scroll
 * position, but then each full redraw appended a complete second copy of the
 * session below the first (a resize mid-stream left three copies). The
 * redraw re-writes the whole history, so the clear is correct; what needs
 * protecting is only the position. This writer lets the clear through,
 * snapshots where the reader is just before it, and restores that position
 * by content once the redraw block ends.
 */

/** Any CSI-J whose first parameter is 3 (xterm treats them all as ED3). */
const ED3 = /\x1b\[\??3(?:[;:][0-9?;:]*)?J/;
const SYNC_END = "\x1b[?2026l";
const SYNC_BEGIN = "\x1b[?2026h";
/** Enough of a previous chunk to catch a sequence split across writes. */
const CARRY = 16;

export interface ViewSnapshot {
	/** The viewport was at the bottom (following output). */
	atBottom: boolean;
	/** Lines between the viewport top and the end of the buffer. */
	linesFromEnd: number;
	/** Up to three non-blank viewport lines (offset from the top, text). */
	lines: Array<{ offset: number; text: string }>;
}

const lineText = (term: Terminal, y: number): string =>
	(term.buffer.active.getLine(y)?.translateToString(true) ?? "").trimEnd();

export function snapshotView(term: Terminal): ViewSnapshot {
	const b = term.buffer.active;
	const top = b.viewportY;
	const lines: ViewSnapshot["lines"] = [];
	for (let off = 0; off < term.rows && lines.length < 3; off++) {
		const text = lineText(term, top + off);
		if (text.trim()) lines.push({ offset: off, text });
	}
	return { atBottom: top >= b.baseY, linesFromEnd: b.length - top, lines };
}

/**
 * Two screen lines show the same content. After a resize, pi re-wraps every
 * line, so a row's text can be a longer or shorter piece of the same logical
 * line: one being a prefix of the other (of some length) counts as a match.
 */
function sameLine(a: string, b: string): boolean {
	if (a === b) return true;
	const n = Math.min(a.length, b.length);
	return n >= 12 && (a.startsWith(b) || b.startsWith(a));
}

/**
 * Put the viewport back on the snapshot's content: the matching block of
 * lines closest to the old distance from the end, or that distance alone
 * when the text is gone. Returns the new viewport top.
 */
export function restoreView(term: Terminal, snap: ViewSnapshot): number {
	const b = term.buffer.active;
	if (snap.atBottom) {
		term.scrollToBottom();
		return b.viewportY;
	}
	const expected = Math.max(0, b.length - snap.linesFromEnd);
	let best = -1;
	if (snap.lines.length > 0) {
		const [first, ...rest] = snap.lines;
		// Rows of the first line's text: prefer the one whose neighbours
		// still match (after a re-wrap they move, so they only break ties),
		// then the one closest to the old distance from the end.
		let bestScore = -1;
		const consider = (top: number, score: number) => {
			if (
				score > bestScore ||
				(score === bestScore && Math.abs(top - expected) < Math.abs(best - expected))
			) {
				best = top;
				bestScore = score;
			}
		};
		for (let y = 0; y < b.length; y++) {
			if (lineText(term, y) !== first.text) continue;
			const top = Math.max(0, y - first.offset);
			consider(top, rest.filter((l) => lineText(term, top + l.offset) === l.text).length);
		}
		// The text itself was re-wrapped: start of the same text.
		if (best < 0) {
			for (let y = 0; y < b.length; y++) {
				if (sameLine(lineText(term, y), first.text)) consider(Math.max(0, y - first.offset), 0);
			}
		}
	}
	const target = Math.min(best >= 0 ? best : expected, b.baseY);
	term.scrollToLine(target);
	return target;
}

export interface FullRedrawWriter {
	/** Write pi's output to the terminal. */
	write(data: string): void;
	/**
	 * Call just before the terminal is resized. xterm reflows the old
	 * screen first (pi pads its lines to the width, so narrowing splits each
	 * one in two) and pi's redraw arrives later, so the reader's place must
	 * be taken from the layout they were reading.
	 */
	beforeResize(): void;
}

/** How long a pre-resize snapshot waits for pi's redraw. */
const RESIZE_SNAPSHOT_MS = 2000;

/**
 * Wrap term.write for pi's output stream. `onRestored` runs after a redraw
 * put the reader back, so the viewport anchor can re-point its marker.
 */
export function createFullRedrawWriter(
	term: Terminal,
	onRestored?: () => void,
	now: () => number = Date.now,
): FullRedrawWriter {
	let carry = "";
	let pending: ViewSnapshot | undefined; // a redraw is in progress
	let inSync = false;
	// The place before a resize (or several in a row) that pi has not
	// redrawn for yet.
	let resized: { snap: ViewSnapshot; at: number } | undefined;

	const write = (data: string): void => {
		const scan = carry + data;
		const fresh = carry.length; // scan[fresh..] is new data
		carry = scan.slice(-CARRY);
		// A clear that ends inside the new data (it may have started in the
		// carried tail) begins a redraw: snapshot before xterm parses it.
		let clears = false;
		for (const m of scan.matchAll(new RegExp(ED3.source, "g"))) {
			if (m.index + m[0].length > fresh) clears = true;
		}
		if (clears && !pending) {
			const recent = resized && now() - resized.at <= RESIZE_SNAPSHOT_MS;
			pending = recent && resized ? resized.snap : snapshotView(term);
			resized = undefined;
		}

		// Track the synchronized-output block the redraw lives in; a clear
		// outside any block (or a block that ends in this chunk) completes now.
		const lastBegin = scan.lastIndexOf(SYNC_BEGIN);
		const lastEnd = scan.lastIndexOf(SYNC_END);
		if (lastBegin > lastEnd) inSync = true;
		else if (lastEnd > lastBegin) inSync = false;

		const finish = pending !== undefined && !inSync;
		const snap = finish ? pending : undefined;
		if (finish) pending = undefined;
		term.write(data, () => {
			if (!snap) return;
			restoreView(term, snap);
			onRestored?.();
		});
	};

	const beforeResize = (): void => {
		const t = now();
		// Keep the first snapshot of a burst of resizes: later ones would
		// see the layout xterm already reflowed.
		if (resized && t - resized.at <= RESIZE_SNAPSHOT_MS) resized.at = t;
		else resized = { snap: snapshotView(term), at: t };
	};

	return { write, beforeResize };
}
