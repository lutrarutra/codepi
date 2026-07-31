/**
 * Webview-side mirror of src/tui/protocol.ts (the webview cannot import from
 * the extension's src/ tree). Keep both files in sync.
 */

/** Host → webview messages. */
export type TuiHostMessage =
	| { command: "tui:write"; data: string }
	| { command: "tui:title"; title: string }
	| { command: "tui:progress"; active: boolean };

/** Webview → host messages. */
export type TuiWebviewMessage =
	| { command: "tui:ready" }
	| { command: "tui:input"; data: string }
	| { command: "tui:resize"; cols: number; rows: number };
