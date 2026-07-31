import { describe, expect, it, vi } from "vitest";
import { WebviewTerminal } from "../tui/webview-terminal";

function makeTerminal() {
	const send = vi.fn();
	const term = new WebviewTerminal(send);
	return { term, send };
}

describe("WebviewTerminal", () => {
	it("forwards write() as tui:write once ready", () => {
		const { term, send } = makeTerminal();
		term.handleReady();
		term.write("\x1b[31mhi");
		expect(send).toHaveBeenCalledWith({ command: "tui:write", data: "\x1b[31mhi" });
	});

	it("buffers writes until ready, then flushes in order", () => {
		const { term, send } = makeTerminal();
		term.write("a");
		term.write("b");
		expect(send).not.toHaveBeenCalled();
		term.handleReady();
		expect(send).toHaveBeenNthCalledWith(1, { command: "tui:write", data: "a" });
		expect(send).toHaveBeenNthCalledWith(2, { command: "tui:write", data: "b" });
		term.write("c");
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("maps cursor/clear ops to ANSI via write", () => {
		const { term, send } = makeTerminal();
		term.handleReady();
		send.mockClear();
		term.hideCursor();
		term.showCursor();
		term.clearLine();
		term.clearFromCursor();
		term.clearScreen();
		term.moveBy(2);
		term.moveBy(-3);
		expect(send).toHaveBeenNthCalledWith(1, { command: "tui:write", data: "\x1b[?25l" });
		expect(send).toHaveBeenNthCalledWith(2, { command: "tui:write", data: "\x1b[?25h" });
		expect(send).toHaveBeenNthCalledWith(3, { command: "tui:write", data: "\x1b[K" });
		expect(send).toHaveBeenNthCalledWith(4, { command: "tui:write", data: "\x1b[0J" });
		expect(send).toHaveBeenNthCalledWith(5, { command: "tui:write", data: "\x1b[2J\x1b[H" });
		expect(send).toHaveBeenNthCalledWith(6, { command: "tui:write", data: "\x1b[2B" });
		expect(send).toHaveBeenNthCalledWith(7, { command: "tui:write", data: "\x1b[3A" });
	});

	it("sends title and progress as structured messages", () => {
		const { term, send } = makeTerminal();
		term.setTitle("pi - hello - repo");
		term.setProgress(true);
		expect(send).toHaveBeenNthCalledWith(1, { command: "tui:title", title: "pi - hello - repo" });
		expect(send).toHaveBeenNthCalledWith(2, { command: "tui:progress", active: true });
	});

	it("routes input and resize to handlers; resize updates columns/rows", () => {
		const { term } = makeTerminal();
		const onInput = vi.fn();
		const onResize = vi.fn();
		term.start(onInput, onResize);
		term.handleInput("\r");
		expect(onInput).toHaveBeenCalledWith("\r");
		term.handleResize(120, 40);
		expect(term.columns).toBe(120);
		expect(term.rows).toBe(40);
		expect(onResize).toHaveBeenCalledOnce();
		term.stop();
		term.handleInput("x");
		expect(onInput).toHaveBeenCalledTimes(1);
	});

	it("never advertises kitty protocol", () => {
		const { term } = makeTerminal();
		expect(term.kittyProtocolActive).toBe(false);
	});

	it("drainInput resolves immediately", async () => {
		const { term } = makeTerminal();
		await expect(term.drainInput()).resolves.toBeUndefined();
	});
});
