import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { PiEventRelay } from "./bridge/relay";
import {
	createVscodeTools,
	setWriteMode,
	resolveQuestion,
	getTodoList,
	setTodoList,
	clearTodoList,
	reconstructFromEntries,
} from "./tools/index";
import { SessionTreeProvider, SessionTreeItem } from "./views/session-tree";
import { ReviewManager } from "./review/review-manager";
import { ReviewDecorations, openProposalDiff } from "./review/decorations";
import type { EditProposalSummary } from "./review/types";
import type { WebviewMessage } from "./bridge/protocol";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SettingsViewProvider } from "./settings-view";
import {
	detectLegacyConfig,
	getAgentDir,
	importLegacyConfig,
	setAgentDir,
} from "./pi-store";

// ── Types ────────────────────────────────────────────────────

interface PanelState {
	panel: vscode.WebviewPanel;
	session: AgentSession;
	relay: PiEventRelay;
	sessionManager: any; // SessionManager from PI SDK
	extensionUri: vscode.Uri;
	isBackendReady: boolean;
	isBusy: boolean;
	mode: "ask" | "plan" | "agent";
	sessionId: string;
	sessionPath: string;
	disposables: vscode.Disposable[];
	review: ReviewManager;
}

// ── Globals ──────────────────────────────────────────────────

const panels = new Map<string, PanelState>();
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
				// Real implementation lands in Task 7 (refreshPanelModels).
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
			const choice = await vscode.window.showQuickPick(
				[
					{ label: "Import config + sessions", detail: "Copy settings.json, auth.json, models.json and the sessions/ folder" },
					{ label: "Import config only", detail: "Copy settings.json, auth.json, models.json" },
				],
				{ placeHolder: "Import pi configuration from ~/.pi/agent" },
			);
			if (!choice) return;
			try {
				const res = importLegacyConfig(legacyDir, agentDir, {
					includeSessions: choice.label.startsWith("Import config +"),
				});
				vscode.window.showInformationMessage(
					`Imported into CodePi storage: ${res.imported.join(", ") || "nothing new"}.`,
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					`Failed to import pi config: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
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
		await setupChatPanel(
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

async function setupChatPanel(
	context: vscode.ExtensionContext,
	panel: vscode.WebviewPanel,
	sessionManager: any,
	sessionId: string,
	sessionPath: string,
): Promise<PanelState> {
	const relay = new PiEventRelay();

	// The panel is provided by the custom-editor provider — configure its
	// webview here (this must happen during resolve).
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [
			vscode.Uri.joinPath(context.extensionUri, "webview-ui", "dist"),
			vscode.Uri.joinPath(context.extensionUri, "media"),
		],
	};
	panel.webview.html = buildHtml(context.extensionUri, panel.webview);
	relay.setWebview(panel.webview);

	// Per-panel review manager: tools created for this session register their
	// proposals here, and review events are posted to this panel's webview.
	let review: ReviewManager;
	review = new ReviewManager(
		{
			post: (msg) => {
				// Keep editor decorations in sync with review state.
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
				try {
					panel.webview.postMessage(msg);
				} catch {
					/* panel gone */
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

	const state: PanelState = {
		panel,
		session: undefined as unknown as AgentSession, // filled after backend starts
		relay,
		sessionManager,
		extensionUri: context.extensionUri,
		isBackendReady: false,
		isBusy: false,
		mode: "agent",
		sessionId,
		sessionPath,
		disposables: [],
		review,
	};

	// Tab handle icon: always the pi logo, colored by agent status
	// (idle = green, busy = blue, error = yellow). Inlined as a data: URI so
	// it renders even in Remote / Web contexts where server-side `file://`
	// paths are not reachable from the client.
	setPanelIcon(state, "idle");

	panels.set(sessionId, state);

	// Some VS Code versions fail to refresh webview tab icons when the panel
	// is hidden or restored — re-assert the status icon on every view-state
	// change so the logo stays visible.
	panel.onDidChangeViewState(
		() => {
			setPanelIcon(state, state.isBusy ? "busy" : "idle");
		},
		undefined,
		context.subscriptions,
	);

	// Handle messages from this panel's webview
	const msgDisposable = panel.webview.onDidReceiveMessage(
		async (message: WebviewMessage) => {
			console.log(
				"[CodePi] received from webview:",
				message.command,
				"panel:",
				sessionId,
			);
			await handleWebviewMessage(message, state);
		},
		undefined,
		context.subscriptions,
	);
	state.disposables.push(msgDisposable);

	// Handle panel disposal
	panel.onDidDispose(
		() => {
			cleanupPanel(sessionId);
		},
		undefined,
		context.subscriptions,
	);

	// Start backend (async)
	startBackend(state).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		setPanelIcon(state, "error");
		panel.webview.postMessage({
			command: "error",
			text: `Backend error: ${msg}`,
		});
		console.error("[CodePi] Backend error for panel", sessionId, ":", err);
	});

	return state;
}

