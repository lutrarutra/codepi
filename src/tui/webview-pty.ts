import type * as vscode from "vscode";
import type { TuiTerminal } from "./tui-pty";

/**
 * Adapts pi's InteractiveMode terminal to a webview hosting xterm.js.
 *
 * Implements `TuiTerminal` (what pi's InteractiveMode renders into), but
 * instead of VS Code's integrated terminal (Pseudoterminal), every write is
 * forwarded to a webview panel via postMessage. xterm.js in the webview
 * parses the ANSI output natively — including truecolor, the kitty keyboard
 * protocol and full mouse support that VS Code's terminal renderer lacks.
 *
 * Data flow:
 *   InteractiveMode → WebviewPty.write() → postMessage { command: "tuiData" } → xterm.write()
 *   xterm.onData()  → postMessage { command: "tuiInput" } → WebviewPty.handleInput() → InteractiveMode
 *
 * Writes issued before the webview has finished initializing xterm are
 * buffered and flushed in order on markReady().
 */
export class WebviewPty implements TuiTerminal {
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _columns = 80;
	private _rows = 24;
	private _title: string;
	private _progress = false;
	private ready = false;
	private readyWaiters: Array<() => void> = [];
	private pendingWrite: string[] = [];

	/**
	 * True once pi's InteractiveMode starts shutting down (drainInput is only
	 * called on shutdown paths). Lets the extension's process.exit interception
	 * close this session's panel when pi requests exit.
	 */
	quitting = false;

	constructor(
		private readonly webview: vscode.Webview,
		initialTitle: string,
		private readonly onRequestClose: () => void,
		private readonly onTitleChange: (title: string) => void,
		private readonly onProgressChange?: (active: boolean) => void,
	) {
		this._title = initialTitle;
	}

	// ── TuiTerminal (pi's InteractiveMode render target) ─────

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;

		// Enable bracketed paste mode, exactly like pi's ProcessTerminal does
		// for a real terminal (it writes \x1b[?2004h in start()). xterm then
		// wraps every paste in \x1b[200~ … \x1b[201~ and pi's editor/input
		// components handle multi-line pastes as a unit. Without this, pasted
		// text with newlines is fed to the components as raw keystrokes and
		// comes out reordered/scrambled. The write is buffered until the
		// webview reports ready, so ordering is safe.
		this.write("\x1b[?2004h");
	}

	stop(): void {
		// Mirror ProcessTerminal.stop(): turn bracketed paste back off.
		this.write("\x1b[?2004l");
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
		this.pendingWrite = [];
	}

	async drainInput(): Promise<void> {
		// Called by pi only on InteractiveMode shutdown paths — marks this
		// session as the one that /quit (or a signal) is ending, so the
		// extension's process.exit interception closes the right panel.
		this.quitting = true;
	}

	write(data: string): void {
		if (!this.ready) {
			this.pendingWrite.push(data);
			return;
		}
		this.post({ command: "tuiData", data });
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
		this._title = title;
		this.onTitleChange(this._title + (this._progress ? " ●" : ""));
	}

	setProgress(active: boolean): void {
		this._progress = active;
		this.onTitleChange(this._title + (active ? " ●" : ""));
		this.onProgressChange?.(active);
	}

	// ── Webview message handlers ──────────────────────────────

	/** Called when the webview sends key input from xterm.onData(). */
	handleInput(data: string): void {
		this.inputHandler?.(data);
	}

	/** Called when the webview reports its terminal dimensions. */
	setDimensions(cols: number, rows: number): void {
		this._columns = cols;
		this._rows = rows;
		this.resizeHandler?.();
	}

	/** Called when the webview has finished initializing xterm. */
	markReady(): void {
		if (this.ready) return;
		this.ready = true;
		for (const w of this.readyWaiters) w();
		this.readyWaiters = [];
		for (const data of this.pendingWrite) {
			this.post({ command: "tuiData", data });
		}
		this.pendingWrite = [];
		// Notify the renderer of the initial dimensions (set via setDimensions
		// before markReady by the extension's tuiReady handler).
		this.resizeHandler?.();
	}

	/** Resolves once the webview has initialized xterm. */
	waitForReady(): Promise<void> {
		if (this.ready) return Promise.resolve();
		return new Promise((resolve) => this.readyWaiters.push(resolve));
	}

	/** Called by the extension when the user closes the panel. */
	requestClose(): void {
		this.onRequestClose();
	}

	private post(msg: unknown): void {
		try {
			this.webview.postMessage(msg);
		} catch {
			/* webview disposed */
		}
	}
}
