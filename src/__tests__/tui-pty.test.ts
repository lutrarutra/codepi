import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
	class EventEmitter<T> {
		listeners: Array<(value: T) => void> = [];
		event = (listener: (value: T) => void) => {
			this.listeners.push(listener);
			return { dispose: () => void 0 };
		};
		fire(value: T): void {
			for (const l of this.listeners) l(value);
		}
		dispose(): void {
			this.listeners = [];
		}
	}
	return { EventEmitter };
});

import { TuiPty } from "../tui/tui-pty";

function makePty() {
	const onRequestClose = vi.fn();
	const pty = new TuiPty("pi - hello - repo", onRequestClose);
	return { pty, onRequestClose };
}

describe("TuiPty", () => {
	it("buffers writes until open, then flushes in order", () => {
		const { pty } = makePty();
		const writes: string[] = [];
		pty.onDidWrite((d) => writes.push(d));
		pty.write("a");
		pty.write("b");
		expect(writes).toEqual([]);
		pty.open({ columns: 120, rows: 40 });
		expect(writes).toEqual(["a", "b"]);
		pty.write("c");
		expect(writes).toEqual(["a", "b", "c"]);
	});

	it("open() records dimensions and resolves waitForOpen", async () => {
		const { pty } = makePty();
		const opened = pty.waitForOpen();
		pty.open({ columns: 132, rows: 43 });
		await expect(opened).resolves.toBeUndefined();
		expect(pty.columns).toBe(132);
		expect(pty.rows).toBe(43);
		// second open is a no-op
		pty.open({ columns: 10, rows: 10 });
		expect(pty.columns).toBe(132);
	});

	it("waitForOpen resolves immediately when already open", async () => {
		const { pty } = makePty();
		pty.open({ columns: 80, rows: 24 });
		await expect(pty.waitForOpen()).resolves.toBeUndefined();
	});

	it("setDimensions updates size and calls the resize handler", () => {
		const { pty } = makePty();
		const onResize = vi.fn();
		pty.start(() => {}, onResize);
		pty.open({ columns: 80, rows: 24 });
		onResize.mockClear();
		pty.setDimensions({ columns: 100, rows: 30 });
		expect(pty.columns).toBe(100);
		expect(pty.rows).toBe(30);
		expect(onResize).toHaveBeenCalledOnce();
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

	it("fires onDidChangeName on setTitle, with a busy suffix while progress is on", () => {
		const { pty } = makePty();
		const names: string[] = [];
		pty.onDidChangeName((n) => names.push(n));
		pty.setTitle("pi - hello - repo");
		pty.setProgress(true);
		pty.setProgress(false);
		expect(names).toEqual([
			"pi - hello - repo",
			"pi - hello - repo ●",
			"pi - hello - repo",
		]);
	});

	it("maps cursor/clear ops to ANSI via onDidWrite once open", () => {
		const { pty } = makePty();
		const writes: string[] = [];
		pty.onDidWrite((d) => writes.push(d));
		pty.open({ columns: 80, rows: 24 });
		pty.hideCursor();
		pty.showCursor();
		pty.clearLine();
		pty.clearFromCursor();
		pty.clearScreen();
		pty.moveBy(2);
		pty.moveBy(-3);
		expect(writes).toEqual([
			"\x1b[?25l",
			"\x1b[?25h",
			"\x1b[K",
			"\x1b[0J",
			"\x1b[2J\x1b[H",
			"\x1b[2B",
			"\x1b[3A",
		]);
	});

	it("never advertises kitty protocol; drainInput resolves", async () => {
		const { pty } = makePty();
		expect(pty.kittyProtocolActive).toBe(false);
		await expect(pty.drainInput()).resolves.toBeUndefined();
	});

	it("close() invokes onRequestClose", () => {
		const { pty, onRequestClose } = makePty();
		pty.close();
		expect(onRequestClose).toHaveBeenCalledOnce();
	});
});
