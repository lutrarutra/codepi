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

// Keep the terminal sized to the editor and report the size so the TUI
// reflows. Retried a few times at startup because the webview may not have
// its final layout yet when this script first runs.
function reportSize(): void {
	try {
		fit.fit();
	} catch {
		return; // layout not ready yet
	}
	post({ command: "tui:resize", cols: term.cols, rows: term.rows });
}

function scheduleFit(): void {
	reportSize();
	// One extra pass after layout settles (fonts/measurements change col/row).
	requestAnimationFrame(() => {
		requestAnimationFrame(reportSize);
	});
}

term.onData((data) => post({ command: "tui:input", data }));

// Observe both the container and the body: webview layout changes (editor
// resize, sidebar toggles, tab switch) must re-fit and re-report.
new ResizeObserver(reportSize).observe(root);
new ResizeObserver(reportSize).observe(document.body);
window.addEventListener("resize", scheduleFit);

window.addEventListener("message", (event: MessageEvent) => {
	const msg = (event.data ?? {}) as Partial<TuiHostMessage>;
	if (msg.command === "tui:write") {
		term.write(msg.data ?? "");
	} else if (msg.command === "tui:title") {
		document.title = msg.title ?? "";
	}
	// tui:progress is handled by the extension host (tab icon / status).
});

term.focus();

// Announce readiness and the current size (the extension starts the TUI only
// after both arrive, so the first frame is already at the real editor size).
post({ command: "tui:ready" });
scheduleFit();
