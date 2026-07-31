import type { TuiHostMessage } from "./protocol";

/**
 * Structural mirror of pi's `Terminal` interface (from @earendil-works/pi-tui).
 * Kept local so the extension needs no direct dependency on the TUI package.
 * Members must stay in sync with pi-tui's `Terminal`:
 * start/stop/drainInput/write/columns/rows/kittyProtocolActive/moveBy/
 * hideCursor/showCursor/clearLine/clearFromCursor/clearScreen/setTitle/setProgress.
 */
export interface TuiTerminal {
	start(onInput: (data: string) => void, onResize: () => void): void;
	stop(): void;
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;
	write(data: string): void;
	readonly columns: number;
	readonly rows: number;
	readonly kittyProtocolActive: boolean;
	moveBy(lines: number): void;
	hideCursor(): void;
	showCursor(): void;
	clearLine(): void;
	clearFromCursor(): void;
	clearScreen(): void;
	setTitle(title: string): void;
	setProgress(active: boolean): void;
}

/**
 * Bridges pi's InteractiveMode terminal output to a webview xterm.js instance.
 *
 * Every renderer operation is translated to ANSI escape sequences and pushed
 * through `write()` (xterm parses ANSI natively), except `setTitle` and
 * `setProgress` which become structured host messages. Writes issued before
 * the webview signals `tui:ready` are buffered and flushed in order, because
 * VS Code drops postMessage calls to a webview that has not loaded yet.
 */
export class WebviewTerminal implements TuiTerminal {
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _columns = 80;
	private _rows = 24;
	private ready = false;
	private pending: string[] = [];

	constructor(private readonly send: (msg: TuiHostMessage) => void) {}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
		this.pending = [];
	}

	async drainInput(): Promise<void> {
		/* no real tty to drain */
	}

	write(data: string): void {
		if (!this.ready) {
			this.pending.push(data);
			return;
		}
		this.send({ command: "tui:write", data });
	}

	get columns(): number {
		return this._columns;
	}

	get rows(): number {
		return this._rows;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(lines: number): void {
		const n = Math.abs(lines);
		this.write(`\x1b[${n}${lines < 0 ? "A" : "B"}`);
	}

	hideCursor(): void {
		this.write("\x1b[?25l");
	}

	showCursor(): void {
		this.write("\x1b[?25h");
	}

	clearLine(): void {
		this.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.write("\x1b[0J");
	}

	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}

	setTitle(title: string): void {
		this.send({ command: "tui:title", title });
	}

	setProgress(active: boolean): void {
		this.send({ command: "tui:progress", active });
	}

	/** Called by the extension when the webview reports xterm readiness. */
	handleReady(): void {
		if (this.ready) return;
		this.ready = true;
		for (const data of this.pending) {
			this.send({ command: "tui:write", data });
		}
		this.pending = [];
	}

	/** Called by the extension on `tui:input` webview messages. */
	handleInput(data: string): void {
		this.inputHandler?.(data);
	}

	/** Called by the extension on `tui:resize` webview messages. */
	handleResize(cols: number, rows: number): void {
		if (cols > 0) this._columns = cols;
		if (rows > 0) this._rows = rows;
		this.resizeHandler?.();
	}
}
