import * as vscode from "vscode";

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
 * Adapts pi's InteractiveMode terminal to a VS Code integrated terminal
 * (editor area) via the Pseudoterminal API.
 *
 * Implements BOTH interfaces:
 *  - `TuiTerminal`: what pi's InteractiveMode renders into (the SDK's
 *    terminal-injection patch accepts it as `options.terminal`).
 *  - `vscode.Pseudoterminal`: what VS Code's integrated terminal reads from
 *    and writes to.
 *
 * Every renderer operation is translated to ANSI escape sequences pushed
 * through `onDidWrite` (VS Code's terminal renderer parses ANSI natively),
 * except `setTitle`/`setProgress` which update the terminal's display name
 * via `onDidChangeName`. Writes issued before VS Code calls `open()` are
 * buffered and flushed in order.
 */
export class TuiPty implements TuiTerminal, vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<void>();
	private readonly nameEmitter = new vscode.EventEmitter<string>();

	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _columns = 80;
	private _rows = 24;
	private _title: string;
	private _progress = false;
	private opened = false;
	private openWaiters: Array<() => void> = [];
	private pendingWrite: string[] = [];

	constructor(
		initialTitle: string,
		private readonly onRequestClose: () => void,
	) {
		this._title = initialTitle;
	}

	// ── vscode.Pseudoterminal ────────────────────────────────

	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidClose = this.closeEmitter.event;
	readonly onDidChangeName = this.nameEmitter.event;

	open(initialDimensions?: vscode.TerminalDimensions): void {
		if (this.opened) return;
		this.opened = true;
		if (initialDimensions) {
			this._columns = initialDimensions.columns;
			this._rows = initialDimensions.rows;
		}
		for (const w of this.openWaiters) w();
		this.openWaiters = [];
		for (const data of this.pendingWrite) {
			this.writeEmitter.fire(data);
		}
		this.pendingWrite = [];
		this.resizeHandler?.();
	}

	close(): void {
		this.onRequestClose();
	}

	handleInput(data: string): void {
		this.inputHandler?.(data);
	}

	setDimensions(dimensions: vscode.TerminalDimensions): void {
		this._columns = dimensions.columns;
		this._rows = dimensions.rows;
		this.resizeHandler?.();
	}

	/** Resolves once VS Code has opened the terminal (or immediately if open). */
	waitForOpen(): Promise<void> {
		if (this.opened) return Promise.resolve();
		return new Promise((resolve) => this.openWaiters.push(resolve));
	}

	// ── TuiTerminal (pi's InteractiveMode render target) ─────

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
		this.pendingWrite = [];
	}

	async drainInput(): Promise<void> {
		/* no real tty to drain */
	}

	write(data: string): void {
		if (!this.opened) {
			this.pendingWrite.push(data);
			return;
		}
		this.writeEmitter.fire(data);
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
		this.nameEmitter.fire(title + (this._progress ? " ●" : ""));
	}

	setProgress(active: boolean): void {
		this._progress = active;
		this.nameEmitter.fire(this._title + (active ? " ●" : ""));
	}
}
