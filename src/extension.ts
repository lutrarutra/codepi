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
import { TuiPty } from "./tui/tui-pty";
import { SettingsViewProvider } from "./settings-view";
import {
	detectLegacyConfig,
	getAgentDir,
	importLegacyConfig,
	setAgentDir,
} from "./pi-store";
import { runImportFlow } from "./import-config";

// ── Types ────────────────────────────────────────────────────

interface SessionState {
	terminal: vscode.Terminal;
	pty: TuiPty;
	runtime: AgentSessionRuntime;
	tui: InteractiveMode;
	sessionManager: any; // SessionManager from PI SDK
	isBackendReady: boolean;
	isBusy: boolean;
	sessionId: string;
	sessionPath: string;
	disposables: vscode.Disposable[];
	review: ReviewManager;
}

// ── Globals ──────────────────────────────────────────────────

// sessionId → live TUI session. Each session runs its own InteractiveMode
// inside a VS Code integrated terminal (editor area).
const sessions = new Map<string, SessionState>();
let treeProvider: SessionTreeProvider | undefined;

// Shared editor decorations + CodeLens for ALL sessions' pending edits.
let reviewDecorations: ReviewDecorations | undefined;

// Bottom-right per-file review prompts, queued so files are asked one by one.
const fileReviewQueue: Array<{ summary: EditProposalSummary; state: SessionState }> = [];
let promptInFlight = false;

// Status-bar item showing how many edits are pending review.
let reviewStatusBar: vscode.StatusBarItem | undefined;

