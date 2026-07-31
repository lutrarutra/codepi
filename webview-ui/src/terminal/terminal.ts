import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TuiHostMessage, TuiWebviewMessage } from "./protocol";

const vscode = acquireVsCodeApi();

function post(msg: TuiWebviewMessage): void {
	vscode.postMessage(msg);
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

const term = new Terminal({
	cursorBlink: true,
	fontFamily: 'Menlo, Monaco, "Courier New", monospace',
	fontSize: 13,
	scrollback: 10_000,
});

const fit = new FitAddon();
term.loadAddon(fit);
term.open(root);
try {
	fit.fit();
} catch {
	/* layout not ready yet */
}
term.focus();

term.onData((data) => post({ command: "tui:input", data }));

// Keep the terminal sized to the webview; report size so the TUI reflows.
function reportSize(): void {
	try {
		fit.fit();
	} catch {
		/* ignore transient layout errors */
	}
	post({ command: "tui:resize", cols: term.cols, rows: term.rows });
}
const observer = new ResizeObserver(reportSize);
observer.observe(root);
window.addEventListener("resize", reportSize);

window.addEventListener("message", (event: MessageEvent) => {
	const msg = (event.data ?? {}) as Partial<TuiHostMessage>;
	if (msg.command === "tui:write") {
		term.write(msg.data ?? "");
	} else if (msg.command === "tui:title") {
		document.title = msg.title ?? "";
	}
	// tui:progress is handled by the extension host (status bar / tab icon).
});

// Announce readiness and the initial size (the extension awaits this before
// starting the TUI, and buffers anything that arrived earlier).
post({ command: "tui:ready" });
reportSize();
