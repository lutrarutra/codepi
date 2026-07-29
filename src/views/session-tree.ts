import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";

// ── Types ────────────────────────────────────────────────────

interface SessionTreeSession {
	id: string;
	path: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	modified: Date;
}

// ── Lazy pi SDK import ───────────────────────────────────────

let _pi: any;
async function getPi(): Promise<any> {
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

	if (diffDays < 0) return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	if (diffDays === 0) return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	if (diffDays === 1) return "Yesterday";
	if (diffDays < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
	if (date.getFullYear() === now.getFullYear())
		return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}

function truncate(text: string, max = 55): string {
	if (text.length <= max) return text;
	return text.slice(0, max) + "…";
}

// ── Tree Item ─────────────────────────────────────────────────

export class SessionTreeItem extends vscode.TreeItem {
	constructor(
		public readonly session: SessionTreeSession,
	) {
		const label = formatSessionDate(session.modified);
		const description = session.name || truncate(session.firstMessage || "(empty)");
		super(label, vscode.TreeItemCollapsibleState.None);

		this.description = description;
		this.tooltip = new vscode.MarkdownString(
			`**${session.name || session.firstMessage || "Untitled"}**\n\n` +
			`${session.messageCount} message${session.messageCount !== 1 ? "s" : ""}\n` +
			`${session.path}`,
		);
		this.contextValue = "session";
		this.iconPath = new vscode.ThemeIcon("comment-discussion");

		this.command = {
			command: "codepi.openSession",
			title: "Open Session",
			arguments: [session.path],
		};
	}
}

// ── Tree Data Provider ───────────────────────────────────────

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private sessions: SessionTreeSession[] = [];
	private cwd: string;
	private agentDir: string;

	constructor() {
		this.cwd = getWorkspaceRoot();
		this.agentDir = path.join(os.homedir(), ".pi", "agent");
	}

	refresh(): void {
		this.cwd = getWorkspaceRoot();
		this._onDidChangeTreeData.fire(undefined);
	}

	async getChildren(): Promise<SessionTreeItem[]> {
		await this.loadSessions();
		return this.sessions.map(s => new SessionTreeItem(s));
	}

	getTreeItem(item: SessionTreeItem): vscode.TreeItem {
		return item;
	}

	/** Returns true if there's a workspace root to scope sessions to. */
	hasWorkspace(): boolean {
		return !!vscode.workspace.workspaceFolders?.length;
	}

	/** Delete a session by path and refresh. */
	async deleteSession(sessionPath: string): Promise<void> {
		try {
			await vscode.workspace.fs.delete(vscode.Uri.file(sessionPath));
			this.refresh();
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to delete session: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Rename a session (append name to session file metadata). */
	async renameSession(sessionPath: string): Promise<void> {
		const pi = await getPi();
		try {
			const sm = pi.SessionManager.open(sessionPath);
			const currentName = sm.getSessionName();
			const name = await vscode.window.showInputBox({
				title: "Rename Session",
				value: currentName ?? "",
				prompt: "Enter a display name for this session",
				placeHolder: "Session name (leave empty for auto-naming)",
			});
			if (name === undefined) return;
			if (name) {
				sm.appendSessionInfo(name);
			}
			this.refresh();
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to rename session: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async loadSessions(): Promise<void> {
		if (!this.hasWorkspace()) {
			this.sessions = [];
			return;
		}
		try {
			const pi = await getPi();
			const all: any[] = await pi.SessionManager.list(this.cwd);
			this.sessions = all
				.map((s: any) => ({
					id: s.id,
					path: s.path,
					name: s.name,
					firstMessage: s.firstMessage || "",
					messageCount: s.messageCount ?? 0,
					modified: s.modified instanceof Date ? s.modified : new Date(s.modified),
				}))
				.sort((a: SessionTreeSession, b: SessionTreeSession) => b.modified.getTime() - a.modified.getTime());
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
