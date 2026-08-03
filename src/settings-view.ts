import * as vscode from "vscode";
import { join } from "node:path";
import {
	AUTO_VERIFY_MODES,
	ensurePiJsonFileInDir,
	getCanonicalAgentDir,
	getCodePiSessionDir,
	readBundledResourceConfig,
	readJsonFile,
	updateAutoVerifyMode,
	updateAskModeAllowedTools,
	updateBundledResourceConfig,
	updateTerminalPrefs,
	type BundledResourceConfig,
} from "./pi-store";
import {
	buildDashboardData,
	getDashboardFileStatus,
	collectConfiguredPackageStatus,
} from "./settings-dashboard";
import type {
	AutoVerifyMode,
	DashboardData,
	SettingsMessage,
	SettingsReply,
} from "./shared/settings-protocol";

let sdkPromise:
	| Promise<typeof import("@earendil-works/pi-coding-agent")>
	| undefined;
function getSdk(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
	if (!sdkPromise) sdkPromise = import("@earendil-works/pi-coding-agent");
	return sdkPromise;
}

export class SettingsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "codepi.settings";
	private view: vscode.WebviewView | undefined;

	private readonly agentDir: string;
	private readonly sessionDir: string;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly onConfigSaved: () => void,
		agentDir = getCanonicalAgentDir(),
		sessionDir?: string,
	) {
		this.agentDir = agentDir;
		this.sessionDir = sessionDir ?? getCodePiSessionDir(agentDir);
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, "webview-ui", "dist"),
			],
		};
		webviewView.webview.html = buildSettingsHtml(
			this.extensionUri,
			webviewView.webview,
		);
		webviewView.webview.onDidReceiveMessage((msg: SettingsMessage) => {
			void this.handleMessage(msg);
		});
	}

	private async handleMessage(msg: SettingsMessage): Promise<void> {
		try {
			switch (msg.command) {
				case "settings:get":
				case "settings:refresh":
					if (msg.command === "settings:refresh") this.onConfigSaved();
					await this.sendData();
					break;
				case "settings:setTerminalPrefs":
					await this.setTerminalPrefs(msg.fontFamily, msg.fontSize);
					break;
				case "settings:setAutoVerify":
					await this.setAutoVerify(msg.mode);
					break;
				case "settings:setAskAllowedTools":
					await this.setAskAllowedTools(msg.tools);
					break;
				case "settings:setBundledResource":
					await this.setBundledResource(msg.id, msg.enabled);
					break;
				case "settings:openFile":
					await this.openFile(msg.file);
					break;
				case "settings:openSessions":
					await vscode.commands.executeCommand("codepi.openSessionsTab");
					break;
			}
		} catch (err) {
			this.post({
				command: "settings:error",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private post(msg: SettingsReply): void {
		this.view?.webview.postMessage(msg);
	}

	private async sendData(): Promise<void> {
		const settingsPath = getSettingsPathForAgent(this.agentDir);
		const settings = readJsonFile<Record<string, unknown>>(settingsPath) ?? {};
		const sdk = await getSdk();
		const cwd =
			vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.agentDir;
		const packages = collectConfiguredPackageStatus(sdk, cwd, this.agentDir);
		const data = buildDashboardData(
			this.agentDir,
			this.sessionDir,
			settings,
			packages,
			getDashboardFileStatus(this.agentDir),
		);
		this.post({ command: "settings:data", data });
	}

	private async setTerminalPrefs(
		fontFamily: string,
		fontSize: number,
	): Promise<void> {
		const settingsPath = getSettingsPathForAgent(this.agentDir);
		const family = String(fontFamily ?? "").trim().slice(0, 200);
		if (family === "") {
			throw new Error("Font family must not be empty");
		}
		if (!Number.isFinite(fontSize)) {
			throw new Error("Font size must be a number");
		}
		const size = Math.min(40, Math.max(8, Math.round(fontSize)));
		updateTerminalPrefs(settingsPath, { fontFamily: family, fontSize: size });
		this.onConfigSaved();
		this.post({ command: "settings:saved", ok: true, resource: "terminal" });
		await this.sendData();
	}

	private async setAutoVerify(mode: AutoVerifyMode): Promise<void> {
		if (!(AUTO_VERIFY_MODES as readonly string[]).includes(mode)) {
			throw new Error(
				`Unknown auto-verify mode: ${String(mode)}. Use one of: ${AUTO_VERIFY_MODES.join(", ")}.`,
			);
		}
		const settingsPath = getSettingsPathForAgent(this.agentDir);
		updateAutoVerifyMode(settingsPath, mode);
		this.onConfigSaved();
		this.post({ command: "settings:saved", ok: true, resource: "autoVerify" });
		await this.sendData();
	}

	private async setAskAllowedTools(tools: string[]): Promise<void> {
		const settingsPath = getSettingsPathForAgent(this.agentDir);
		const cleaned = (Array.isArray(tools) ? tools : [])
			.map((t) => String(t ?? "").trim())
			.filter((t) => t !== "");
		if (cleaned.length > 200) {
			throw new Error("Too many allowed tools (max 200).");
		}
		updateAskModeAllowedTools(settingsPath, cleaned);
		this.onConfigSaved();
		this.post({ command: "settings:saved", ok: true, resource: "askAllowedTools" });
		await this.sendData();
	}

	private async setBundledResource(
		id: DashboardData["bundledResources"][number]["id"],
		enabled: boolean,
	): Promise<void> {
		const settingsPath = getSettingsPathForAgent(this.agentDir);
		if (!isBundledResourceId(id)) {
			throw new Error(`Unknown bundled resource: ${id}`);
		}
		const settings = readJsonFile<Record<string, unknown>>(settingsPath) ?? {};
		const current = readBundledResourceConfig(settings);
		const next: BundledResourceConfig = {
			bundledExtensions: { ...current.bundledExtensions },
			bundledThemes: { ...current.bundledThemes },
		};
		if (id === "nebula-pulse") next.bundledThemes["nebula-pulse"] = enabled;
		else next.bundledExtensions[id] = enabled;
		updateBundledResourceConfig(settingsPath, next);
		this.onConfigSaved();
		this.post({ command: "settings:saved", ok: true, resource: id });
		await this.sendData();
	}

	private async openFile(file: "settings" | "models" | "auth"): Promise<void> {
		const filePath = ensurePiJsonFileInDir(this.agentDir, file);
		const document = await vscode.workspace.openTextDocument(
			vscode.Uri.file(filePath),
		);
		await vscode.window.showTextDocument(document, { preview: false });
		this.post({ command: "settings:opened", file, path: filePath });
	}
}

function isBundledResourceId(
	id: string,
): id is DashboardData["bundledResources"][number]["id"] {
	return (
		id === "custom-footer" ||
		id === "filechanges" ||
		id === "codepi-modes" ||
		id === "codepi-bash" ||
		id === "codepi-context" ||
		id === "nebula-pulse"
	);
}

function getSettingsPathForAgent(agentDir: string): string {
	return join(agentDir, "settings.json");
}

function buildSettingsHtml(
	extensionUri: vscode.Uri,
	webview: vscode.Webview,
): string {
	const distUri = vscode.Uri.joinPath(extensionUri, "webview-ui", "dist");
	const scriptUri = webview.asWebviewUri(
		vscode.Uri.joinPath(distUri, "assets", "settings.js"),
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
  <title>CodePi Settings</title>
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
	for (let i = 0; i < 32; i++)
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	return text;
}
