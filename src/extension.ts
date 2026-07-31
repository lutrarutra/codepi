import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import {
	createVscodeTools,
	clearTodoList,
	reconstructFromEntries,
} from "./tools/index";
import { SessionTreeProvider, SessionTreeItem } from "./views/session-tree";
import { ReviewManager } from "./review/review-manager";
import { ReviewDecorations, openProposalDiff } from "./review/decorations";
import type { EditProposalSummary } from "./review/types";
import type {
	AgentSessionRuntime,
	InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import { WebviewTerminal } from "./tui/webview-terminal";
import type { TuiWebviewMessage } from "./tui/protocol";
import { SettingsViewProvider } from "./settings-view";
import {
	detectLegacyConfig,
	getAgentDir,
	importLegacyConfig,
	setAgentDir,
} from "./pi-store";
import { runImportFlow } from "./import-config";

// ── Types ────────────────────────────────────────────────────

interface PanelState {
	panel: vscode.WebviewPanel;
	terminal: WebviewTerminal;
	runtime: AgentSessionRuntime;
	tui: InteractiveMode;
	sessionManager: any; // SessionManager from PI SDK
	extensionUri: vscode.Uri;
	isBackendReady: boolean;
	isBusy: boolean;
	sessionId: string;
	sessionPath: string;
	disposables: vscode.Disposable[];
	review: ReviewManager;
}

// ── Globals ──────────────────────────────────────────────────

const panels = new Map<string, PanelState>();

// Resolvers fired when each tab's webview posts tui:ready.
const terminalReadyWaiters = new Map<string, () => void>();
let treeProvider: SessionTreeProvider | undefined;

// Shared editor decorations + CodeLens for ALL panels' pending edits.
let reviewDecorations: ReviewDecorations | undefined;

// Bottom-right per-file review prompts, queued so files are asked one by one.
const fileReviewQueue: Array<{ summary: EditProposalSummary; panel: PanelState }> = [];
let promptInFlight = false;

// Status-bar item showing how many edits are pending review.
let reviewStatusBar: vscode.StatusBarItem | undefined;

/** Refresh the global "N edits pending review" status-bar item. */
function updateReviewStatusBar(): void {
	let pendingFiles = 0;
	let pendingHunks = 0;
	for (const [, st] of panels) {
		for (const p of st.review.allProposals()) {
			if (p.status !== "pending") continue;
			const c = st.review.counts(p);
			if (c.pending > 0) {
				pendingFiles++;
				pendingHunks += c.pending;
			}
		}
	}
	if (!reviewStatusBar) {
		reviewStatusBar = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			200,
		);
		reviewStatusBar.command = "codepi.openPendingReview";
	}
	if (pendingHunks > 0) {
		reviewStatusBar.text = `$(diff) ${pendingFiles} file${pendingFiles === 1 ? "" : "s"} · ${pendingHunks} edit${pendingHunks === 1 ? "" : "s"} pending`;
		reviewStatusBar.tooltip = "CodePi: review pending edits in the editor";
		reviewStatusBar.show();
	} else {
		reviewStatusBar.hide();
	}
}

// Lazy import — pi SDK is ESM-only, must use dynamic import from CJS bundle
let _pi: any;
async function getPi(): Promise<any> {
	if (!_pi) {
		_pi = await import("@earendil-works/pi-coding-agent");
	}
	return _pi;
}

// ── Panel icon helpers ───────────────────────────────────────

// The pi logo is contributed as a product icon (media/codepi-logo.woff,
// contributed via `contributes.icons`) and used as a ThemeIcon for the tab
// handle. Theme icons render via CSS + icon font (like file-language icons),
// which is reliable in every client — unlike raw file:// or data: URIs that
// the Remote client may fail to render after a tab label re-render.
//
// The logo itself is always white (codepi.logo); status is conveyed by the
// session-name color in the chat header instead (see the webview).
function setPanelIcon(
	state: PanelState,
	mode: "idle" | "busy" | "error",
): void {
	// The mode parameter is kept for call-site clarity; the logo stays white.
	void mode;
	state.panel.iconPath = new vscode.ThemeIcon(
		"codepi-logo",
		new vscode.ThemeColor("codepi.logo"),
	);
}