/** Refresh the global "N edits pending review" status-bar item. */
function updateReviewStatusBar(): void {
	let pendingFiles = 0;
	let pendingHunks = 0;
	for (const [, st] of sessions) {
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
			for (const [, state] of sessions) {
				if (state.review.getProposal(proposalId)) {
					await state.review.acceptHunk(proposalId, hunkId);
					break;
				}
			}
		},
		rejectHunk: async (proposalId: string, hunkId: string) => {
			for (const [, state] of sessions) {
				if (state.review.getProposal(proposalId)) {
					await state.review.rejectHunk(proposalId, hunkId);
					break;
				}
			}
		},
		acceptFile: async (proposalId: string) => {
			for (const [, state] of sessions) {
				if (state.review.getProposal(proposalId)) {
					await state.review.acceptFile(proposalId);
					break;
				}
			}
		},
		rejectFile: async (proposalId: string) => {
			for (const [, state] of sessions) {
				if (state.review.getProposal(proposalId)) {
					await state.review.rejectFile(proposalId);
					break;
				}
			}
		},
		openDiff: async (proposalId: string) => {
			for (const [, state] of sessions) {
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
			for (const [, state] of sessions) {
				await state.review.acceptAll();
			}
		}),
		vscode.commands.registerCommand("codepi.rejectAllEdits", async () => {
			for (const [, state] of sessions) {
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
				state: SessionState;
			}> = [];
			for (const [, st] of sessions) {
				for (const p of st.review.allProposals()) {
					if (p.status !== "pending") continue;
					const c = st.review.counts(p);
					if (c.pending === 0) continue;
					items.push({
						label: p.path,
						description: `${c.pending} change${c.pending === 1 ? "" : "s"} pending`,
						detail: `${c.linesAdded} added · ${c.linesRemoved} removed`,
						proposal: st.review.summary(p),
						state: st,
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
			const proposal = picked.state.review.getProposal(
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

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand("codepi.openPanel", () => {
			void createNewSession();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("codepi.newSession", () => {
			void createNewSession();
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
				// Reuse the existing terminal tab if the session is already open.
				await openSessionTerminal(sessionPath, opts);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"codepi.renameSession",
			async (item?: SessionTreeItem) => {
				if (!item) return;
				await treeProvider?.renameSession(item.session.path);
				// Keep an open session's terminal tab title in sync with the new name.
				for (const [, state] of sessions) {
					if (state.sessionPath === item.session.path) {
						const name = state.sessionManager.getSessionName?.();
						if (name) {
							state.pty.setTitle(
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

				// Close any terminal hosting this session
				const sessionPath = item.session.path;
				for (const [id, state] of sessions) {
					if (state.sessionPath === sessionPath) {
						state.terminal.dispose();
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

// ── Session Creation ─────────────────────────────────────────

/** Create a brand-new session and open its TUI terminal tab. */
async function createNewSession(): Promise<void> {
	clearTodoList();

	const pi = await getPi();
	const workspaceRoot = getWorkspaceRoot();

	const sessionManager = pi.SessionManager.create(workspaceRoot);
	const sessionId = sessionManager.getSessionId();
	const sessionPath = sessionManager.getSessionFile() || "";

	startTuiSession(sessionManager, sessionId, sessionPath).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		void vscode.window.showErrorMessage(`CodePi: ${msg}`);
	});
}

/**
 * Open a session in a TUI terminal tab. Reuses (focuses) the existing
 * terminal when the session is already open.
 */
async function openSessionTerminal(
	sessionPath: string,
	_opts?: { fromTree?: boolean },
): Promise<void> {
	const pi = await getPi();
	const workspaceRoot = getWorkspaceRoot();

	const sessionManager = pi.SessionManager.open(
		sessionPath,
		undefined,
		workspaceRoot,
	);
	const sessionId = sessionManager.getSessionId();

	const existing = sessions.get(sessionId);
	if (existing) {
		existing.terminal.show();
		return;
	}

	startTuiSession(sessionManager, sessionId, sessionPath).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		void vscode.window.showErrorMessage(`CodePi: ${msg}`);
	});
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

// ── Session Setup ────────────────────────────────────────────

/**
 * Create the VS Code terminal (editor area) hosting a session's TUI and run
 * the in-process InteractiveMode inside it.
 */
async function startTuiSession(
	sessionManager: any,
	sessionId: string,
	sessionPath: string,
): Promise<void> {
	// Per-session review manager: tools register proposals here; review
	// events drive editor decorations, the review status bar, and
	// notifications.
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

	// Initial terminal name: session name or the first user message.
	const entries = sessionManager.getEntries();
	const sessionName = sessionManager.getSessionName?.();
	const firstUserEntry = entries?.find(
		(e: any) => e.type === "message" && e.message?.role === "user",
	);
	const titleText =
		sessionName ||
		firstUserEntry?.message?.content?.[0]?.text ||
		"PI";
	const initialTitle =
		titleText.length > 50 ? titleText.slice(0, 50) + "…" : titleText;

	const pty = new TuiPty(initialTitle, () => cleanupSession(sessionId));
	const terminal = vscode.window.createTerminal({
		name: initialTitle,
		iconPath: new vscode.ThemeIcon(
			"codepi-logo",
			new vscode.ThemeColor("codepi.logo"),
		),
		location: vscode.TerminalLocation.Editor,
		pty,
	});

	const state: SessionState = {
		terminal,
		pty,
		runtime: undefined as unknown as AgentSessionRuntime, // filled by startTuiBackend
		tui: undefined as unknown as InteractiveMode, // filled by startTuiBackend
		sessionManager,
		isBackendReady: false,
		isBusy: false,
		sessionId,
		sessionPath,
		disposables: [],
		review,
	};
	sessions.set(sessionId, state);

	terminal.show();

	// Clean up session state when its terminal tab is closed.
	const closeSub = vscode.window.onDidCloseTerminal((term) => {
		if (term === terminal) cleanupSession(sessionId);
	});
	state.disposables.push(closeSub);

	// Start the backend once VS Code has opened the pty (real size known);
	// the pty buffers any output that arrives before that.
	void (async () => {
		await pty.waitForOpen();
		await startTuiBackend(state);
	})().catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		cleanupSession(sessionId);
		void vscode.window.showErrorMessage(`CodePi TUI backend error: ${msg}`);
		console.error("[CodePi] TUI backend error for session", sessionId, ":", err);
	});
}

function cleanupSession(sessionId: string): void {
	const state = sessions.get(sessionId);
	if (!state) return;

	sessions.delete(sessionId);

	// Stop the TUI and dispose the runtime (disposes the session).
	try {
		state.tui?.stop();
	} catch {
		/* ignore */
	}
	void state.runtime?.dispose().catch(() => {
		/* ignore */
	});

	// Clear editor decorations for this session's pending proposals.
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

async function startTuiBackend(state: SessionState): Promise<void> {
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

	// Reconstruct todo state from the session (tool reads it on demand).
	try {
		reconstructFromEntries(state.sessionManager.getEntries() ?? []);
	} catch (err) {
		console.error("[CodePi] Error reconstructing todos:", err);
	}

	state.tui = new pi.InteractiveMode(runtime, {
		terminal: state.pty,
		verbose: true,
	});

	state.isBackendReady = true;
	state.isBusy = true;
	treeProvider?.refresh();

	// run() resolves when the TUI exits (e.g. /quit) → close the terminal tab.
	void state.tui
		.run()
		.then(() => {
			state.terminal.dispose();
		})
		.catch((err: Error) => {
			console.error("[CodePi] TUI exited with error:", err);
			void vscode.window.showErrorMessage(
				`CodePi TUI error: ${err.message || String(err)}`,
			);
		});
}

// ── File Review Prompt Queue ─────────────────────────────────

/**
 * VS Code shows `showInformationMessage` notifications in the bottom-right
 * corner. We queue one prompt per edited FILE so the user is asked to accept
 * or decline changes file by file, in order.
 */
function enqueueFileReviewPrompt(
	summary: EditProposalSummary,
	state: SessionState,
): void {
	fileReviewQueue.push({ summary, state });
	void pumpFileReviewQueue();
}

async function pumpFileReviewQueue(): Promise<void> {
	if (promptInFlight) return;
	promptInFlight = true;
	try {
		while (fileReviewQueue.length > 0) {
			const item = fileReviewQueue.shift();
			if (!item) break;
			const { summary, state } = item;

			const proposal = state.review.getProposal(summary.proposalId);
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
				await state.review.acceptFile(summary.proposalId);
			} else if (choice === "Decline") {
				await state.review.rejectFile(summary.proposalId);
			} else if (choice === "Open Diff") {
				const p = state.review.getProposal(summary.proposalId);
				if (p) await openProposalDiff(p);
				// Re-queue so the file is still asked for later.
				fileReviewQueue.push({ summary, state });
			}
			// Dismiss (or modal close) → leave pending; user can act later.
		}
	} finally {
		promptInFlight = false;
	}
}

function getWorkspaceRoot(): string {
	const ws = vscode.workspace.workspaceFolders?.[0];
	return ws?.uri.fsPath ?? os.homedir();
}

// ── Deactivation ─────────────────────────────────────────────

export function deactivate() {
	for (const [, state] of sessions) {
		try {
			state.tui?.stop();
		} catch {
			/* ignore */
		}
		void state.runtime?.dispose().catch(() => {
			/* ignore */
		});
	}
	sessions.clear();
}
