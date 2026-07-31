import * as vscode from "vscode";
import { readJsonFile, writeJsonFileAtomic, getSettingsPath, getModelsPath, getAuthPath } from "./pi-store";
import { runImportFlow } from "./import-config";
import { validateSettings } from "./shared/pi-settings-schema";
import type { AuthEntry, SettingsMessage, SettingsRecord, SettingsReply } from "./shared/settings-protocol";

let sdkPromise: Promise<typeof import("@earendil-works/pi-coding-agent")> | undefined;
function getSdk(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
	if (!sdkPromise) {
		sdkPromise = import("@earendil-works/pi-coding-agent");
	}
	return sdkPromise;
}

export class SettingsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "codepi.settings";

	private view: vscode.WebviewView | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly onConfigSaved: () => void,
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "webview-ui", "dist")],
		};
		webviewView.webview.html = buildSettingsHtml(this.extensionUri, webviewView.webview);

		webviewView.webview.onDidReceiveMessage((msg: SettingsMessage) => {
			void this.handleMessage(msg);
		});
	}

	private async handleMessage(msg: SettingsMessage): Promise<void> {
		try {
			switch (msg.command) {
				case "settings:get":
					await this.sendData();
					break;
				case "settings:saveSettings":
					await this.saveSettings(msg.settings);
					break;
				case "settings:saveAuth":
					await this.saveAuth(msg.provider, msg.key, msg.remove === true);
					break;
				case "settings:saveModels":
					await this.saveModels(msg.models);
					break;
				case "settings:saveJson":
					await this.saveJson(msg.file, msg.text);
					break;
				case "settings:importConfig": {
					const res = await runImportFlow();
					if (res) {
						this.post({ command: "settings:importResult", imported: res.imported, message: res.imported.join(", ") || "nothing new" });
						this.onConfigSaved();
					}
					break;
				}
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

	private async saveModels(models: unknown): Promise<void> {
		const modelsPath = getModelsPath();
		// Keep the previous content so a pi-validation failure can roll back.
		const previous = readJsonFile<unknown>(modelsPath);
		writeJsonFileAtomic(modelsPath, models);
		const sdk = await getSdk();
		const registry = sdk.ModelRegistry.create(sdk.AuthStorage.create(getAuthPath()), modelsPath);
		registry.refresh();
		const err = registry.getError();
		if (err) {
			if (previous !== undefined) {
				try {
					writeJsonFileAtomic(modelsPath, previous);
				} catch {
					/* best effort rollback */
				}
			}
			this.post({ command: "settings:error", message: err, file: "models.json" });
			return;
		}
		this.post({ command: "settings:saved", ok: true, file: "models.json" });
		this.onConfigSaved();
	}

	private async saveJson(file: "settings" | "models", text: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			this.post({
				command: "settings:error",
				message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
				file,
			});
			return;
		}
		if (file === "settings") {
			const errors = validateSettings(parsed);
			if (errors.length > 0) {
				this.post({ command: "settings:error", message: errors.join("\n"), file });
				return;
			}
			writeJsonFileAtomic(getSettingsPath(), parsed);
			this.post({ command: "settings:saved", ok: true, file });
			this.onConfigSaved();
		} else {
			// models.json — validated by pi's own loader; saveModels posts the result.
			await this.saveModels(parsed);
		}
	}

	private async sendData(): Promise<void> {
		const sdk = await getSdk();
		const auth = sdk.AuthStorage.create(getAuthPath());
		const registry = sdk.ModelRegistry.create(auth, getModelsPath());
		registry.refresh();
		const modelsError = registry.getError();
		const models = readJsonFile<unknown>(getModelsPath());
		const settings = readJsonFile<SettingsRecord>(getSettingsPath()) ?? {};
		const catalog: Array<{ provider: string; modelId: string }> = registry
			.getAll()
			.map((m: any) => ({ provider: String(m.provider ?? ""), modelId: String(m.id ?? "") }))
			.filter((m) => m.provider && m.modelId);
		const authEntries: AuthEntry[] = [];
		for (const provider of auth.list()) {
			const cred = auth.get(provider);
			authEntries.push({
				provider,
				type: cred?.type === "oauth" ? "oauth" : "api_key",
				hasKey: !!cred && cred.type === "api_key" && !!cred.key,
			});
		}
		this.post({ command: "settings:data", settings, auth: authEntries, models, modelsError, catalog });
	}

	private async saveSettings(settings: SettingsRecord): Promise<void> {
		const errors = validateSettings(settings);
		if (errors.length > 0) {
			this.post({ command: "settings:error", message: errors.join("\n"), file: "settings.json" });
			return;
		}
		writeJsonFileAtomic(getSettingsPath(), settings);
		this.post({ command: "settings:saved", ok: true, file: "settings.json" });
		this.onConfigSaved();
	}

	private async saveAuth(provider: string, key: string | undefined, remove: boolean): Promise<void> {
		if (!provider) {
			this.post({ command: "settings:error", message: "Provider name required", file: "auth.json" });
			return;
		}
		const sdk = await getSdk();
		const auth = sdk.AuthStorage.create(getAuthPath());
		if (remove) {
			auth.remove(provider);
		} else {
			if (!key) {
				this.post({ command: "settings:error", message: `API key for ${provider} is empty`, file: "auth.json" });
				return;
			}
			auth.set(provider, { type: "api_key", key });
		}
		this.post({ command: "settings:saved", ok: true, file: "auth.json" });
		this.onConfigSaved();
	}
}

function buildSettingsHtml(extensionUri: vscode.Uri, webview: vscode.Webview): string {
	const distUri = vscode.Uri.joinPath(extensionUri, "webview-ui", "dist");
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "settings.js"));
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "index.css"));
	const nonce = getNonce();
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" crossorigin href="${styleUri}" />
  <title>PI Settings</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" crossorigin nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
	let text = "";
	const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
