import * as vscode from "vscode";
import {
	getCanonicalAgentDir,
	getSettingsPath,
	readJsonFile,
} from "./pi-store";
import { buildSnapshot, CORE_SLASH_COMMANDS } from "./extension-snapshot";
import { probeExtensions } from "./extension-probe";
import type {
	ExtensionsMessage,
	ExtensionsReply,
	ExtensionsSnapshot,
	ModeInfo,
} from "./shared/extensions-protocol";
import { getVscodeTools } from "./tools";

let sdkPromise:
	| Promise<typeof import("@earendil-works/pi-coding-agent")>
	| undefined;
function getSdk(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
	if (!sdkPromise) sdkPromise = import("@earendil-works/pi-coding-agent");
	return sdkPromise;
}

export class ExtensionsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "codepi.extensions";
	private view: vscode.WebviewView | undefined;
	private snapshot: ExtensionsSnapshot | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly getModeInfo: () => ModeInfo,
		private readonly getCwd: () => string,
		private readonly agentDir = getCanonicalAgentDir(),
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, "webview-ui", "dist"),
			],
		};
		webviewView.webview.html = buildExtensionsHtml(
			this.extensionUri,
			webviewView.webview,
		);
		webviewView.webview.onDidReceiveMessage((msg: ExtensionsMessage) => {
			void this.handleMessage(msg);
		});
	}

	private async handleMessage(msg: ExtensionsMessage): Promise<void> {
		try {
			if (msg.type === "refresh") {
				const sdk = await getSdk();
				// Not re-exported from the SDK root in the pinned version; call
				// defensively so newer SDKs get true file-edit freshness.
				// Otherwise new/removed extensions and settings toggles still
				// refresh; edited extension files apply on host restart.
				(
					sdk as unknown as { clearExtensionCache?: () => void }
				).clearExtensionCache?.();
				this.snapshot = undefined;
			}
			if (msg.type === "getSnapshot" || msg.type === "refresh") {
				this.snapshot ??= await this.build();
				this.post({ type: "snapshot", snapshot: this.snapshot });
			}
		} catch (err) {
			this.post({
				type: "error",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async build(): Promise<ExtensionsSnapshot> {
		const sdk = await getSdk();
		const cwd = this.getCwd();
		const agentDir = this.agentDir;
		const extensionDir = vscode.Uri.joinPath(
			this.extensionUri,
			"resources",
			"extensions",
		).fsPath;
		const probe = await probeExtensions({
			cwd,
			agentDir,
			extensionResourcesDir: extensionDir,
			readSettings: () => readJsonFile(getSettingsPath()) ?? {},
		});
		// Core SDK tools via the root-exported factories (the SDK's own
		// createCodingToolDefinitions is not re-exported from the root).
		const coreTools = [
			sdk.createReadToolDefinition(cwd),
			sdk.createBashToolDefinition(cwd),
			sdk.createEditToolDefinition(cwd),
			sdk.createWriteToolDefinition(cwd),
			sdk.createGrepToolDefinition(cwd),
			sdk.createFindToolDefinition(cwd),
			sdk.createLsToolDefinition(cwd),
			...getVscodeTools(),
		];
		return buildSnapshot({
			bundledDir: extensionDir,
			agentDir,
			cwd,
			settings: readJsonFile(getSettingsPath()) ?? {},
			mode: this.getModeInfo(),
			extensions: probe.extensions,
			loadErrors: probe.loadErrors,
			coreCommands: [
				...CORE_SLASH_COMMANDS.map((c) => ({
					name: c.name,
					description: c.description,
					source: "extension" as const,
				})),
				...probe.skills.map((s) => ({
					name: `skill:${s.name}`,
					...(s.description ? { description: s.description } : {}),
					source: "skill" as const,
				})),
				...probe.prompts.map((p) => ({
					name: p.name,
					...(p.description ? { description: p.description } : {}),
					source: "prompt" as const,
				})),
			],
			coreTools: coreTools as Array<{
				name?: string;
				label?: string;
				description?: string;
			}>,
		});
	}

	private post(msg: ExtensionsReply): void {
		this.view?.webview.postMessage(msg);
	}
}

function buildExtensionsHtml(
	extensionUri: vscode.Uri,
	webview: vscode.Webview,
): string {
	const distUri = vscode.Uri.joinPath(extensionUri, "webview-ui", "dist");
	const scriptUri = webview.asWebviewUri(
		vscode.Uri.joinPath(distUri, "assets", "extensions.js"),
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
  <title>CodePi Extensions</title>
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
