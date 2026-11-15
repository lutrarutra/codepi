import type { ProgramStatus } from "@earendil-works/pi-tui";

/**
 * Structural mirror of pi's `Terminal` interface (from @earendil-works/pi-tui).
 * Kept local so the extension needs no direct dependency on the TUI package
 * (only the type-only ProgramStatus import, erased at build time).
 * Members must stay in sync with pi-tui's `Terminal`:
 * start/stop/drainInput/write/columns/rows/kittyProtocolActive/moveBy/
 * hideCursor/showCursor/clearLine/clearFromCursor/clearScreen/setTitle/setProgress/
 * setProgramStatus.
 *
 * Implementations:
 *  - WebviewPty (webview hosting xterm.js — the default TUI render target)
 *  - TuiPty was the previous VS Code integrated terminal adapter; removed.
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
	setProgramStatus(status: ProgramStatus): void;
}