function cleanupPanel(sessionId: string): void {
	const state = panels.get(sessionId);
	if (!state) return;

	const wasBusy = state.isBusy;
	const sessionPath = state.sessionPath;
	const savedSessionManager = state.sessionManager;

	panels.delete(sessionId);
	state.relay.detach();

	// Clear editor decorations for this panel's pending proposals.
	for (const p of state.review.allProposals()) {
		reviewDecorations?.clearProposal(p.uri);
	}
	updateReviewStatusBar();

	if (state.session) {
		try {
			state.session.dispose();
		} catch {
			/* ignore */
		}
	}
	for (const d of state.disposables) {
		try {
			d.dispose();
		} catch {
			/* ignore */
		}
	}

	// If the panel was busy generating, ask to confirm close
	if (wasBusy && sessionPath && savedSessionManager) {
		setTimeout(async () => {
			const choice = await vscode.window.showWarningMessage(
				"PI is still generating. Close anyway?",
				{ modal: true },
				"Cancel",
				"Close Anyway",
			);
			if (choice === "Cancel" || choice === undefined) {
				// Recreate the chat editor — feels like close was prevented.
				const sid = savedSessionManager.getSessionId();
				sessionRegistry.set(sid, {
					sessionManager: savedSessionManager,
					sessionPath,
				});
				await vscode.commands.executeCommand(
					"vscode.openWith",
					chatUri(sid),
					CHAT_VIEW_TYPE,
				);
			}
			// "Close Anyway" → leave closed
		}, 0);
	}
}

// ── Backend Setup ────────────────────────────────────────────

