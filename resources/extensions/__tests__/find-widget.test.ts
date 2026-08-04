/**
 * Find widget (Ctrl+F) regression tests — real xterm 6 + the real addon +
 * the real widget, driven in jsdom.
 *
 * The webview has no unit-test harness of its own; these tests live here
 * (like the scrollback-filter tests) because vitest includes this directory
 * and the root tsc never sees webview-ui imports. xterm is imported by
 * direct path into webview-ui's own node_modules (the version the webview
 * actually bundles); find.ts's bare imports resolve from webview-ui.
 *
 * The stubs make xterm's DOM-coupled services run headless: the canvas
 * renderer needs a 2D context, CoreBrowserService needs matchMedia, and the
 * viewport needs ResizeObserver.
 */
// @vitest-environment jsdom
import { describe, expect, it, beforeAll } from "vitest";
import { Terminal } from "../../../webview-ui/node_modules/@xterm/xterm/lib/xterm.mjs";
import { createFindWidget } from "../../../webview-ui/src/terminal/find";

beforeAll(() => {
	window.matchMedia = ((q: string) => ({
		matches: false,
		media: q,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent() {
			return false;
		},
	})) as any;
	if (!("ResizeObserver" in window)) {
		(window as any).ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
	(HTMLCanvasElement.prototype as any).getContext = () => new Proxy(
			{},
			{
				get(t: any, p: string | symbol) {
					if (p === "measureText") return () => ({ width: 10 });
					if (p === "createLinearGradient")
						return () => ({ addColorStop() {} });
					if (typeof p === "string" && !(p in t)) return () => {};
					return t[p];
				},
				set() {
					return true;
				},
			},
		);
});

function setup() {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const term = new Terminal({
		cols: 80,
		rows: 24,
		scrollback: 1000,
		allowProposedApi: true,
	});
	term.open(container);
	return { container, term };
}

/** Open the widget, type a query, and return the interaction helpers. */
async function openWidget(
	term: Terminal,
	container: HTMLElement,
	query: string,
) {
	const find = createFindWidget(term, container);
	find.open();
	const input = container.querySelector(".codepi-find-input") as HTMLInputElement;
	input.value = query;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	const key = (k: string) =>
		input.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: k,
				bubbles: true,
				cancelable: true,
			}),
		);
	const sel = () => term.getSelectionPosition();
	return { find, input, key, sel };
}

describe("find widget navigation", () => {
	it("walks matches in buffer order (down) and back (up)", async () => {
		const { container, term } = setup();
		for (let i = 1; i <= 10; i++) {
			term.write(`line ${i} has a target word here\r\n`);
		}
		await new Promise((r) => setTimeout(r, 30));
		const { key, sel } = await openWidget(term, container, "target");

		const down: number[] = [sel()!.start.y];
		for (let i = 0; i < 3; i++) {
			key("ArrowDown");
			down.push(sel()!.start.y);
		}
		expect(down).toEqual([0, 1, 2, 3]);

		const up: number[] = [];
		for (let i = 0; i < 3; i++) {
			key("ArrowUp");
			up.push(sel()!.start.y);
		}
		expect(up).toEqual([2, 1, 0]);
	});

	it("visits every match across wrapped lines (no skips)", async () => {
		const { container, term } = setup();
		// Long chat-style lines that wrap over multiple buffer rows, with
		// "target" straddling the wrap boundary (starts at col 56, cols = 60).
		for (let i = 1; i <= 6; i++) {
			const pad = "x".repeat(56 - 7); // "msg N: " (7 chars) + pad → col 56
			term.write(`msg ${i}: ${pad}target and trailing text ${i}\r\n`);
		}
		await new Promise((r) => setTimeout(r, 30));
		const { key, sel } = await openWidget(term, container, "target");

		const rows: number[] = [sel()!.start.y];
		for (let i = 0; i < 5; i++) {
			key("ArrowDown");
			rows.push(sel()!.start.y);
		}
		// one match per message, every message visited, strictly ascending
		expect(rows).toEqual([0, 2, 4, 6, 8, 10]);
	});

	it("keeps the current match when the buffer is repainted under it", async () => {
		// pi's TUI repaints the visible screen (2J + redraw) while responses
		// stream, replacing the text under the current match. The addon's
		// auto-research (200ms after output pauses) used to re-select from the
		// stale position and jump to an arbitrary nearby match — the widget
		// suppresses it, so the current match must not move.
		const { container, term } = setup();
		for (let i = 1; i <= 10; i++) {
			term.write(`line ${i} has a target word here\r\n`);
		}
		await new Promise((r) => setTimeout(r, 30));
		const { key, sel } = await openWidget(term, container, "target");
		key("ArrowDown");
		key("ArrowDown"); // current = line 3 (buffer row 2)
		const before = JSON.stringify(sel());

		term.write("\u001b[3;1Hline 3 repainted with different text\r\n");
		await new Promise((r) => setTimeout(r, 400)); // > auto-research window

		expect(JSON.stringify(sel())).toBe(before);
	});

	it("ArrowUp after a delete-line shift goes to the true previous match", async () => {
		// When rows shift (content shrink), navigation must continue from the
		// current match's tracked line, not the stale buffer row.
		const { container, term } = setup();
		for (let i = 1; i <= 10; i++) {
			term.write(`line ${i} has a target word here\r\n`);
		}
		await new Promise((r) => setTimeout(r, 30));
		const { key, sel } = await openWidget(term, container, "target");
		key("ArrowDown");
		key("ArrowDown");
		key("ArrowDown"); // current = line 4 (buffer row 3)

		// delete line 2 (1-based): lines 3..10 shift up by one
		term.write("\u001b[2;1H\u001b[M");
		await new Promise((r) => setTimeout(r, 30));

		key("ArrowUp");
		// current match (line 4) is now at row 2; previous (line 3) at row 1
		expect(sel()!.start.y).toBe(1);
	});
});
