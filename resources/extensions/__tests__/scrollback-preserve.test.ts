import { describe, expect, it } from "vitest";
import { Terminal } from "../../../webview-ui/node_modules/@xterm/xterm/lib/xterm.mjs";
import { createScrollbackClearFilter } from "../../../webview-ui/src/terminal/scrollback";
import { createViewportAnchor } from "../../../webview-ui/src/terminal/viewport-anchor";

const drain = (t: Terminal): Promise<void> =>
	new Promise((resolve) => t.write("", resolve));

describe("createScrollbackClearFilter", () => {
	it("strips \\x1b[3J and leaves everything else intact", () => {
		const filter = createScrollbackClearFilter();
		const input =
			"\x1b[?2026h\x1b[2J\x1b[H\x1b[3Jline one\r\nline two\x1b[?2026l";
		expect(filter(input)).toBe(
			"\x1b[?2026h\x1b[2J\x1b[Hline one\r\nline two\x1b[?2026l",
		);
	});

	it("keeps output without 3J unchanged", () => {
		const filter = createScrollbackClearFilter();
		const input = "hello \x1b[31mred\x1b[0m\n";
		expect(filter(input)).toBe(input);
	});

	it("catches \\x1b[3J split across two chunks", () => {
		const filter = createScrollbackClearFilter();
		expect(filter("\x1b[2J\x1b[")).toBe("\x1b[2J");
		expect(filter("3Jrest")).toBe("rest");
	});

	it("holds a trailing ESC and catches the 3J after it", () => {
		const filter = createScrollbackClearFilter();
		expect(filter("plain")).toBe("plain");
		expect(filter("\x1b")).toBe(""); // held: lone ESC starts a sequence
		expect(filter("[3Jx")).toBe("x"); // split ESC+[3J caught
	});

	// xterm's ED handler switches on the FIRST parameter (params[0]), so any
	// CSI-J with first param 3 wipes the scrollback — not just the bare
	// \x1b[3J. Private-mode and multi-parameter variants must be stripped too.
	it.each([
		"\x1b[3J",
		"\x1b[?3J",
		"\x1b[3;0J",
		"\x1b[3:0J",
		"\x1b[?3;0J",
	])("strips the ED3 variant %j (first param 3 clears scrollback)", (seq) => {
		const filter = createScrollbackClearFilter();
		expect(filter(seq)).toBe("");
		expect(filter("x" + seq + "y")).toBe("xy");
	});

	// Sequences whose first param is NOT 3 (or that don't end in J) are not
	// scrollback clears — they must pass through untouched.
	it.each([
		"\x1b[0J", // ED 0: erase to end of screen
		"\x1b[2J", // ED 2: erase whole screen (keeps viewport)
		"\x1b[30J", // first param 30, not 3
		"\x1b[3A", // cursor up 3
		"\x1b[3;5m", // SGR
		"\x1b[3h", // DECSET
		"\x1b[H", // cursor home
	])("keeps the non-scrollback sequence %j", (seq) => {
		const filter = createScrollbackClearFilter();
		expect(filter(seq)).toBe(seq);
	});

	it("strips an ED3 variant split across chunks", () => {
		const filter = createScrollbackClearFilter();
		expect(filter("\x1b[2J\x1b[")).toBe("\x1b[2J");
		expect(filter("?3Jx")).toBe("x"); // \x1b[ + ?3J caught across chunks
	});

	it("strips every ED3 variant from a pi full-render stream", () => {
		const filter = createScrollbackClearFilter();
		const input =
			"\x1b[?2026h\x1b[2J\x1b[H\x1b[3;0Jline one\r\nline two\x1b[?2026l";
		expect(filter(input)).toBe(
			"\x1b[?2026h\x1b[2J\x1b[Hline one\r\nline two\x1b[?2026l",
		);
	});
});

describe("pi fullRender while the user is scrolled up (real xterm 6)", () => {
	// pi-tui's full re-render emits \x1b[2J\x1b[H\x1b[3J on terminal resize
	// and on content changes above the visible viewport (fires while the
	// final response streams). \x1b[3J (Erase Saved Lines) resets xterm's
	// viewport to the top (ydisp=0) and destroys the scrollback.

	it("preserves scroll position and history when the stream is filtered", async () => {
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 40 });
		const filter = createScrollbackClearFilter();
		let out = "";
		for (let i = 0; i < 60; i++) out += `line-${String(i).padStart(2, "0")}\n`;
		term.write(out);
		await drain(term);
		const b = term.buffer.active;
		term.scrollLines(-20); // user scrolls up 20 lines
		const scrolledYdisp = b.viewportY;
		expect(scrolledYdisp).toBeLessThan(b.baseY);
		// pi full render while scrolled up
		term.write(filter("\x1b[?2026h\x1b[2J\x1b[H\x1b[3Jnew screen\x1b[?2026l"));
		await drain(term);
		expect(b.viewportY).toBe(scrolledYdisp); // still scrolled up
		expect(b.baseY).toBeGreaterThan(0); // scrollback survived
	});

	it("documents the bug: unfiltered \\x1b[3J jumps to top and wipes history", async () => {
		const term = new Terminal({ scrollback: 1000, rows: 10, cols: 40 });
		let out = "";
		for (let i = 0; i < 60; i++) out += `line-${String(i).padStart(2, "0")}\n`;
		term.write(out);
		await drain(term);
		const b = term.buffer.active;
		term.scrollLines(-20);
		term.write("\x1b[2J\x1b[H\x1b[3J");
		await drain(term);
		expect(b.viewportY).toBe(0);
		expect(b.baseY).toBe(0);
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
