import { describe, expect, it } from "vitest";
import { Terminal } from "../../../webview-ui/node_modules/@xterm/xterm/lib/xterm.mjs";
import {
	createFullRedrawWriter,
	restoreView,
	snapshotView,
} from "../../../webview-ui/src/terminal/full-redraw";
import { createViewportAnchor } from "../../../webview-ui/src/terminal/viewport-anchor";

const drain = (t: Terminal): Promise<void> =>
	new Promise((resolve) => t.write("", resolve));

/** pi-tui's full render: sync block, clear screen + home + clear scrollback, every line. */
const fullRender = (lines: string[]): string =>
	`\x1b[?2026h\x1b[2J\x1b[H\x1b[3J${lines.join("\r\n")}\x1b[?2026l`;
const transcript = (n: number): string[] =>
	Array.from({ length: n }, (_, i) => `line-${String(i).padStart(3, "0")}`);
const allText = (t: Terminal): string[] => {
	const b = t.buffer.active;
	return Array.from({ length: b.length }, (_, y) => b.getLine(y)?.translateToString(true) ?? "");
};
const topLine = (t: Terminal): string =>
	t.buffer.active.getLine(t.buffer.active.viewportY)?.translateToString(true) ?? "";

describe("pi full redraw through createFullRedrawWriter (real xterm 6)", () => {
	it("leaves exactly one copy of the transcript (no duplicated history)", async () => {
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 40 });
		const { write } = createFullRedrawWriter(term);
		write(transcript(60).join("\r\n"));
		await drain(term);
		write(fullRender(transcript(65)));
		await drain(term);
		const text = allText(term);
		expect(text.filter((l) => l === "line-005")).toHaveLength(1);
		expect(text.filter((l) => l === "line-064")).toHaveLength(1);
	});

	it("puts a reader who scrolled up back on the same content", async () => {
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 40 });
		const { write } = createFullRedrawWriter(term);
		write(transcript(60).join("\r\n"));
		await drain(term);
		term.scrollLines(-20);
		const before = topLine(term);
		expect(term.buffer.active.viewportY).toBeLessThan(term.buffer.active.baseY);
		// The redraw adds output below the reader.
		write(fullRender(transcript(70)));
		await drain(term);
		expect(topLine(term)).toBe(before);
	});

	it("keeps a reader at the bottom following the output", async () => {
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 40 });
		const { write } = createFullRedrawWriter(term);
		write(transcript(30).join("\r\n"));
		await drain(term);
		write(fullRender(transcript(45)));
		await drain(term);
		const b = term.buffer.active;
		expect(b.viewportY).toBe(b.baseY);
	});

	it("handles a redraw split across several writes", async () => {
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 40 });
		const { write } = createFullRedrawWriter(term);
		write(transcript(60).join("\r\n"));
		await drain(term);
		term.scrollLines(-15);
		const before = topLine(term);
		const frame = fullRender(transcript(60));
		// Split inside the clear sequence and in the middle of the lines.
		const cut1 = frame.indexOf("\x1b[3J") + 3;
		write(frame.slice(0, cut1));
		write(frame.slice(cut1, 300));
		write(frame.slice(300));
		await drain(term);
		expect(topLine(term)).toBe(before);
		expect(allText(term).filter((l) => l === "line-010")).toHaveLength(1);
	});

	it("finds the reader's line again after a resize re-wrapped it", async () => {
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 40 });
		const { write } = createFullRedrawWriter(term);
		const items = Array.from({ length: 40 }, (_, i) => `${i}. item number ${i} has a long description that wraps`);
		// pi wraps to the terminal width itself.
		const wrap = (cols: number) => items.flatMap((t) => t.match(new RegExp(`.{1,${cols}}`, "g")) ?? []);
		write(wrap(40).join("\r\n"));
		await drain(term);
		term.scrollLines(-30);
		const before = topLine(term).trim();
		term.resize(60, 10);
		write(fullRender(wrap(60)));
		await drain(term);
		const after = topLine(term).trim();
		expect(after.startsWith(before.slice(0, 12)) || before.startsWith(after.slice(0, 12))).toBe(true);
	});

	it("keeps the reader's place when narrowing splits pi's padded lines", async () => {
		// pi pads every line to the width with real spaces, so xterm's own
		// reflow on a narrower resize splits each line in two before pi's
		// redraw arrives. Look-alike lines elsewhere must not win.
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 60 });
		const { write, beforeResize } = createFullRedrawWriter(term);
		const items = (cols: number) =>
			Array.from({ length: 80 }, (_, i) =>
				`${i % 40}. ${i < 40 ? "bird" : "fish"} entry`.padEnd(cols, " "),
			);
		write(items(60).join("\r\n"));
		await drain(term);
		term.scrollLines(-15);
		const before = topLine(term).trim();
		expect(before).toMatch(/fish/);
		beforeResize();
		term.resize(40, 10);
		write(fullRender(items(40)));
		await drain(term);
		expect(topLine(term).trim()).toBe(before);
	});

	it("falls back to the distance from the end when the text is gone", async () => {
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 40 });
		const { write } = createFullRedrawWriter(term);
		write(transcript(60).join("\r\n"));
		await drain(term);
		term.scrollLines(-20);
		const fromEnd = term.buffer.active.length - term.buffer.active.viewportY;
		write(fullRender(transcript(60).map((l) => l.toUpperCase())));
		await drain(term);
		const b = term.buffer.active;
		expect(b.length - b.viewportY).toBe(fromEnd);
	});

	it("snapshotView / restoreView round-trip without a redraw", async () => {
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 40 });
		term.write(transcript(40).join("\r\n"));
		await drain(term);
		term.scrollLines(-8);
		const snap = snapshotView(term);
		expect(snap.atBottom).toBe(false);
		term.scrollToTop();
		restoreView(term, snap);
		expect(topLine(term)).toBe(snap.lines[0].text);
	});

	it("documents xterm: a bare \\x1b[3J jumps a scrolled-up reader to the top", async () => {
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 40 });
		term.write(transcript(60).join("\r\n"));
		await drain(term);
		term.scrollLines(-20);
		term.write("\x1b[2J\x1b[H\x1b[3J");
		await drain(term);
		expect(term.buffer.active.viewportY).toBe(0);
	});
});

