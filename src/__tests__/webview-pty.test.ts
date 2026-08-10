import { describe, expect, it, vi } from "vitest";

// Minimal vscode stub: WebviewPty only needs the Webview type at runtime,
// and postMessage() must be reachable (mock returns a fake webview below).
vi.mock("vscode", () => ({ WebviewPanel: class {} }));

import { WebviewPty } from "../tui/webview-pty";

function makePty() {
	const onRequestClose = vi.fn();
	const onTitleChange = vi.fn();
	const posted: Array<{ command: string; data?: string }> = [];
	const webview = {
		postMessage: (msg: { command: string; data?: string }) => {
			posted.push(msg);
			return Promise.resolve();
		},
	} as any;
	const pty = new WebviewPty(
		webview,
		"pi - hello - repo",
		onRequestClose,
		onTitleChange,
	);
	return { pty, webview, posted, onRequestClose, onTitleChange };
}

describe("WebviewPty", () => {
	it("buffers writes until ready, then flushes in order", () => {
		const { pty, posted } = makePty();
		pty.write("a");
		pty.write("b");
		expect(posted).toEqual([]);
		pty.markReady();
		expect(posted).toEqual([
			{ command: "tuiData", data: "a" },
			{ command: "tuiData", data: "b" },
		]);
		pty.write("c");
		expect(posted[2]).toEqual({ command: "tuiData", data: "c" });
	});

	it("markReady resolves waitForReady", async () => {
		const { pty } = makePty();
		const ready = pty.waitForReady();
		pty.markReady();
		await expect(ready).resolves.toBeUndefined();
	});

	it("waitForReady resolves immediately when already ready", async () => {
		const { pty } = makePty();
		pty.markReady();
		await expect(pty.waitForReady()).resolves.toBeUndefined();
	});

	it("setDimensions updates size and calls the resize handler", () => {
		const { pty } = makePty();
		const onResize = vi.fn();
		pty.start(() => {}, onResize);
		pty.markReady();
		onResize.mockClear();
		pty.setDimensions(100, 30);
		expect(pty.columns).toBe(100);
		expect(pty.rows).toBe(30);
		expect(onResize).toHaveBeenCalledOnce();
	});

	it("start() enables bracketed paste mode (\x1b[?2004h) like a real terminal", () => {
		const { pty, posted } = makePty();
		pty.markReady();
		pty.start(
			() => {},
			() => {},
		);
		// The enable sequence is written once on start.
		const bpmWrites = posted.filter((m) => m.data === "\x1b[?2004h");
		expect(bpmWrites.length).toBe(1);
		// stop() mirrors the disable sequence.
		pty.stop();
		expect(posted.some((m) => m.data === "\x1b[?2004l")).toBe(true);
	});

	it("routes handleInput to the input handler registered via start()", () => {
		const { pty } = makePty();
		const onInput = vi.fn();
		pty.start(onInput, () => {});
		pty.handleInput("\r");
		expect(onInput).toHaveBeenCalledWith("\r");
		pty.stop();
		pty.handleInput("x");
		expect(onInput).toHaveBeenCalledTimes(1);
	});

	it("calls onTitleChange on setTitle, with a busy suffix while progress is on", () => {
		const { pty, onTitleChange } = makePty();
		pty.setTitle("pi - hello - repo");
		pty.setProgress(true);
		pty.setProgress(false);
		expect(onTitleChange).toHaveBeenNthCalledWith(1, "pi - hello - repo");
		expect(onTitleChange).toHaveBeenNthCalledWith(2, "pi - hello - repo ●");
		expect(onTitleChange).toHaveBeenNthCalledWith(3, "pi - hello - repo");
	});

	it("maps cursor/clear ops to ANSI via tuiData once ready", () => {
		const { pty, posted } = makePty();
		pty.markReady();
		posted.length = 0;
		pty.hideCursor();
		pty.showCursor();
		pty.clearLine();
		pty.clearFromCursor();
		pty.clearScreen();
		pty.moveBy(2);
		pty.moveBy(-3);
		expect(posted.map((m) => m.data)).toEqual([
			"\x1b[?25l",
			"\x1b[?25h",
			"\x1b[K",
			"\x1b[0J",
			"\x1b[2J\x1b[H",
			"\x1b[2B",
			"\x1b[3A",
		]);
	});

	it("never advertises kitty protocol; drainInput resolves and marks the session as quitting", async () => {
		const { pty } = makePty();
		expect(pty.kittyProtocolActive).toBe(false);
		expect(pty.quitting).toBe(false);
		await expect(pty.drainInput()).resolves.toBeUndefined();
		expect(pty.quitting).toBe(true);
	});

	it("requestClose invokes onRequestClose", () => {
		const { pty, onRequestClose } = makePty();
		pty.requestClose();
		expect(onRequestClose).toHaveBeenCalledOnce();
	});

	it("setProgress reports busy state via onProgressChange", () => {
		const onProgressChange = vi.fn();
		const onTitleChange = vi.fn();
		const webview = { postMessage: vi.fn() } as any;
		const pty = new WebviewPty(
			webview,
			"pi",
			() => {},
			onTitleChange,
			onProgressChange,
		);
		pty.setProgress(true);
		pty.setProgress(false);
		expect(onProgressChange).toHaveBeenNthCalledWith(1, true);
		expect(onProgressChange).toHaveBeenNthCalledWith(2, false);
	});
});

describe("setTitle", () => {
	it("passes the tab title through to the title change callback", () => {
		const onTitleChange = vi.fn();
		const webview = { postMessage: vi.fn() } as any;
		const pty = new WebviewPty(webview, "initial", () => {}, onTitleChange);
		pty.setTitle("codepi - repo");
		expect(onTitleChange).toHaveBeenCalledWith("codepi - repo");
	});
});
