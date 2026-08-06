import * as vscode from "vscode";
import * as os from "node:os";
import type {
	SessionEntry,
	SessionsMessage,
	SessionsReply,
} from "../shared/sessions-protocol";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

// ── Lazy pi SDK import ───────────────────────────────────────

let _pi: typeof import("@earendil-works/pi-coding-agent") | undefined;
async function getPi(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
	if (!_pi) {
		_pi = await import("@earendil-works/pi-coding-agent");
	}
	return _pi;
}

// ── Date formatting (compact) ────────────────────────────────

function formatSessionDate(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffDays = Math.floor(diffMs / 86_400_000);

	if (diffDays <= 0)
		return date.toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
		});
	if (diffDays === 1) return "Yesterday";
	if (diffDays < 7)
		return date.toLocaleDateString(undefined, { weekday: "short" });
	if (date.getFullYear() === now.getFullYear())
		return date.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
		});
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "2-digit",
	});
}

// ── Webview Provider ─────────────────────────────────────────

export class SessionsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "codepi.sessionsList";
	private view: vscode.WebviewView | undefined;
	private sessions: SessionEntry[] = [];
	private hasWorkspace = false;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly sessionDir: string,
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, "webview-ui", "dist"),
			],
		};
		webviewView.webview.html = buildSessionsHtml(
			this.extensionUri,
			webviewView.webview,
		);
		webviewView.webview.onDidReceiveMessage((msg: SessionsMessage) => {
			void this.handleMessage(msg);
		});
	}

	private async handleMessage(msg: SessionsMessage): Promise<void> {
		try {
			switch (msg.type) {
				case "get":
					await this.loadSessions();
					this.postList();
					break;
				case "refresh":
					await this.loadSessions();
					this.postList();
					break;
				case "new":
					await vscode.commands.executeCommand("codepi.newSession");
					break;
				case "open":
					await vscode.commands.executeCommand("codepi.openSession", msg.path);
					break;
				case "rename":
					await vscode.commands.executeCommand("codepi.renameSession", {
						path: msg.path,
					});
					break;
				case "delete":
					await vscode.commands.executeCommand("codepi.deleteSession", {
						path: msg.path,
					});
					break;
				case "openExtensions":
					await vscode.commands.executeCommand("codepi.openExtensionsTab");
					break;
				case "openSettings":
					await vscode.commands.executeCommand("codepi.openSettingsTab");
					break;
			}
		} catch (err) {
			this.post({
				type: "error",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/** Reload the session list and republish it (used by the refresh command
	 * and after rename/delete). */
	async refresh(): Promise<void> {
		await this.loadSessions();
		this.postList();
	}

	/** Delete a session by path and refresh. */
	async deleteSession(sessionPath: string): Promise<void> {
		try {
			await vscode.workspace.fs.delete(vscode.Uri.file(sessionPath));
		} catch (err) {
			vscode.window.showErrorMessage(
				`Failed to delete session: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		await this.refresh();
	}

	/** Rename a session (append name to session file metadata). Returns the
	 * new display name (or undefined when cancelled). */
	async renameSession(sessionPath: string): Promise<string | undefined> {
		const pi = await getPi();
		try {
			const sm = pi.SessionManager.open(sessionPath, this.sessionDir);
			const currentName = sm.getSessionName();
			const name = await vscode.window.showInputBox({
				title: "Rename Session",
				value: currentName ?? "",
				prompt: "Enter a display name for this session",
				placeHolder: "Session name (leave empty for auto-naming)",
			});
			if (name === undefined) return undefined;
			if (name) {
				sm.appendSessionInfo(name);
			}
			await this.refresh();
			return name || undefined;
		} catch (err) {
			vscode.window.showErrorMessage(
				`Failed to rename session: ${err instanceof Error ? err.message : String(err)}`,
			);
			return undefined;
		}
	}

	private post(msg: SessionsReply): void {
		this.view?.webview.postMessage(msg);
	}

	private postList(): void {
		this.post({
			type: "list",
			sessions: this.sessions,
			hasWorkspace: this.hasWorkspace,
		});
	}

	private async loadSessions(): Promise<void> {
		this.hasWorkspace = !!vscode.workspace.workspaceFolders?.length;
		if (!this.hasWorkspace) {
			this.sessions = [];
			return;
		}
		try {
			const pi = await getPi();
			const cwd = getWorkspaceRoot();
			const all: SessionInfo[] = await pi.SessionManager.list(
				cwd,
				this.sessionDir,
			);
			this.sessions = all
				.map((s: SessionInfo): SessionEntry => {
					const modified =
						s.modified instanceof Date ? s.modified : new Date(s.modified);
					return {
						id: s.id,
						path: s.path,
						name: s.name,
						firstMessage: s.firstMessage || "",
						messageCount: s.messageCount ?? 0,
						modified: modified.getTime(),
						dateLabel: formatSessionDate(modified),
					};
				})
				.sort((a: SessionEntry, b: SessionEntry) => b.modified - a.modified);
		} catch (err) {
			console.error("[CodePi] Error loading sessions:", err);
			this.sessions = [];
		}
	}
}

// ── Helpers ──────────────────────────────────────────────────

function getWorkspaceRoot(): string {
	const ws = vscode.workspace.workspaceFolders?.[0];
	return ws?.uri.fsPath ?? os.homedir();
}

function buildSessionsHtml(
	extensionUri: vscode.Uri,
	webview: vscode.Webview,
): string {
	const distUri = vscode.Uri.joinPath(extensionUri, "webview-ui", "dist");
	const scriptUri = webview.asWebviewUri(
		vscode.Uri.joinPath(distUri, "assets", "sessions.js"),
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
  <title>CodePi Sessions</title>
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