async function startBackend(state: PanelState): Promise<void> {
	console.time("[CodePi] startBackend panel:" + state.sessionId);
	const pi = await getPi();
	const workspaceRoot = getWorkspaceRoot();

	const loader = new pi.DefaultResourceLoader({
		cwd: workspaceRoot,
		agentDir: getAgentDir(),
		noExtensions: true,
	});
	await loader.reload();

	const { session } = await pi.createAgentSession({
		resourceLoader: loader,
		cwd: workspaceRoot,
		agentDir: getAgentDir(),
		noTools: "builtin",
		customTools: createVscodeTools(state.review),
		sessionManager: state.sessionManager,
	});

	console.log("[CodePi] Session created, model:", session.model?.id);

	if (!session.model) {
		throw new Error(
			"No AI model available. Configure an API key by running `pi /login` in a terminal, " +
				"or set the ANTHROPIC_API_KEY environment variable.",
		);
	}

	state.session = session;
	state.relay.attach(session);

	// Get models — the FULL catalog (getAll), not just providers with
	// configured auth (getAvailable), so the model selector isn't missing
	// models.
	const models: Array<{ provider: string; modelId: string }> = [];
	try {
		const registry: any = (session as any).modelRegistry;
		const avail: any[] = registry?.getAll?.() ?? registry?.getAvailable?.() ?? [];
		if (avail && avail.length > 0) {
			for (const m of avail) {
				const prov = String(m.provider ?? "");
				const mid = String(m.id ?? "");
				if (prov && mid) {
					models.push({ provider: prov, modelId: mid });
				}
			}
		}
	} catch (err) {
		console.error("[CodePi] Error getting available models:", err);
	}

	if (session.model) {
		const curProv = String((session.model as any).provider ?? "");
		const curId = String(session.model.id ?? "");
		if (!models.some((m) => m.provider === curProv && m.modelId === curId)) {
			models.unshift({ provider: curProv, modelId: curId });
		}
	}

	state.panel.webview.postMessage({ command: "modelList", models });
	const toolNames = createVscodeTools(state.review).map((t) => t.name);
	state.panel.webview.postMessage({
		command: "toolsInfo",
		tools: toolNames,
	});
	state.panel.webview.postMessage({ command: "modeInfo", mode: "agent" });
	console.log(
		"[CodePi] Sent",
		models.length,
		"models, tools:",
		toolNames.join(", "),
	);

	// Save the SDK tool list for mode switching
	(state as any)._allSdkTools = session.agent?.state?.tools;

	// Restore session history if loading an existing session
	const entries = state.sessionManager.getEntries();
	if (entries && entries.length > 0) {
		try {
			// Replay through same event pipeline as live chat for identical rendering
			const replayEvents = buildReplayEvents(entries);
			if (replayEvents.length > 0) {
				console.log(
					"[CodePi] Replaying",
					replayEvents.length,
					"events from session history",
				);
				state.panel.webview.postMessage({
					command: "replayEvents",
					events: replayEvents,
				});
			}
			// Set tab title: the pi logo icon already identifies the panel — the
			// title is just the session name (explicit rename) or the first
			// user message.
			const sessionName = state.sessionManager.getSessionName?.();
			const firstUserEntry = entries.find(
				(e: any) => e.type === "message" && e.message?.role === "user",
			);
			const titleText =
				sessionName || firstUserEntry?.message?.content?.[0]?.text || "";
			if (titleText) {
				const truncated =
					titleText.length > 50 ? titleText.slice(0, 50) + "…" : titleText;
				setPanelTitle(state, truncated);
			}
		} catch (err) {
			console.error("[CodePi] Error replaying session history:", err);
		}

		// Reconstruct todo list from session entries
		try {
			reconstructFromEntries(entries);
			const todos = getTodoList();
			if (todos.length > 0) {
				state.panel.webview.postMessage({ command: "todoUpdate", todos });
			}
		} catch (err) {
			console.error("[CodePi] Error reconstructing todos:", err);
		}
	}

	state.isBackendReady = true;
	console.timeEnd("[CodePi] startBackend panel:" + state.sessionId);

	state.panel.webview.postMessage({ command: "backendReady" });
	state.panel.webview.postMessage({
		command: "modelInfo",
		provider: String((session.model as any).provider ?? ""),
		modelId: String(session.model.id ?? ""),
		thinkingLevel: session.thinkingLevel ?? "medium",
		supportsThinking: Boolean(
			(session as any).supportsThinking?.() ?? (session.model as any)?.reasoning,
		),
		availableThinkingLevels: ((session as any).getAvailableThinkingLevels?.() ?? []).map(String),
	});

	// Refresh the session tree to show the new session
	treeProvider?.refresh();
}

// ── Message Handling ─────────────────────────────────────────

