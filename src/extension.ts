import * as vscode from "vscode";
import { createMcpServer } from "./mcp/server";
import { registerCoreTools } from "./mcp/tools/index";
import { createChildAgentRuntime } from "./agent/child-runtime";
import { PiEventRelay } from "./bridge/relay";
import type { WebviewMessage } from "./bridge/protocol";

let panel: vscode.WebviewPanel | undefined;
let mcpServer: ReturnType<typeof createMcpServer> | undefined;
let agentRuntime:
	| {
			session: {
				prompt(text: string): Promise<void>;
				abort(): Promise<void>;
				steer(text: string): Promise<void>;
				followUp(text: string): Promise<void>;
				isStreaming: boolean;
			};
			dispose(): Promise<void>;
	  }
	| undefined;
let isBackendReady = false;
const relay = new PiEventRelay();

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand("codepi.openPanel", () => {
		if (panel) {
			panel.reveal(vscode.ViewColumn.Two);
			return;
		}

		panel = vscode.window.createWebviewPanel(
			"codepi",
			"CodePi",
			vscode.ViewColumn.Two,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(context.extensionUri, "webview-ui", "dist"),
				],
			},
		);

		panel.webview.html = buildHtml(context.extensionUri, panel.webview);
		relay.setWebview(panel.webview);

		panel.webview.onDidReceiveMessage(
			async (message: WebviewMessage) => {
				console.log("[CodePi] received from webview:", message.command);
				await handleWebviewMessage(message);
			},
			undefined,
			context.subscriptions,
		);

		panel.onDidDispose(
			async () => {
				panel = undefined;
				isBackendReady = false;
				relay.setWebview(undefined as unknown as vscode.Webview);
				await agentRuntime?.dispose();
				agentRuntime = undefined;
				await mcpServer?.stop();
				mcpServer = undefined;
			},
			undefined,
			context.subscriptions,
		);

		// Start backend — errors are posted to webview
		startBackend(context).catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			panel?.webview.postMessage({
				command: "error",
				text: `Backend error: ${msg}`,
			});
			console.error("[CodePi] Backend error:", err);
		});
	});

	context.subscriptions.push(disposable);
}

async function startBackend(context: vscode.ExtensionContext): Promise<void> {
	mcpServer = createMcpServer();
	registerCoreTools(mcpServer);
	await mcpServer.start();
	console.log(`[CodePi] MCP server listening on port ${mcpServer.port}`);

	agentRuntime = createChildAgentRuntime(relay, context);
	isBackendReady = true;
	console.log("[CodePi] Agent runtime ready");

	panel?.webview.postMessage({ command: "agentEnd", willRetry: false });
}

async function handleWebviewMessage(message: WebviewMessage): Promise<void> {
	if (message.command === "abort") {
		// Always handle abort, even if backend not ready
		try {
			await agentRuntime?.session.abort();
		} catch {
			/* ignore */
		}
		return;
	}

	if (!isBackendReady || !agentRuntime) {
		console.warn(
			"[CodePi] Backend not ready yet, dropping message:",
			message.command,
		);
		panel?.webview.postMessage({
			command: "error",
			text: "Backend is still starting up. Please wait a moment and try again.",
		});
		return;
	}

	if (message.command === "prompt") {
		const promptStartTime = Date.now();
		console.log(
			"[CodePi] Sending prompt to agent:",
			message.text.slice(0, 200),
		);
		console.log(
			"[CodePi] Session isStreaming:",
			agentRuntime.session.isStreaming,
		);
		// If agent is already streaming, queue as steer
		if (agentRuntime.session.isStreaming) {
			agentRuntime.session.steer(message.text).catch((err: Error) => {
				console.error("[CodePi] Steer error:", err);
			});
		} else {
			// Don't await — let abort work concurrently
			const TIMEOUT_MS = 120_000; // 2 minutes
			const timeout = new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(new Error(`Prompt timed out after ${TIMEOUT_MS / 1000}s`)),
					TIMEOUT_MS,
				),
			);
			Promise.race([agentRuntime.session.prompt(message.text), timeout])
				.then(() => {
					const elapsed = Date.now() - promptStartTime;
					console.log("[CodePi] Prompt completed in", elapsed, "ms");
				})
				.catch((err: Error) => {
					const elapsed = Date.now() - promptStartTime;
					console.error("[CodePi] Agent error after", elapsed, "ms:", err);
					panel?.webview.postMessage({
						command: "error",
						text: err.message || String(err),
					});
				});
		}
	} else if (message.command === "steer") {
		agentRuntime.session.steer(message.text).catch(() => {});
	} else if (message.command === "followUp") {
		agentRuntime.session.followUp(message.text).catch(() => {});
	}
}

function buildHtml(extensionUri: vscode.Uri, webview: vscode.Webview): string {
	const distUri = vscode.Uri.joinPath(extensionUri, "webview-ui", "dist");
	const scriptUri = webview.asWebviewUri(
		vscode.Uri.joinPath(distUri, "assets", "index.js"),
	);
	const styleUri = webview.asWebviewUri(
		vscode.Uri.joinPath(distUri, "assets", "index.css"),
	);
	const nonce = getNonce();

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>CodePi</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
	let text = "";
	const possible =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

export function deactivate() {
	isBackendReady = false;
	agentRuntime?.dispose();
	mcpServer?.stop();
}
