/**
 * TUI bridge protocol between the extension host (pi InteractiveMode) and the
 * terminal webview (xterm.js). Host messages flow extension → webview; webview
 * messages flow webview → extension.
 */

/** Host → webview: raw ANSI output, tab title, busy state. */
export type TuiHostMessage =
	| { command: "tui:write"; data: string }
	| { command: "tui:title"; title: string }
	| { command: "tui:progress"; active: boolean };

/** Webview → host: xterm ready, keystrokes, size changes. */
export type TuiWebviewMessage =
	| { command: "tui:ready" }
	| { command: "tui:input"; data: string }
	| { command: "tui:resize"; cols: number; rows: number };