/**
 * Set the panel's tab title and re-assert the tab icon afterwards.
 *
 * Some VS Code versions drop the webview panel's tab icon when the title is
 * changed (the tab label re-render loses the icon), so the icon is re-applied
 * after every title change — the last label-affecting operation wins. Also
 * broadcasts the name to the webview so the chat header can show it colored
 * by status.
 */
function setPanelTitle(state: PanelState, title: string): void {
	state.panel.title = title;
	setPanelIcon(state, state.isBusy ? "busy" : "idle");
}
// ── Activation ───────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
	// Point pi's config/session storage at VSCode's dedicated extension
	// storage (globalStorageUri) instead of ~/.pi. Must run before any SDK
	// call — pi reads PI_CODING_AGENT_DIR at call time.
	const agentDir = path.join(context.globalStorageUri.fsPath, "agent");
	setAgentDir(agentDir);
	fs.mkdirSync(agentDir, { recursive: true });

	// Register session tree provider
	treeProvider = new SessionTreeProvider();
	const treeView = vscode.window.createTreeView("codepi.sessionsList", {
		treeDataProvider: treeProvider,
		showCollapseAll: false,
	});
	context.subscriptions.push(treeView);

	// Settings sidebar tab (toggled with the Sessions tree via codepi.sidebarTab)
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			SettingsViewProvider.viewType,
			new SettingsViewProvider(context.extensionUri, () => {
				// Settings hot-apply under the native TUI:
				//  - settings.json applies to NEW sessions (unchanged)
				//  - auth.json is read at request time (unchanged)
				//  - models.json is re-read by the TUI's own /model selector on
				//    demand, so no push refresh is needed here.
			}),
			{ webviewOptions: { retainContextWhenHidden: true } },
		),
		vscode.commands.registerCommand("codepi.openSettingsTab", () =>
			vscode.commands.executeCommand("setContext", "codepi.sidebarTab", "settings"),
		),
		vscode.commands.registerCommand("codepi.openSessionsTab", () =>
			vscode.commands.executeCommand("setContext", "codepi.sidebarTab", "sessions"),
		),
	);
	await vscode.commands.executeCommand("setContext", "codepi.sidebarTab", "sessions");

	// First-run migration: offer to import an existing ~/.pi/agent config.
	// Run async, do NOT block registration on the prompt.
	void (async () => {
		const legacyDir = path.join(os.homedir(), ".pi", "agent");
		const legacy = detectLegacyConfig(legacyDir);
		const importAsked = context.globalState.get<boolean>("codepi.importPrompted", false);
		if (legacy && !importAsked) {
			await context.globalState.update("codepi.importPrompted", true);
			const choice = await vscode.window.showInformationMessage(
				"Found existing pi configuration at ~/.pi/agent. Import it into CodePi's own storage?",
				{ modal: false },
				"Import (config + sessions)",
				"Import config only",
				"Start fresh",
			);
			if (choice?.startsWith("Import")) {
				try {
					const res = importLegacyConfig(legacyDir, agentDir, {
						includeSessions: choice === "Import (config + sessions)",
					});
					const list = res.imported.join(", ");
					vscode.window.showInformationMessage(
						`Imported into CodePi storage: ${list || "nothing new"}.`,
					);
				} catch (err) {
					vscode.window.showErrorMessage(
						`Failed to import pi config: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
	})();

	// ── Edit review infrastructure ─────────────────────────────
	const reviewHandlers = {
		acceptHunk: async (proposalId: string, hunkId: string) => {
			for (const [, state] of panels) {
				if (state.review.getProposal(proposalId)) {
					await state.review.acceptHunk(proposalId, hunkId);
					break;
				}
			}
		},
		rejectHunk: async (proposalId: string, hunkId: string) => {
			for (const [, state] of panels) {
				if (state.review.getProposal(proposalId)) {
					await state.review.rejectHunk(proposalId, hunkId);
					break;
				}
			}
		},
		acceptFile: async (proposalId: string) => {
			for (const [, state] of panels) {
				if (state.review.getProposal(proposalId)) {
					await state.review.acceptFile(proposalId);
					break;
				}
			}
		},
		rejectFile: async (proposalId: string) => {
			for (const [, state] of panels) {
				if (state.review.getProposal(proposalId)) {
					await state.review.rejectFile(proposalId);
					break;
				}
			}
		},
		openDiff: async (proposalId: string) => {
			for (const [, state] of panels) {
				const proposal = state.review.getProposal(proposalId);
				if (proposal) {
					await openProposalDiff(proposal);
					break;
				}
			}
		},
	};
	reviewDecorations = new ReviewDecorations(reviewHandlers);
	context.subscriptions.push(reviewDecorations);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"codepi.acceptHunk",
			(proposalId: string, hunkId: string) =>
				reviewHandlers.acceptHunk(proposalId, hunkId),
		),
		vscode.commands.registerCommand(
			"codepi.rejectHunk",
			(proposalId: string, hunkId: string) =>
				reviewHandlers.rejectHunk(proposalId, hunkId),
		),
		vscode.commands.registerCommand(
			"codepi.acceptFile",
			(proposalId: string) => reviewHandlers.acceptFile(proposalId),
		),
		vscode.commands.registerCommand(
			"codepi.rejectFile",
			(proposalId: string) => reviewHandlers.rejectFile(proposalId),
		),
		vscode.commands.registerCommand("codepi.acceptAllEdits", async () => {
			for (const [, state] of panels) {
				await state.review.acceptAll();
			}
		}),
		vscode.commands.registerCommand("codepi.rejectAllEdits", async () => {
			for (const [, state] of panels) {
				await state.review.rejectAll();
			}
		}),
		vscode.commands.registerCommand(
			"codepi.openDiff",
			(proposalId: string) => reviewHandlers.openDiff(proposalId),
		),
		vscode.commands.registerCommand("codepi.openPendingReview", async () => {
			const items: Array<{
				label: string;
				description: string;
				detail?: string;
				proposal: EditProposalSummary;
				panel: PanelState;
			}> = [];
			for (const [, st] of panels) {
				for (const p of st.review.allProposals()) {
					if (p.status !== "pending") continue;
					const c = st.review.counts(p);
					if (c.pending === 0) continue;
					items.push({
						label: p.path,
						description: `${c.pending} change${c.pending === 1 ? "" : "s"} pending`,
						detail: `${c.linesAdded} added · ${c.linesRemoved} removed`,
						proposal: st.review.summary(p),
						panel: st,
					});
				}
			}
			if (items.length === 0) {
				vscode.window.showInformationMessage(
					"CodePi: no pending edits to review.",
				);
				return;
			}
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: "Select a file with pending edits to review",
			});
			if (!picked) return;
			const proposal = picked.panel.review.getProposal(
				picked.proposal.proposalId,
			);
			if (proposal) {
				try {
					const uri = vscode.Uri.parse(proposal.uri);
					const doc = await vscode.workspace.openTextDocument(uri);
					await vscode.window.showTextDocument(doc, { preview: false });
				} catch {
					/* ignore */
				}
			}
		}),
	);

	// ── Custom editor provider: each chat session is its own editor tab ──
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
			CHAT_VIEW_TYPE,
			new CodePiChatProvider(context),
			{
				webviewOptions: { retainContextWhenHidden: true },
			},
		),
	);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand("codepi.openPanel", () => {
			void createNewSessionPanel();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("codepi.newSession", () => {
			void createNewSessionPanel();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"codepi.openSession",
			async (
				arg?: string | SessionTreeItem,
				opts?: { fromTree?: boolean },
			) => {
				let sessionPath: string | undefined;
				if (typeof arg === "string") {
					sessionPath = arg;
				} else if (arg instanceof SessionTreeItem) {
					sessionPath = arg.session.path;
				}
				if (!sessionPath) {
					await pickSession();
					return;
				}
				// openWith reuses/reveals the existing tab if already open;
				// from the tree list it opens as a preview, pinned on double-click.
				await openExistingSessionPanel(sessionPath, opts);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"codepi.renameSession",
			async (item?: SessionTreeItem) => {
				if (!item) return;
				await treeProvider?.renameSession(item.session.path);
				// Keep an open panel's tab title in sync with the new session name.
				for (const [, state] of panels) {
					if (state.sessionPath === item.session.path) {
						const name = state.sessionManager.getSessionName?.();
						if (name) {
							setPanelTitle(
								state,
								name.length > 50 ? name.slice(0, 50) + "…" : name,
							);
						}
						break;
					}
				}
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"codepi.deleteSession",
			async (item?: SessionTreeItem) => {
				if (!item) return;
				const confirm = await vscode.window.showWarningMessage(
					`Delete this session? This cannot be undone.`,
					{ modal: true },
					"Delete",
				);
				if (confirm !== "Delete") return;

				// Close any panel using this session
				const sessionPath = item.session.path;
				for (const [id, state] of panels) {
					if (state.sessionPath === sessionPath) {
						state.panel.dispose();
						break;
					}
				}
				await treeProvider?.deleteSession(sessionPath);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("codepi.refreshSessions", () => {
			treeProvider?.refresh();
		}),
		vscode.commands.registerCommand("codepi.importPiConfig", async () => {
			try {
				const res = await runImportFlow();
				if (res) {
					vscode.window.showInformationMessage(
						`Imported into CodePi storage: ${res.imported.join(", ") || "nothing new"}.`,
					);
				}
			} catch (err) {
				vscode.window.showErrorMessage(
					`Failed to import pi config: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);

	// pi 0.80.1's TUI exposes model switching through its own keybinding and
	// /model command; no programmatic hook is available, so the palette command
	// points at the native path.
	context.subscriptions.push(
		vscode.commands.registerCommand("codepi.setModel", () => {
			vscode.window.showInformationMessage(
				"Switch models inside the pi TUI with /model (or the model keybinding).",
			);
		}),
	);
}

// ── Custom editor identity ──────────────────────────────────

const CHAT_VIEW_TYPE = "codepi.chat";

/** Fake resource URI used to give each chat session its own editor tab. */
function chatUri(sessionId: string): vscode.Uri {
	return vscode.Uri.parse(
		`codepi-chat://chat/${encodeURIComponent(sessionId)}`,
	);
}

function sessionIdFromUri(uri: vscode.Uri): string {
	return decodeURIComponent(uri.path.replace(/^\//, ""));
}

interface SessionInfo {
	sessionManager: any; // SessionManager from PI SDK
	sessionPath: string;
}

// sessionId → session manager. Populated when a chat is opened by a command
// and re-created by the provider when VS Code restores an editor (reload).
const sessionRegistry = new Map<string, SessionInfo>();
const sessionInfoPromises = new Map<string, Promise<SessionInfo>>();

async function loadOrCreateSessionInfo(
	sessionId: string,
): Promise<SessionInfo> {
	const pi = await getPi();
	const workspaceRoot = getWorkspaceRoot();
	// Restore an existing session file if present (e.g. after a window reload).
	try {
		const all: any[] = await pi.SessionManager.list(workspaceRoot);
		const found = all.find((s: any) => String(s.id) === sessionId);
		if (found?.path) {
			const sessionManager = pi.SessionManager.open(
				found.path,
				undefined,
				workspaceRoot,
			);
			return {
				sessionManager,
				sessionPath: sessionManager.getSessionFile() || found.path,
			};
		}
	} catch (err) {
		console.error("[CodePi] Error restoring session", sessionId, ":", err);
	}
	// No persisted session (e.g. brand-new chat that never sent a message) —
	// start a fresh one.
	const sessionManager = pi.SessionManager.create(workspaceRoot);
	return {
		sessionManager,
		sessionPath: sessionManager.getSessionFile() || "",
	};
}

function ensureSessionInfo(sessionId: string): Promise<SessionInfo> {
	const existing = sessionRegistry.get(sessionId);
	if (existing) return Promise.resolve(existing);
	let pending = sessionInfoPromises.get(sessionId);
	if (!pending) {
		pending = loadOrCreateSessionInfo(sessionId).then((info) => {
			sessionRegistry.set(sessionId, info);
			return info;
		});
		sessionInfoPromises.set(sessionId, pending);
	}
	return pending;
}

// ── Custom editor provider ──────────────────────────────────

class CodePiChatDocument implements vscode.CustomDocument {
	constructor(public readonly uri: vscode.Uri) {}
	dispose(): void {}
}

class CodePiChatProvider
	implements vscode.CustomReadonlyEditorProvider<CodePiChatDocument>
{
	constructor(private readonly context: vscode.ExtensionContext) {}

	openCustomDocument(
		uri: vscode.Uri,
		_openContext: vscode.CustomDocumentOpenContext,
		_token: vscode.CancellationToken,
	): CodePiChatDocument {
		// Kick off session loading now; resolveCustomEditor awaits the result.
		void ensureSessionInfo(sessionIdFromUri(uri));
		return new CodePiChatDocument(uri);
	}

	async resolveCustomEditor(
		document: CodePiChatDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): Promise<void> {
		const sessionId = sessionIdFromUri(document.uri);
		const info = await ensureSessionInfo(sessionId);
		await setupTuiPanel(
			this.context,
			webviewPanel,
			info.sessionManager,
			sessionId,
			info.sessionPath,
		);
	}
}

// ── Panel Creation ───────────────────────────────────────────

async function createNewSessionPanel(): Promise<void> {
	clearTodoList();

	const pi = await getPi();
	const workspaceRoot = getWorkspaceRoot();

	const sessionManager = pi.SessionManager.create(workspaceRoot);
	const sessionId = sessionManager.getSessionId();
	const sessionPath = sessionManager.getSessionFile() || "";

	sessionRegistry.set(sessionId, { sessionManager, sessionPath });
	await vscode.commands.executeCommand(
		"vscode.openWith",
		chatUri(sessionId),
		CHAT_VIEW_TYPE,
	);
}

// Session clicks from the tree list: a quick second click (double-click)
// pins the preview tab, like the file explorer. Keyed by sessionId.
const lastTreeOpen = new Map<string, number>();
const TREE_DOUBLE_CLICK_MS = 300;

async function openExistingSessionPanel(
	sessionPath: string,
	opts?: { fromTree?: boolean },
): Promise<void> {
	const pi = await getPi();
	const workspaceRoot = getWorkspaceRoot();

	const sessionManager = pi.SessionManager.open(
		sessionPath,
		undefined,
		workspaceRoot,
	);
	const sessionId = sessionManager.getSessionId();

	// Reuse the registry entry if this session is already open in a tab.
	if (!sessionRegistry.has(sessionId)) {
		sessionRegistry.set(sessionId, { sessionManager, sessionPath });
	}

	// openWith reuses/reveals the existing editor for an already-open URI.
	// From the session list, the first click opens a preview tab; a quick
	// second click (double-click) makes it a regular (non-preview) tab.
	const now = Date.now();
	const last = lastTreeOpen.get(sessionId) ?? 0;
	lastTreeOpen.set(sessionId, now);
	const isDoubleClick =
		opts?.fromTree === true && now - last < TREE_DOUBLE_CLICK_MS;

	const showOptions: vscode.TextDocumentShowOptions = {
		preserveFocus: opts?.fromTree === true,
	};
	if (opts?.fromTree === true) {
		// First click: preview. Double-click: keep it as a regular tab.
		showOptions.preview = !isDoubleClick;
	}

	await vscode.commands.executeCommand(
		"vscode.openWith",
		chatUri(sessionId),
		CHAT_VIEW_TYPE,
		showOptions,
	);
}

async function pickSession(): Promise<void> {
	// Quick pick to select a session — not needed for now since the tree view
	// handles this, but useful as a fallback
	const sessions = treeProvider ? await getSessionsFromProvider() : [];
	if (sessions.length === 0) {
		vscode.window.showInformationMessage(
			"No sessions available. Create a new one first.",
		);
		return;
	}
	const items = sessions.map((s) => ({
		label: s.firstMessage || "Untitled",
		description: s.messageCount + " messages",
		detail: s.path,
	}));
	const picked = await vscode.window.showQuickPick(items);
	if (picked) {
		vscode.commands.executeCommand("codepi.openSession", picked.detail);
	}
}

async function getSessionsFromProvider(): Promise<
	Array<{ firstMessage: string; messageCount: number; path: string }>
> {
	// The provider loads sessions asynchronously — we need to manually load them
	try {
		const pi = await getPi();
		const workspaceRoot = getWorkspaceRoot();
		const all: any[] = await pi.SessionManager.list(workspaceRoot);
		return all
			.map((s: any) => ({
				firstMessage: s.firstMessage || "(empty)",
				messageCount: s.messageCount ?? 0,
				path: s.path,
			}))
			.sort((a: any, b: any) => b.messageCount - a.messageCount);
	} catch {
		return [];
	}
}

// ── Shared Panel Setup ──────────────────────────────────────

async function setupTuiPanel(
	context: vscode.ExtensionContext,
	panel: vscode.WebviewPanel,
	sessionManager: any,
	sessionId: string,
	sessionPath: string,
): Promise<PanelState> {
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [
			vscode.Uri.joinPath(context.extensionUri, "webview-ui", "dist"),
			vscode.Uri.joinPath(context.extensionUri, "media"),
		],
	};
	panel.webview.html = buildHtml(context.extensionUri, panel.webview);

	// Per-panel review manager: tools register proposals here; review events
	// drive editor decorations, the review status bar, and notifications
	// (the webview is a terminal now, so nothing is posted to it).
	let review: ReviewManager;
	review = new ReviewManager(
		{
			post: (msg) => {
				if (msg.command === "editProposed" || msg.command === "editUpdated") {
					const summary = msg.summary as { proposalId: string } | undefined;
					if (summary) {
						const proposal = review.getProposal(summary.proposalId);
						if (proposal) {
							if (
								proposal.status === "accepted" ||
								proposal.status === "rejected" ||
								proposal.status === "stale"
							) {
								reviewDecorations?.clearProposal(proposal.uri);
							} else {
								reviewDecorations?.setProposal(proposal);
							}
						}
					}
					updateReviewStatusBar();
				}
			},
			openFile: async (uriStr) => {
				try {
					const uri = vscode.Uri.parse(uriStr);
					const doc = await vscode.workspace.openTextDocument(uri);
					await vscode.window.showTextDocument(doc, {
						preview: false,
						preserveFocus: true,
					});
				} catch {
					/* ignore */
				}
			},
			promptFileReview: (summary) => {
				enqueueFileReviewPrompt(summary, state);
			},
			notify: (text) => {
				void vscode.window.showInformationMessage(text);
			},
		},
		{
			readContent: async (uriStr) => {
				const uri = vscode.Uri.parse(uriStr);
				const raw = await vscode.workspace.fs.readFile(uri);
				return new TextDecoder().decode(raw);
			},
			writeContent: async (uriStr, content) => {
				const uri = vscode.Uri.parse(uriStr);
				await vscode.workspace.fs.writeFile(
					uri,
					new TextEncoder().encode(content),
				);
			},
		},
	);

	const terminal = new WebviewTerminal((msg) => {
		try {
			panel.webview.postMessage(msg);
		} catch {
			/* panel gone */
		}
	});

	const state: PanelState = {
		panel,
		terminal,
		runtime: undefined as unknown as AgentSessionRuntime, // filled by startTuiBackend
		tui: undefined as unknown as InteractiveMode, // filled by startTuiBackend
		sessionManager,
		extensionUri: context.extensionUri,
		isBackendReady: false,
		isBusy: false,
		sessionId,
		sessionPath,
		disposables: [],
		review,
	};

	setPanelIcon(state, "idle");
	panels.set(sessionId, state);

	panel.onDidChangeViewState(
		() => {
			setPanelIcon(state, state.isBusy ? "busy" : "idle");
		},
		undefined,
		context.subscriptions,
	);

	const msgDisposable = panel.webview.onDidReceiveMessage(
		async (message: TuiWebviewMessage) => {
			await handleTuiMessage(message, state);
		},
		undefined,
		context.subscriptions,
	);
	state.disposables.push(msgDisposable);

	panel.onDidDispose(
		() => {
			cleanupPanel(sessionId);
		},
		undefined,
		context.subscriptions,
	);

	// Wait for xterm to be ready (bounded) before starting the TUI, so the
	// first frames are not lost; WebviewTerminal also buffers until ready.
	await Promise.race([
		new Promise<void>((resolve) => {
			terminalReadyWaiters.set(sessionId, resolve);
		}),
		new Promise((resolve) => setTimeout(resolve, 5000)),
	]);
	terminalReadyWaiters.delete(sessionId);

	startTuiBackend(state).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		setPanelIcon(state, "error");
		void vscode.window.showErrorMessage(`CodePi TUI backend error: ${msg}`);
		console.error("[CodePi] TUI backend error for panel", sessionId, ":", err);
	});

	return state;
}

function cleanupPanel(sessionId: string): void {
	const state = panels.get(sessionId);
	if (!state) return;

	panels.delete(sessionId);

	// Stop the TUI and dispose the runtime (disposes the session).
	try {
		state.tui?.stop();
	} catch {
		/* ignore */
	}
	void state.runtime?.dispose().catch(() => {
		/* ignore */
	});

	// Clear editor decorations for this panel's pending proposals.
	for (const p of state.review.allProposals()) {
		reviewDecorations?.clearProposal(p.uri);
	}
	updateReviewStatusBar();

	for (const d of state.disposables) {
		try {
			d.dispose();
		} catch {
			/* ignore */
		}
	}
}

// ── Backend Setup ────────────────────────────────────────────

/** Rebuild and repost the model list to a chat panel, re-reading models.json
 *  from disk so custom-model and API-key changes hot-apply. */
async function startTuiBackend(state: PanelState): Promise<void> {
	const pi = await getPi();
	const workspaceRoot = getWorkspaceRoot();
	const agentDir = getAgentDir();

	// Factory reused by the runtime for /new, /resume and /fork flows.
	const createRuntime: any = async (opts: any) => {
		const loader = new pi.DefaultResourceLoader({
			cwd: opts.cwd,
			agentDir: opts.agentDir,
			noExtensions: true,
		});
		await loader.reload();
		return pi.createAgentSession({
			resourceLoader: loader,
			cwd: opts.cwd,
			agentDir: opts.agentDir,
			noTools: "builtin",
			customTools: createVscodeTools(state.review),
			sessionManager: opts.sessionManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
	};

	const runtime = await pi.createAgentSessionRuntime(createRuntime, {
		cwd: workspaceRoot,
		agentDir,
		sessionManager: state.sessionManager,
	});
	state.runtime = runtime;

	// Set an initial tab title (the TUI's setTitle will refine it shortly).
	const entries = state.sessionManager.getEntries();
	const sessionName = state.sessionManager.getSessionName?.();
	const firstUserEntry = entries?.find(
		(e: any) => e.type === "message" && e.message?.role === "user",
	);
	const titleText =
		sessionName ||
		firstUserEntry?.message?.content?.[0]?.text ||
		"PI";
	setPanelTitle(
		state,
		titleText.length > 50 ? titleText.slice(0, 50) + "…" : titleText,
	);

	// Reconstruct todo state from the session (tool reads it on demand).
	try {
		reconstructFromEntries(entries ?? []);
	} catch (err) {
		console.error("[CodePi] Error reconstructing todos:", err);
	}

	state.tui = new pi.InteractiveMode(runtime, {
		terminal: state.terminal,
		verbose: true,
	});

	state.isBackendReady = true;
	state.isBusy = true;
	setPanelIcon(state, "busy");
	treeProvider?.refresh();

	// run() resolves when the TUI exits (e.g. /quit); errors surface here.
	void state.tui.run().catch((err: Error) => {
		console.error("[CodePi] TUI exited with error:", err);
		setPanelIcon(state, "error");
		void vscode.window.showErrorMessage(
			`CodePi TUI error: ${err.message || String(err)}`,
		);
	});
}

// ── Message Handling ─────────────────────────────────────────

async function handleTuiMessage(
	message: TuiWebviewMessage,
	state: PanelState,
): Promise<void> {
	if (message.command === "tui:ready") {
		terminalReadyWaiters.get(state.sessionId)?.();
		state.terminal.handleReady();
		return;
	}
	if (message.command === "tui:input") {
		state.terminal.handleInput(message.data);
		return;
	}
	if (message.command === "tui:resize") {
		state.terminal.handleResize(message.cols, message.rows);
		return;
	}
}

// ── File Review Prompt Queue ─────────────────────────────────

/**
 * VS Code shows `showInformationMessage` notifications in the bottom-right
 * corner. We queue one prompt per edited FILE so the user is asked to accept
 * or decline changes file by file, in order.
 */
function enqueueFileReviewPrompt(
	summary: EditProposalSummary,
	panel: PanelState,
): void {
	fileReviewQueue.push({ summary, panel });
	void pumpFileReviewQueue();
}

async function pumpFileReviewQueue(): Promise<void> {
	if (promptInFlight) return;
	promptInFlight = true;
	try {
		while (fileReviewQueue.length > 0) {
			const item = fileReviewQueue.shift();
			if (!item) break;
			const { summary, panel } = item;

			const proposal = panel.review.getProposal(summary.proposalId);
			if (!proposal || proposal.status !== "pending") continue;

			// Open the file so the user can see the inline diff before deciding.
			try {
				const uri = vscode.Uri.parse(proposal.uri);
				const doc = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(doc, { preview: false });
			} catch {
				/* ignore */
			}

			const c = summary.counts;
			const detail =
				`${c.total} change${c.total === 1 ? "" : "s"} · ` +
				`${c.linesAdded} added · ${c.linesRemoved} removed`;
			const choice = await vscode.window.showInformationMessage(
				`CodePi edited ${summary.path}`,
				{ detail, modal: false },
				"Accept",
				"Decline",
				"Open Diff",
			);

			if (choice === "Accept") {
				await panel.review.acceptFile(summary.proposalId);
			} else if (choice === "Decline") {
				await panel.review.rejectFile(summary.proposalId);
			} else if (choice === "Open Diff") {
				const p = panel.review.getProposal(summary.proposalId);
				if (p) await openProposalDiff(p);
				// Re-queue so the file is still asked for later.
				fileReviewQueue.push({ summary, panel });
			}
			// Dismiss (or modal close) → leave pending; user can act later.
		}
	} finally {
		promptInFlight = false;
	}
}

// ── HTML Builder ─────────────────────────────────────────────

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
  <title>PI</title>
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

// ── Deactivation ─────────────────────────────────────────────

export function deactivate() {
	for (const [, state] of panels) {
		try {
			state.tui?.stop();
		} catch {
			/* ignore */
		}
		void state.runtime?.dispose().catch(() => {
			/* ignore */
		});
	}
	panels.clear();
}