describe("createViewportAnchor (real xterm 6)", () => {
	const buildHistory = async (
		t: Terminal,
		lines = 60,
	): Promise<string> => {
		let out = "";
		for (let i = 0; i < lines; i++)
			out += `line-${String(i).padStart(2, "0")}\n`;
		t.write(out);
		await drain(t);
		return out;
	};

	it("restores the viewport to the anchored content after a yank", async () => {
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 40 });
		await buildHistory(term);
		const b = term.buffer.active;
		term.scrollLines(-20); // user scrolls up 20 lines
		const anchored = b.viewportY;
		const anchor = createViewportAnchor(term);
		anchor.noteUserScroll(); // user scroll anchors the viewport top
		// Let the grace window pass so the yank below is unambiguous.
		await new Promise((r) => setTimeout(r, 300));
		// Something yanks the viewport to the top (e.g. a resize-trim clamp
		// or a stray scrollback clear that survived the filter).
		term.scrollToTop();
		expect(b.viewportY).toBe(0);
		anchor.keepAnchored();
		expect(b.viewportY).toBe(anchored); // restored to the same content
		expect(b.baseY).toBeGreaterThan(0); // scrollback survived
		anchor.dispose();
	});

	it("does not fight the user's own scrolling (250ms grace window)", async () => {
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 40 });
		await buildHistory(term);
		const b = term.buffer.active;
		term.scrollLines(-20);
		const anchor = createViewportAnchor(term);
		anchor.noteUserScroll();
		term.scrollToTop();
		// Still inside the grace window after the user's own scroll.
		anchor.keepAnchored();
		expect(b.viewportY).toBe(0);
		// Once the window passes, restoration is allowed again.
		await new Promise((r) => setTimeout(r, 300));
		anchor.keepAnchored();
		expect(b.viewportY).toBeGreaterThan(0);
		anchor.dispose();
	});

	it("stays out of the way when the user is following the stream at the bottom", async () => {
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 40 });
		await buildHistory(term);
		const b = term.buffer.active;
		const anchor = createViewportAnchor(term);
		anchor.noteUserScroll(); // at the bottom: nothing to anchor
		// New content streams in at the bottom while the user is at the end.
		term.write("streaming more\n".repeat(5));
		await drain(term);
		anchor.keepAnchored();
		expect(b.viewportY).toBe(b.baseY); // still following at the bottom
		anchor.dispose();
	});

	it("survives content shifts: anchor follows the line, keepAnchored is a no-op", async () => {
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 40 });
		await buildHistory(term);
		const b = term.buffer.active;
		term.scrollLines(-20);
		const anchor = createViewportAnchor(term);
		anchor.noteUserScroll();
		const anchored = b.viewportY;
		// Normal streaming appends lines below the viewport: the anchor line
		// and the viewport both stay put, so keepAnchored must not move it.
		term.write("more content at the bottom\n".repeat(5));
		await drain(term);
		anchor.keepAnchored();
		expect(b.viewportY).toBe(anchored);
		anchor.dispose();
	});

	// Documents the xterm contract the guard relies on: while the buffer
	// service's isUserScrolling flag is set (which is exactly what the user's
	// wheel/drag scroll sets), streamed content leaves the viewport alone;
	// the yank-to-bottom (ydisp = ybase on every content scroll) only fires
	// when the flag is lost. terminal.ts sets scrollOnUserInput: false so a
	// keystroke (IME composition, arrows, typing) never silently drops the
	// flag — that yank is the "jerks itself back down" the guard was built
	// against.
	it("xterm yank primitive: content scroll snaps to bottom only when the user-scroll flag is lost", async () => {
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 40 });
		await buildHistory(term);
		const b = term.buffer.active;
		const core = (term as unknown as { _core: any })._core;
		term.scrollLines(-20);
		const scrolled = b.viewportY;
		expect(core._bufferService.isUserScrolling).toBe(true); // wheel path set it
		term.write("still streaming\n".repeat(5));
		await drain(term);
		expect(b.viewportY).toBe(scrolled); // flag held: no yank
		expect(b.baseY).toBeGreaterThan(scrolled);
		// Lose the flag (as a keystroke-driven scrollToBottom would) and the
		// very next content scroll snaps the viewport to the bottom.
		core._bufferService.isUserScrolling = false;
		term.write("more\n".repeat(2));
		await drain(term);
		expect(b.viewportY).toBe(b.baseY);
	});
});