async function handleWebviewMessage(
	message: WebviewMessage,
	state: PanelState,
): Promise<void> {
	if (message.command === "abort") {
		try {
			await state.session?.abort();
			state.isBusy = false;
			setPanelIcon(state, "idle");
		} catch {
			/* ignore */
		}
		return;
	}

	if (message.command === "answerQuestion") {
		resolveQuestion(message.toolCallId, message.answers ?? {});
		return;
	}

	// Todo list user interaction — silent update, no prompt trigger
	if (message.command === "todoChange") {
		setTodoList(message.todos);
		return;
	}

	// ── Edit review actions (do NOT require the chat backend) ──
	if (message.command === "acceptHunk") {
		await state.review.acceptHunk(message.proposalId, message.hunkId);
		return;
	}
	if (message.command === "rejectHunk") {
		await state.review.rejectHunk(message.proposalId, message.hunkId);
		return;
	}
	if (message.command === "acceptFile") {
		await state.review.acceptFile(message.proposalId);
		return;
	}
	if (message.command === "rejectFile") {
		await state.review.rejectFile(message.proposalId);
		return;
	}
	if (message.command === "acceptAllEdits") {
		await state.review.acceptAll();
		return;
	}
	if (message.command === "rejectAllEdits") {
		await state.review.rejectAll();
		return;
	}
	if (message.command === "openDiff") {
		const proposal = state.review.getProposal(message.proposalId);
		if (proposal) await openProposalDiff(proposal);
		return;
	}

	if (!state.isBackendReady || !state.session) {
		console.warn(
			"[CodePi] Backend not ready yet, dropping message:",
			message.command,
		);
		state.panel.webview.postMessage({
			command: "error",
			text: "Backend is still starting up. Please wait a moment and try again.",
		});
		return;
	}

	if (message.command === "prompt") {
		// Update tab title on first message if not already set
		const msgEntries = state.sessionManager
			.getEntries()
			.filter((e: any) => e.type === "message");
		if (msgEntries.length === 0) {
			const sessionName = state.sessionManager.getSessionName?.();
			const titleText = sessionName || message.text;
			const truncated =
				titleText.length > 50 ? titleText.slice(0, 50) + "…" : titleText;
			setPanelTitle(state, truncated);
		}
		const promptStartTime = Date.now();
		console.log(
			"[CodePi] Sending prompt to agent:",
			message.text.slice(0, 200),
		);
		state.isBusy = true;
		setPanelIcon(state, "busy");
		if (state.session.isStreaming) {
			state.session
				.steer(message.text)
				.then(() => {
					state.isBusy = false;
					setPanelIcon(state, "idle");
				})
				.catch((err: Error) => {
					console.error("[CodePi] Steer error:", err);
					setPanelIcon(state, "error");
				});
		} else {
			state.session
				.prompt(message.text)
				.then(() => {
					console.log(
						"[CodePi] Prompt completed in",
						Date.now() - promptStartTime,
						"ms",
					);
					state.isBusy = false;
					setPanelIcon(state, "idle");
					treeProvider?.refresh();
				})
				.catch((err: Error) => {
					console.error(
						"[CodePi] Agent error after",
						Date.now() - promptStartTime,
						"ms:",
						err,
					);
					state.isBusy = false;
					setPanelIcon(state, "error");
					state.panel.webview.postMessage({
						command: "error",
						text: err.message || String(err),
					});
				});
		}
	} else if (message.command === "steer") {
		state.isBusy = true;
		setPanelIcon(state, "busy");
		state.session
			.steer(message.text)
			.then(() => {
				state.isBusy = false;
				setPanelIcon(state, "idle");
			})
			.catch(() => {});
	} else if (message.command === "followUp") {
		state.isBusy = true;
		setPanelIcon(state, "busy");
		state.session
			.followUp(message.text)
			.then(() => {
				state.isBusy = false;
				setPanelIcon(state, "idle");
			})
			.catch(() => {});
	} else if (message.command === "setModel") {
		try {
			const registry: any = (state.session as any).modelRegistry;
			if (!registry) return;
			// Match against the full catalog (getAll), since the selector now
			// shows all models, not just providers with configured auth.
			const all: any[] = registry.getAll?.() ?? registry.getAvailable?.() ?? [];
			const model = all.find(
				(m: any) =>
					String(m.provider ?? "") === message.provider &&
					String(m.id ?? "") === message.modelId,
			);
			if (model) {
				console.log("[CodePi] Setting model:", model.provider, model.id);
				await state.session.setModel(model);
				state.relay.emitModelInfo();
			} else {
				console.warn(
					"[CodePi] Model not available:",
					message.provider,
					message.modelId,
				);
			}
		} catch (err) {
			console.error("[CodePi] setModel error:", err);
			// Surface the failure (e.g. provider has no API key) in the chat.
			state.panel.webview.postMessage({
				command: "error",
				text: err instanceof Error ? err.message : String(err),
			});
		}
	} else if (message.command === "setMode") {
		try {
			const newMode = message.mode;
			const oldMode = state.mode;
			if (newMode === oldMode) return;
			state.mode = newMode;
			setWriteMode(newMode);
			// Filter/unfilter tools from the agent's tool list
			const allTools =
				(state as any)._allSdkTools || state.session?.agent?.state?.tools;
			if (allTools) {
				(state as any)._allSdkTools = allTools;
				if (newMode === "ask") {
					state.session.agent.state.tools = allTools.filter(
						(t: any) => t.name !== "write" && t.name !== "edit" && t.name !== "todo",
					);
					state.panel.webview.postMessage({
						command: "toolsInfo",
						tools: [
							"read",
							"list_dir",
							"find_files",
							"grep",
							"ask_user_question",
						],
					});
				} else {
					state.session.agent.state.tools = allTools;
					state.panel.webview.postMessage({
						command: "toolsInfo",
						tools: ["read", "write", "edit", "list_dir", "find_files", "grep"],
					});
				}
			}
			state.panel.webview.postMessage({ command: "modeInfo", mode: newMode });
			console.log("[CodePi] Mode changed:", oldMode, "→", newMode);
		} catch (err) {
			console.error("[CodePi] setMode error:", err);
		}
	} else if (message.command === "setThinkingLevel") {
		try {
			state.session?.setThinkingLevel(message.level as any);
			const effective = state.session?.thinkingLevel ?? message.level;
			console.log(
				"[CodePi] Thinking level set →",
				effective,
				"(requested",
				message.level + ")",
			);
		} catch (err) {
			console.error("[CodePi] setThinkingLevel error:", err);
		}
		state.relay.emitModelInfo();
	} else if (message.command === "newSession") {
		// Open a new panel with a fresh session instead of replacing current
		vscode.commands.executeCommand("codepi.newSession");
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

// ── Session History Replay ────────────────────────────────────

/**
 * Convert session entries into ExtensionMessage[] events that mirror
 * the live chat relay pipeline. The webview processes these through
 * the exact same chatReducer code path as real-time events, producing
 * identical rendering, interaction stats, and session footer stats.
 */
function buildReplayEvents(
	entries: any[],
): import("./bridge/protocol").ReplayEvent[] {
	const events: import("./bridge/protocol").ReplayEvent[] = [];

	// Accumulated session stats
	let totalTokensIn = 0;
	let totalTokensOut = 0;
	let totalCost = 0;
	let cacheRateWeight = 0;
	let cacheRateSum = 0;
	let lastContextUsed = 0;
	let totalDuration = 0;
	let totalOutputForSpeed = 0;

	// Track model info from the latest model_change entry
	let modelProvider = "";
	let modelId = "";

	// Helper to extract text from a content block
	function getBlockText(block: any): string | null {
		if (block.type === "text" && typeof block.text === "string")
			return block.text;
		if (block.type === "thinking" && typeof block.thinking === "string")
			return block.thinking;
		return null;
	}

	// Helper to extract tool result text
	function extractToolResultText(msg: any): string {
		const c = msg.content;
		if (!c) return "";
		if (typeof c === "string") return c;
		if (Array.isArray(c)) {
			return c
				.filter((x: any) => x?.type === "text" && typeof x.text === "string")
				.map((x: any) => x.text)
				.join("\n");
		}
		return "";
	}

	// First pass: collect model info from model_change entries
	for (const entry of entries) {
		if (entry.type === "model_change") {
			modelProvider = entry.provider || "";
			modelId = entry.modelId || "";
		}
	}

	// Group entries into interactions: user → [assistant + toolResults]*
	// We iterate and emit events for each interaction
	let i = 0;
	while (i < entries.length) {
		const entry = entries[i];

		if (entry.type === "message" && entry.message?.role === "user") {
			// Start a new interaction — skip user messages (they're rendered by addUserMessage)
			i++;
			continue;
		}

		if (entry.type === "message" && entry.message?.role === "assistant") {
			emitInteraction(entry, i);
			i++;
			continue;
		}

		i++;
	}

	function emitInteraction(_firstAssistantEntry: any, startIdx: number) {
		// Collect all consecutive assistant + toolResult entries for this interaction
		const assistantEntries: any[] = [];
		const toolResultEntries: any[] = [];

		let idx = startIdx;
		while (idx < entries.length) {
			const e = entries[idx];
			if (e.type !== "message") break;
			const role = e.message?.role;
			if (role === "assistant") {
				assistantEntries.push(e);
			} else if (role === "toolResult") {
				toolResultEntries.push(e);
			} else {
				break; // user or other type ends this interaction
			}
			idx++;
		}

		// Emit agentStart for the interaction
		events.push({ command: "agentStart" });

		// Map tool results by toolCallId for quick lookup
		const resultByCallId = new Map<string, any>();
		for (const tr of toolResultEntries) {
			const tcId = tr.message?.toolCallId;
			if (tcId) resultByCallId.set(tcId, tr);
		}

		// Emit events for each assistant message in the interaction
		for (let ai = 0; ai < assistantEntries.length; ai++) {
			const asst = assistantEntries[ai];
			const msg = asst.message;
			const content = msg?.content || [];
			const usage = msg?.usage;

			events.push({ command: "segmentStart" });

			// Emit content blocks in order
			for (const block of content) {
				const text = getBlockText(block);
				if (text !== null) {
					if (block.type === "thinking") {
						events.push({ command: "thinkingDelta", delta: text });
						events.push({ command: "thinkingEnd" });
					} else {
						events.push({ command: "textDelta", delta: text });
					}
				} else if (block.type === "toolCall" || block.type === "tool_use") {
					const tcId = block.id || `replay-tc-${events.length}`;
					const tcName = block.name ?? "";
					const tcArgs = block.input ?? block.arguments ?? {};
					events.push({
						command: "toolCallStart",
						toolCallId: tcId,
						toolName: tcName,
						args: tcArgs,
					});

					// Emit tool result if available
					const resultEntry = resultByCallId.get(tcId);
					if (resultEntry) {
						const resultText = extractToolResultText(resultEntry.message);
						const isError = resultEntry.message?.isError ?? false;
						if (resultText) {
							events.push({
								command: "toolCallUpdate",
								toolCallId: tcId,
								text: resultText,
							});
						}
						events.push({
							command: "toolCallEnd",
							toolCallId: tcId,
							result: resultText,
							isError,
						});
						resultByCallId.delete(tcId);
					}
				}
			}

			// Any tool results without matching content blocks (edge case)
			for (const [tcId, tr] of resultByCallId) {
				const resultText = extractToolResultText(tr.message);
				const isError = tr.message?.isError ?? false;
				events.push({
					command: "toolCallStart",
					toolCallId: tcId,
					toolName: tr.message?.toolName ?? "",
					args: {},
				});
				if (resultText) {
					events.push({
						command: "toolCallUpdate",
						toolCallId: tcId,
						text: resultText,
					});
				}
				events.push({
					command: "toolCallEnd",
					toolCallId: tcId,
					result: resultText,
					isError,
				});
			}

			// Emit segmentEnd with usage data
			const tokensIn = usage?.input ?? 0;
			const tokensOut = usage?.output ?? 0;
			const thinkingTokens = usage?.reasoning ?? usage?.thinking ?? 0;
			const cost = usage?.cost?.total ?? 0;
			const cacheHit = usage?.cacheRead ?? 0;
			const duration = usage?.duration ?? 0;

			totalTokensIn += tokensIn;
			totalTokensOut += tokensOut;
			totalCost += cost;
			lastContextUsed = usage?.totalTokens ?? lastContextUsed;
			totalDuration += duration;
			totalOutputForSpeed += tokensOut;
			if (tokensIn > 0) {
				cacheRateSum += cacheHit * tokensIn;
				cacheRateWeight += tokensIn;
			}

			events.push({
				command: "segmentEnd",
				tokensIn,
				tokensOut,
				thinkingTokens,
				totalCost: cost,
				modelProvider,
				modelId,
				cacheHit: tokensIn > 0 ? cacheHit / tokensIn : 0,
				duration,
			});
		}

		// Close the interaction
		events.push({ command: "agentEnd", willRetry: false });
	}

	// Emit accumulated session info
	const speed =
		totalDuration > 0 ? Math.round(totalOutputForSpeed / totalDuration) : 0;
	const avgCacheRate = cacheRateWeight > 0 ? cacheRateSum / cacheRateWeight : 0;
	events.push({
		command: "sessionInfo",
		tokensIn: totalTokensIn,
		tokensOut: totalTokensOut,
		totalCost,
		contextUsed: lastContextUsed,
		contextLimit: 200000,
		speed,
		cacheRate: avgCacheRate,
	});

	// Emit toolsInfo so tools show in the welcome area
	events.push({
		command: "toolsInfo",
		tools: ["read", "write", "edit", "list_dir", "find_files", "grep", "todo", "ask_user_question"],
	});

	return events;
}

// ── Deactivation ─────────────────────────────────────────────

export function deactivate() {
	for (const [id, state] of panels) {
		state.relay.detach();
		if (state.session) {
			try {
				state.session.dispose();
			} catch {
				/* ignore */
			}
		}
	}
	panels.clear();
}
