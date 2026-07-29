import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import { PiEventRelay } from "./bridge/relay";
import { vscodeTools } from "./tools/index";
import type { WebviewMessage } from "./bridge/protocol";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

let panel: vscode.WebviewPanel | undefined;
let agentSession: AgentSession | undefined;
let isBackendReady = false;
const relay = new PiEventRelay();
const agentDir = path.join(os.homedir(), ".pi", "agent");

// Lazy import — pi SDK is ESM-only, must use dynamic import from CJS bundle
let _pi: any;
async function getPi(): Promise<any> {
	if (!_pi) {
		_pi = await import("@earendil-works/pi-coding-agent");
	}
	return _pi;
}

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand("codepi.openPanel", () => {
		if (panel) {
			panel.reveal(vscode.ViewColumn.Two);
			return;
		}

		panel = vscode.window.createWebviewPanel(
			"codepi",
			"PI",
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
				if (agentSession) {
					relay.detach();
					agentSession.dispose();
					agentSession = undefined;
				}
			},
			undefined,
			context.subscriptions,
		);

		// Start backend — errors are posted to webview
		startBackend().catch(err => {
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

async function startBackend(): Promise<void> {
	console.time("[CodePi] startBackend");
	const pi = await getPi();
	const workspaceRoot = getWorkspaceRoot();
	console.log("[CodePi] Pi SDK loaded");

	const loader = new pi.DefaultResourceLoader({
		cwd: workspaceRoot,
		agentDir,
		noExtensions: true,
	});
	console.log("[CodePi] Loading resources...");
	await loader.reload();
	console.log("[CodePi] Resources loaded");

	console.log("[CodePi] Creating agent session...");
	const { session } = await pi.createAgentSession({
		resourceLoader: loader,
		cwd: workspaceRoot,
		agentDir,
		noTools: "builtin",
		customTools: vscodeTools,
		sessionManager: pi.SessionManager.create(workspaceRoot),
	});

	console.log("[CodePi] Session created, model:", session.model?.id);

	if (!session.model) {
		throw new Error(
			"No AI model available. Configure an API key by running `pi /login` in a terminal, " +
				"or set the ANTHROPIC_API_KEY environment variable.",
		);
	}

	agentSession = session;
	relay.attach(session);

	// Get only models the user has auth for via getAvailable()
	const models: Array<{ provider: string; modelId: string }> = [];
	try {
		const registry: any = (session as any).modelRegistry;
		if (registry?.getAvailable) {
			const avail: any[] = registry.getAvailable();
			if (avail && avail.length > 0) {
				for (const m of avail) {
					const prov = String(m.provider ?? "");
					const mid = String(m.id ?? "");
					if (prov && mid) {
						models.push({ provider: prov, modelId: mid });
					}
				}
			}
		}
	} catch (err) {
		console.error("[CodePi] Error getting available models:", err);
	}

	// Always include current model (in case it's not in available list)
	if (session.model) {
		const curProv = String((session.model as any).provider ?? "");
		const curId = String(session.model.id ?? "");
		if (!models.some((m) => m.provider === curProv && m.modelId === curId)) {
			models.unshift({ provider: curProv, modelId: curId });
		}
	}

	panel?.webview.postMessage({ command: "modelList", models });
	panel?.webview.postMessage({ command: "toolsInfo", tools: vscodeTools.map(t => t.name) });
	console.log("[CodePi] Sent", models.length, "models, tools:", vscodeTools.map(t => t.name).join(", "));

	isBackendReady = true;
	console.timeEnd("[CodePi] startBackend");

	// Signal ready and send model info
	panel?.webview.postMessage({ command: "backendReady" });
	panel?.webview.postMessage({
		command: "modelInfo",
		provider: String((session.model as any).provider ?? ""),
		modelId: String(session.model.id ?? ""),
		thinkingLevel: session.thinkingLevel ?? "medium",
	});
}

async function handleWebviewMessage(message: WebviewMessage): Promise<void> {
	if (message.command === "abort") {
		try {
			await agentSession?.abort();
		} catch {
			/* ignore */
		}
		return;
	}

	if (!isBackendReady || !agentSession) {
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
		console.log("[CodePi] Session isStreaming:", agentSession.isStreaming);
		// If agent is already streaming, queue as steer
		if (agentSession.isStreaming) {
			agentSession.steer(message.text).catch((err: Error) => {
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
			Promise.race([agentSession.prompt(message.text), timeout])
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
		agentSession.steer(message.text).catch(() => {});
	} else if (message.command === "followUp") {
		agentSession.followUp(message.text).catch(() => {});
	} else if (message.command === "setModel") {
		try {
			if (!agentSession) { console.warn("[CodePi] setModel: no session"); return; }
			const registry: any = (agentSession as any).modelRegistry;
			if (!registry) return;

			// Search available models (only auth-configured ones)
			const avail: any[] = registry.getAvailable?.() ?? [];
			let model = avail.find(
				(m: any) =>
					String(m.provider ?? "") === message.provider &&
					String(m.id ?? "") === message.modelId,
			);

			if (model) {
				console.log("[CodePi] Setting model:", model.provider, model.id);
				await agentSession.setModel(model);
				relay.emitModelInfo();
			} else {
				console.warn("[CodePi] Model not available:", message.provider, message.modelId);
			}
		} catch (err) {
			console.error("[CodePi] setModel error:", err);
		}
	} else if (message.command === "setThinkingLevel") {
		agentSession?.setThinkingLevel(message.level as any);
		relay.emitModelInfo();
	} else if (message.command === "newSession") {
		// Dispose and restart — user gets fresh state
		if (agentSession) {
			relay.detach();
			agentSession.dispose();
			agentSession = undefined;
			isBackendReady = false;
		}
		startBackend().catch(err => {
			const msg = err instanceof Error ? err.message : String(err);
			panel?.webview.postMessage({
				command: "error",
				text: `Backend error: ${msg}`,
			});
		});
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" crossorigin href="${styleUri}" />
  <title>CodePi</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" crossorigin nonce="${nonce}" src="${scriptUri}"></script>
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

function getWorkspaceRoot(): string {
	const ws = vscode.workspace.workspaceFolders?.[0];
	return ws?.uri.fsPath ?? os.homedir();
}

export function deactivate() {
	isBackendReady = false;
	if (agentSession) {
		relay.detach();
		agentSession.dispose();
		agentSession = undefined;
	}
}
