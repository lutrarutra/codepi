import { describe, expect, it } from "vitest";
import { Terminal } from "../../../webview-ui/node_modules/@xterm/xterm/lib/xterm.mjs";
import { createScrollbackClearFilter } from "../../../webview-ui/src/terminal/scrollback";

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
