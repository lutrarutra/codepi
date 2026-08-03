import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { createVscodeTools } from "./tools/index";
import { disposeDiagnosticsCache } from "./tools/diagnostics";
import { installAutoVerify } from "./auto-verify";
import { SessionTreeProvider, SessionTreeItem } from "./views/session-tree";
import { ReviewManager, pendingLineCounts } from "./review/review-manager";
import {
	ReviewDecorations,
	openProposalDiff,
	type ReviewActionHandlers,
} from "./review/decorations";
import type { EditProposalSummary } from "./review/types";
import type {
	AgentSessionRuntime,
	InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import { stripPiFromTitle, WebviewPty } from "./tui/webview-pty";
import {
	classifyAsUrl,
	escapeGlob,
	normalizeSearchText,
	resolveTerminalFilePath,
	splitLineColumn,
	type CodePiOpenLinkPayload,
} from "./tui/links";
import { SettingsViewProvider } from "./settings-view";
import {
	ensureRuntimeTools,
	detectLegacyConfig,
	getCanonicalAgentDir,
	getCodePiSessionDir,
	getSettingsPath,
	migrateLegacyCodePiStorage,
	readAutoVerifyMode,
	readJsonFile,
	readTerminalPrefs,
	seedAskModeAllowedToolsIfMissing,
	setAgentDir,
	isBashExtensionEnabled,
	DEFAULT_AUTO_VERIFY_MODE,
} from "./pi-store";
import {
	applyImplicitBundledTheme,
	buildCurrentPiRuntimeResourcePaths,
	buildPiResourceLoaderOptions,
	buildPiRuntimeResourcePaths,
	installImplicitBundledThemeReload,
} from "./pi-runtime-config";
// ── Types ────────────────────────────────────────────────────

interface SessionState {
	panel: vscode.WebviewPanel;
	pty: WebviewPty;
	runtime: AgentSessionRuntime;
	tui: InteractiveMode;
	sessionManager: any; // SessionManager from PI SDK
	isBackendReady: boolean;
	isBusy: boolean;
	sessionId: string;
	sessionPath: string;
	disposables: vscode.Disposable[];
	review: ReviewManager;
	/** proposalIds already mirrored to the TUI filechanges tracker. */
	fcSeenEntries: Set<string>;
	/** last session branch head id seen by the filechanges sync poll. */
	fcLastHead: string | undefined;
}

// ── Globals ──────────────────────────────────────────────────

// sessionId → live TUI session. Each session runs its own InteractiveMode
// inside a webview panel hosting xterm.js (editor area).
const sessions = new Map<string, SessionState>();
let extensionContext: vscode.ExtensionContext | undefined;
let codePiSessionDir: string | undefined;
let treeProvider: SessionTreeProvider | undefined;

// Shared editor decorations + CodeLens for ALL sessions' pending edits.
let reviewDecorations: ReviewDecorations | undefined;

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

function getCodePiSessionDirForRuntime(): string {
	if (!codePiSessionDir) {
		throw new Error("CodePi session storage is not initialized");
	}
	return codePiSessionDir;
}

const LEGACY_MIGRATION_PROMPTED_KEY = "codepi.legacyMigrationPrompted.v1";

async function offerLegacyMigration(
	context: vscode.ExtensionContext,
	canonicalAgentDir: string,
	codePiSessionDir: string,
): Promise<void> {
	if (context.globalState.get<boolean>(LEGACY_MIGRATION_PROMPTED_KEY)) return;

	const legacyAgentDir = path.join(context.globalStorageUri.fsPath, "agent");
	const legacySessionDir = path.join(legacyAgentDir, "sessions");
	const detected = detectLegacyConfig(legacyAgentDir);
	const hasMissingConfig = Boolean(
		detected &&
			(["settings", "auth", "models"] as const).some(
				(file) =>
					detected[file] &&
					!fs.existsSync(path.join(canonicalAgentDir, `${file}.json`)),
			),
	);
	const hasLegacySessions =
		fs.existsSync(legacySessionDir) &&
		fs.statSync(legacySessionDir).isDirectory() &&
		fs.readdirSync(legacySessionDir).length > 0 &&
		(!fs.existsSync(codePiSessionDir) ||
			fs.readdirSync(codePiSessionDir).length === 0);
	if (!hasMissingConfig && !hasLegacySessions) {
		await context.globalState.update(LEGACY_MIGRATION_PROMPTED_KEY, true);
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		"CodePi found legacy storage/configuration or sessions from an older CodePi version. Migrate missing files from the old CodePi storage into this computer's ~/.pi/agent? CodePi sessions move only within this computer's VS Code storage; remote hosts are not affected, and ~/.pi/agent/sessions is never copied.",
		"Migrate now",
		"Not now",
	);
	if (choice !== "Migrate now") return;

	try {
		const result = migrateLegacyCodePiStorage(
			legacyAgentDir,
			canonicalAgentDir,
			legacySessionDir,
			codePiSessionDir,
		);
		await context.globalState.update(LEGACY_MIGRATION_PROMPTED_KEY, true);
		const copied = [
			...result.copiedFiles,
			...result.copiedSessions.map((name) => `sessions/${name}`),
		];
		vscode.window.showInformationMessage(
			copied.length > 0
				? `CodePi migrated ${copied.join(", ")} from its legacy storage.`
				: "CodePi found no additional legacy files to migrate.",
		);
	} catch (error) {
		vscode.window.showErrorMessage(
			`CodePi could not migrate legacy storage: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

// ── Activation ───────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
	extensionContext = context;

	// codepi-bash (bundled pi extension) runs in this same process, but jiti's
	// ESM loader cannot resolve the "vscode" module — only the extension host's
	// own require/import paths are intercepted. Hand the API over via the
	// documented bridge (globalThis is shared with the in-process pi SDK and
	// its jiti-loaded extensions). getVscode() in codepi-bash reads this first.
	(globalThis as Record<string, unknown>).__codepiBashHost = { vscode };

	// pi's InteractiveMode ends every quit path (/quit, Ctrl+C/Ctrl+D, signals)
	// with process.exit(). VS Code's extension host already neutralizes
	// process.exit (patchProcess in extensionHostProcess.ts — it just logs
	// "prevented"), so the host survives but our TUI tab is left open with a
	// dead session behind it. Intercept instead: when pi asks to exit, close
	// the session panel(s) — /quit or closing the tab are the only sanctioned
	// ways to end a session. Per-session targeting uses WebviewPty.quitting
	// (set when pi's shutdown calls drainInput).
	const baseExit = process.exit.bind(process);
	(process as unknown as { exit: (code?: number) => never }).exit = ((
		code?: number,
	) => {
		if (sessions.size === 0) {
			// Not a CodePi shutdown — let VS Code's own patch handle it.
			baseExit(code);
			return;
		}
		const quitting = [...sessions.values()].filter(
			(s) => (s.pty as WebviewPty).quitting,
		);
		const targets = quitting.length > 0 ? quitting : [...sessions.values()];
		console.log(
			`[CodePi] pi requested process.exit(${code}) — closing ${targets.length} TUI panel(s)`,
		);
		for (const s of targets) {
			if (sessions.has(s.sessionId)) cleanupSession(s.sessionId);
		}
		// Swallow: pi's shutdown() returns normally and the host keeps running.
	}) as (code?: number) => never;

	// The embedded TUI renders in a truecolor-capable webview xterm. pi's
	// terminal capability detection (pi-tui detectCapabilities) only emits
	// truecolor when it can identify a truecolor terminal — otherwise every
	// theme hex color gets quantized to the 256-color palette, which makes
	// the dark message/tool backgrounds render as near-black. Identify the
	// "terminal" as VS Code (TERM_PROGRAM=vscode ⇒ trueColor + OSC8 links)
	// and also set COLORTERM as a belt-and-suspenders; getCapabilities()
	// caches, so this must run before ANY pi SDK call.
	process.env.TERM_PROGRAM = "vscode";
	process.env.COLORTERM = "truecolor";

	// Point pi's config and user-resource storage at the executing computer's
	// canonical ~/.pi/agent. Must run before any SDK call — pi reads
	// PI_CODING_AGENT_DIR at call time.
	const agentDir = getCanonicalAgentDir();
	setAgentDir(agentDir);
	fs.mkdirSync(agentDir, { recursive: true });

	// Copilot-style pending-edit dot on tabs/Explorer for files awaiting review.
	registerPendingReviewDots(extensionContext);

	// Seed codepi.modes.ask.allowedTools with the default read-only allowlist
	// when the block is missing, so the user can find and edit it (the
	// codepi-modes extension falls back to the same defaults at runtime).
	try {
		seedAskModeAllowedToolsIfMissing(getSettingsPath());
	} catch {
		/* malformed settings — leave unseeded, extension fallback applies */
	}

	// Keep CodePi conversations in VS Code storage, separate from Pi's
	// canonical ~/.pi/agent resources and sessions.
	codePiSessionDir = getCodePiSessionDir(context.globalStorageUri.fsPath);
	fs.mkdirSync(codePiSessionDir, { recursive: true });
	await offerLegacyMigration(context, agentDir, codePiSessionDir);

	// Register session tree provider
	treeProvider = new SessionTreeProvider(codePiSessionDir);
	const treeView = vscode.window.createTreeView("codepi.sessionsList", {
		treeDataProvider: treeProvider,
		showCollapseAll: false,
	});
	context.subscriptions.push(treeView);

	// Restore TUI tabs that were open before a window reload. VS Code persists
	// open webview panels and revives them here; the webview content persisted
	// its session id via vscode.setState (see terminal.ts), which arrives as
	// `state` below.
	context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer("codepi-tui", {
			deserializeWebviewPanel: async (panel, state) => {
				const sessionId = (state as { sessionId?: string } | undefined)
					?.sessionId;
				if (!sessionId) {
					panel.dispose();
					return;
				}
				try {
					const sessionPath = await findSessionPathById(sessionId);
					if (!sessionPath) {
						// Session deleted since the reload — drop the orphaned tab.
						panel.dispose();
						return;
					}
					const pi = await getPi();
					const sessionManager = pi.SessionManager.open(
						sessionPath,
						getCodePiSessionDirForRuntime(),
						getWorkspaceRoot(),
					);
					if (sessionManager.getSessionId() !== sessionId) {
						panel.dispose();
						return;
					}
					await setupSessionPanel(
						panel,
						sessionManager,
						sessionId,
						sessionPath,
					);
				} catch (err) {
					console.error(
						"[CodePi] Failed to restore session",
						sessionId,
						":",
						err,
					);
					panel.dispose();
				}
			},
		}),
	);

	// Settings sidebar tab (toggled with the Sessions tree via codepi.sidebarTab)
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			SettingsViewProvider.viewType,
			new SettingsViewProvider(
				context.extensionUri,
				() => {
					// Settings and bundled-resource toggles apply to new sessions.
				},
				getCanonicalAgentDir(),
				getCodePiSessionDirForRuntime(),
			),
			{ webviewOptions: { retainContextWhenHidden: true } },
		),
		vscode.commands.registerCommand("codepi.openSettingsTab", () =>
			vscode.commands.executeCommand(
				"setContext",
				"codepi.sidebarTab",
				"settings",
			),
		),
		vscode.commands.registerCommand("codepi.openSessionsTab", () =>
			vscode.commands.executeCommand(
				"setContext",
				"codepi.sidebarTab",
				"sessions",
			),
		),
	);
	await vscode.commands.executeCommand(
		"setContext",
		"codepi.sidebarTab",
		"sessions",
	);

	// ── Edit review infrastructure ─────────────────────────────
	const reviewHandlers: ReviewActionHandlers = {
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
	reviewDecorations = new ReviewDecorations();
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
		vscode.commands.registerCommand("codepi.acceptFile", (proposalId: string) =>
			reviewHandlers.acceptFile(proposalId),
		),
		vscode.commands.registerCommand("codepi.rejectFile", (proposalId: string) =>
			reviewHandlers.rejectFile(proposalId),
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
		vscode.commands.registerCommand("codepi.openDiff", (proposalId: string) =>
			reviewHandlers.openDiff(proposalId),
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
			async (arg?: string | SessionTreeItem, opts?: { fromTree?: boolean }) => {
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

				// Close any panel hosting this session
				const sessionPath = item.session.path;
				for (const [, state] of sessions) {
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

/**
 * Sync the editor review state with the TUI filechanges tracker.
 *
 * The filechanges extension appends `filechanges:resolved` custom session
 * entries when the user runs /filechanges-accept or /filechanges-decline in
 * the TUI. This poll picks them up and resolves the matching review proposals
 * so editor decorations / the review bar clear in step with the TUI.
 */
async function pollFileChangesSync(state: SessionState): Promise<void> {
	if (!state.sessionManager) return;
	let branch: any[];
	try {
		branch = state.sessionManager.getBranch();
	} catch {
		return;
	}
	if (branch.length === 0) return;
	const headId = branch[branch.length - 1].id;
	if (headId === state.fcLastHead) return;
	state.fcLastHead = headId;

	let changed = false;
	for (const entry of branch) {
		if (
			entry.type !== "custom" ||
			entry.customType !== "filechanges:resolved"
		) {
			continue;
		}
		if (state.fcSeenEntries.has(entry.id)) continue;
		state.fcSeenEntries.add(entry.id);
		const data = entry.data as
			| { paths?: string[]; reason?: "accept" | "decline" }
			| undefined;
		if (!data?.paths) continue;
		for (const p of data.paths) {
			const proposal = state.review.getProposalByFile(
				resolveReviewUri(p).toString(),
			);
			if (!proposal) continue;
			changed = true;
			await state.review.resolveFile(
				proposal.proposalId,
				data.reason === "decline" ? "rejected" : "accepted",
			);
		}
	}
	if (changed) {
		updateReviewStatusBar();
	}
}

/** Relativize a proposal uri for the TUI tracker (its cwd is the workspace). */
function toRelPath(uriStr: string): string {
	try {
		const uri = vscode.Uri.parse(uriStr);
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (folder) {
			return (
				path.relative(folder.uri.fsPath, uri.fsPath) ||
				path.basename(uri.fsPath)
			);
		}
		return uri.fsPath;
	} catch {
		return uriStr;
	}
}

/** Resolve a tracker path (relative to the workspace, or absolute) to a uri. */
function resolveReviewUri(p: string): vscode.Uri {
	if (path.isAbsolute(p)) return vscode.Uri.file(p);
	const ws = vscode.workspace.workspaceFolders?.[0];
	if (ws) return vscode.Uri.joinPath(ws.uri, p);
	return vscode.Uri.file(p);
}

/** Create a brand-new session and open its TUI terminal tab. */
async function createNewSession(): Promise<void> {
	const pi = await getPi();
	const workspaceRoot = getWorkspaceRoot();

	const sessionManager = pi.SessionManager.create(
		workspaceRoot,
		getCodePiSessionDirForRuntime(),
	);
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
		getCodePiSessionDirForRuntime(),
		workspaceRoot,
	);
	const sessionId = sessionManager.getSessionId();

	const existing = sessions.get(sessionId);
	if (existing) {
		existing.panel.reveal();
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
		const all: any[] = await pi.SessionManager.list(
			workspaceRoot,
			getCodePiSessionDirForRuntime(),
		);
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

/**
 * Resolve a session id to its JSONL file path, used when restoring a TUI tab
 * after a window reload. Prefers sessions under the current workspace root;
 * falls back to a full scan (covers sessions from other folders).
 */
async function findSessionPathById(
	sessionId: string,
): Promise<string | undefined> {
	try {
		const pi = await getPi();
		const byCwd: any[] = await pi.SessionManager.list(
			getWorkspaceRoot(),
			getCodePiSessionDirForRuntime(),
		);
		const hit = byCwd.find((s: any) => s.id === sessionId);
		if (hit) return hit.path;
		const all: any[] = await pi.SessionManager.listAll(
			getCodePiSessionDirForRuntime(),
		);
		return all.find((s: any) => s.id === sessionId)?.path;
	} catch {
		return undefined;
	}
}

// ── Session Setup ────────────────────────────────────────────

/**
 * Open a Ctrl+clicked terminal link (VS Code built-in terminal behavior):
 * URLs go to the default browser via openExternal, file paths open in the
 * editor at the (optional) line:column — mirroring TerminalUrlLinkOpener and
 * TerminalLocalFileLinkOpener from the vscode-main submodule.
 */
async function openTerminalLink(link: CodePiOpenLinkPayload): Promise<void> {
	try {
		const raw = (link.text ?? "").trim();
		if (!raw) return;

		const workspaceRoot = getWorkspaceRoot();
		const folders =
			vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];

		// OSC 8 hyperlinks carry an explicit target.
		if (link.kind === "url" && link.url) {
			await openUrlOrFile(link.url);
			return;
		}
		if (link.kind === "file" && link.path) {
			const resolved = resolveTerminalFilePath(
				link.path,
				workspaceRoot,
				folders,
			);
			if (resolved) {
				await openTerminalFile(resolved, link.line, link.column);
				return;
			}
		}

		// Word link: VS Code decides what it is on activation (URL → browser,
		// existing file → editor, directory → explorer, otherwise → search).
		const url = classifyAsUrl(raw);
		if (url) {
			await openUrlOrFile(raw);
			return;
		}

		const normalized = normalizeSearchText(raw);
		const { path: p, line, column } = splitLineColumn(normalized);
		if (p) {
			const resolved = resolveTerminalFilePath(p, workspaceRoot, folders);
			if (resolved) {
				await openTerminalFile(resolved, line, column);
				return;
			}
			// Fallback like TerminalSearchLinkOpener: search the workspace when
			// the exact path doesn't exist on disk.
			if (await searchAndOpen(p, raw, line, column)) {
				return;
			}
		}

		// Nothing matched: report the failure (error reports are allowed;
		// success notifications are not).
		void vscode.window.showWarningMessage(
			`CodePi: no file, folder or URL matches “${raw}”`,
		);
	} catch (err) {
		void vscode.window.showErrorMessage(
			`CodePi: could not open link — ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/** Open a URL externally, or a file:// target in the editor. */
async function openUrlOrFile(urlText: string): Promise<void> {
	const uri = vscode.Uri.parse(urlText);
	if (uri.scheme === "file") {
		await openTerminalFile(uri.fsPath);
		return;
	}
	await vscode.env.openExternal(uri);
}

/**
 * Workspace search fallback for a word that isn't an existing path: open the
 * single exact match directly (VS Code's _getExactMatch), otherwise open the
 * Quick Open file picker (Ctrl+P) pre-filled with the word — the on-top menu
 * VS Code's terminal word links use (quickAccess), NOT the sidebar search.
 */
async function searchAndOpen(
	pathText: string,
	query: string,
	line?: number,
	column?: number,
): Promise<boolean> {
	const glob = escapeGlob(pathText);

	// Exact relative-path match.
	const exact = await vscode.workspace.findFiles(
		`**/${glob}`,
		"**/node_modules/**",
		5,
	);
	if (exact.length === 1) {
		await openTerminalFile(exact[0].fsPath, line, column);
		return true;
	}

	// Filename contains the word (quick access-style matching).
	const found = await vscode.workspace.findFiles(
		`**/*${glob}*`,
		"**/node_modules/**",
		10,
	);
	if (found.length === 1) {
		await openTerminalFile(found[0].fsPath, line, column);
		return true;
	}

	// Open the Ctrl+P file picker pre-filled with the word; its own fuzzy
	// file search lists any matches.
	await vscode.commands.executeCommand(
		"workbench.action.quickOpen",
		query || pathText,
	);
	return true;
}

/** Open a local file (or reveal a folder) at the optional line:column. */
async function openTerminalFile(
	filePath: string,
	line?: number,
	column?: number,
): Promise<void> {
	const uri = vscode.Uri.file(filePath);
	if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
		await vscode.commands.executeCommand("revealInExplorer", uri);
		return;
	}
	const selection =
		typeof line === "number"
			? new vscode.Range(
					Math.max(line, 1) - 1,
					Math.max(column ?? 1, 1) - 1,
					Math.max(line, 1) - 1,
					Math.max(column ?? 1, 1) - 1,
				)
			: undefined;
	const doc = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(doc, {
		preview: false,
		selection,
	});
}

/** Tab title for a session: the session name, else the first user message. */
function computeSessionTitle(sessionManager: any): string {
	const entries = sessionManager.getEntries();
	const sessionName = sessionManager.getSessionName?.();
	const firstUserEntry = entries?.find(
		(e: any) => e.type === "message" && e.message?.role === "user",
	);
	const titleText = stripPiFromTitle(
		sessionName || firstUserEntry?.message?.content?.[0]?.text || "PI",
	);
	return titleText.length > 50 ? titleText.slice(0, 50) + "…" : titleText;
}

/**
 * Create the VS Code terminal (editor area) hosting a session's TUI and run
 * the in-process InteractiveMode inside it.
 */
async function startTuiSession(
	sessionManager: any,
	sessionId: string,
	sessionPath: string,
): Promise<void> {
	const extensionUri = extensionContext?.extensionUri;
	if (!extensionUri) {
		throw new Error("CodePi not activated");
	}

	const panel = vscode.window.createWebviewPanel(
		"codepi-tui",
		computeSessionTitle(sessionManager),
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [
				vscode.Uri.joinPath(extensionUri, "webview-ui", "dist"),
				// Bundled icon font (powerline glyphs) for the TUI footer.
				vscode.Uri.joinPath(extensionUri, "media"),
			],
		},
	);
	await setupSessionPanel(panel, sessionManager, sessionId, sessionPath);
}

/**
 * Wire a session's TUI into an existing webview panel: review manager, pty,
 * message handlers, lifecycle, and (once xterm is ready) the in-process
 * backend. Shared by freshly-created panels (startTuiSession) and panels
 * restored across a window reload (registerWebviewPanelSerializer).
 */
async function setupSessionPanel(
	panel: vscode.WebviewPanel,
	sessionManager: any,
	sessionId: string,
	sessionPath: string,
): Promise<void> {
	// A restored panel must not duplicate a session that is already live.
	if (sessions.has(sessionId)) {
		sessions.get(sessionId)!.panel.reveal();
		panel.dispose();
		return;
	}

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
							// Mirror the review state to the TUI filechanges tracker on
							// every change (proposal created, hunk accepted/rejected).
							// The entry carries the REMAINING pending counts so the
							// widget's line counter counts down to zero, at which point
							// the tracker drops the file.
							if (proposal) {
								try {
									const pending = pendingLineCounts(proposal);
									state.sessionManager?.appendCustomEntry(
										"codepi:review_resolved",
										{
											path: toRelPath(proposal.uri),
											status: proposal.status,
											pendingHunks: pending.pendingHunks,
											pendingAdded: pending.added,
											pendingRemoved: pending.removed,
										},
									);
								} catch {
									/* entry logging is best-effort */
								}
							}
						}
					}
					updateReviewStatusBar();
					syncPendingReviewDots();
				}
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

	// Initial terminal name: session name or the first user message. A
	// restored panel keeps its persisted tab title; overwrite with the
	// current one (also strips the π letter pi's APP_TITLE injects).
	const initialTitle = computeSessionTitle(sessionManager);
	panel.title = initialTitle;

	// `extensionUri` is resolved from the module-level activation context.
	const extensionUri = extensionContext?.extensionUri;
	if (!extensionUri) {
		throw new Error("CodePi not activated");
	}

	// Restore/populate the webview content. For a fresh panel this is the
	// initial load; for a reload-restored panel VS Code hands back an empty
	// webview that must be re-populated here.
	panel.webview.html = buildTerminalHtml(
		extensionUri,
		panel.webview,
		sessionId,
	);

	// Messages posted before the webview finishes loading are dropped by VS
	// Code — anything config-like is sent in response to `tuiReady` below.

	// Progress/icon bridge — filled once `state` exists (constructor runs first).
	let updateStatusIcon: (busy: boolean) => void = () => {};

	const pty = new WebviewPty(
		panel.webview,
		initialTitle,
		() => cleanupSession(sessionId),
		(title) => {
			panel.title = title;
		},
		(busy) => updateStatusIcon(busy),
	);

	const state: SessionState = {
		panel,
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
		fcSeenEntries: new Set(),
		fcLastHead: undefined,
	};
	sessions.set(sessionId, state);

	// Tab indicator: green dot (idle) / yellow dot (generating) / red (error).
	setPanelIcon(panel, "idle");
	updateStatusIcon = (busy) => setPanelIcon(panel, busy ? "busy" : "idle");

	// Webview messages: terminal input / resize / ready.
	panel.webview.onDidReceiveMessage(
		(msg) => {
			switch (msg.command) {
				case "tuiInput":
					pty.handleInput(msg.data);
					break;
				case "tuiResize":
					console.log("[CodePi-tui] tuiResize", msg.cols, "x", msg.rows);
					pty.setDimensions(msg.cols, msg.rows);
					break;
				case "tuiReady":
					pty.setDimensions(msg.cols, msg.rows);
					pty.markReady();
					break;
				case "tuiFontStatus":
					console.log(
						`[CodePi-tui] terminal font loaded: ${msg.ok === true ? "yes" : "NO — powerline branch icon will be tofu"}`,
					);
					break;
				case "tuiClipboardRead":
					// Webview clipboard fallback: navigator.clipboard is
					// unavailable or rejected, so read via the extension host.
					void vscode.env.clipboard.readText().then(
						(text) => {
							try {
								void panel.webview.postMessage({
									command: "tuiClipboardData",
									text,
								});
							} catch {
								/* webview disposed */
							}
						},
						() => {
							try {
								void panel.webview.postMessage({
									command: "tuiClipboardData",
									text: "",
								});
							} catch {
								/* webview disposed */
							}
						},
					);
					break;
				case "tuiClipboardWrite":
					void vscode.env.clipboard.writeText(String(msg.text ?? ""));
					break;
				case "codepi:openLink":
					void openTerminalLink(msg.link as CodePiOpenLinkPayload);
					break;
				case "tuiError":
					void vscode.window.showErrorMessage(
						`CodePi terminal error: ${String(msg.message ?? "unknown")}`,
					);
					break;
			}
		},
		undefined,
		state.disposables,
	);

	// Clean up session state when its webview panel is closed.
	panel.onDidDispose(
		() => {
			cleanupSession(sessionId);
		},
		undefined,
		state.disposables,
	);

	// Poll the session branch for filechanges:resolved entries (written by the
	// TUI's /filechanges accept/decline) so editor review decorations stay in
	// step with the TUI tracker.
	const fcPollTimer = setInterval(() => {
		void pollFileChangesSync(state);
	}, 1000);
	state.disposables.push({ dispose: () => clearInterval(fcPollTimer) });

	// Start the backend once the webview has initialized xterm (real size known);
	// the pty buffers any output that arrives before that. The webview's
	// loading overlay (PI logo + dots) covers the gap; startTuiBackend
	// dismisses it once the TUI pipeline is live.
	void (async () => {
		await pty.waitForReady();
		await startTuiBackend(state);
	})().catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		setPanelIcon(panel, "error");
		cleanupSession(sessionId);
		void vscode.window.showErrorMessage(`CodePi TUI backend error: ${msg}`);
		console.error(
			"[CodePi] TUI backend error for session",
			sessionId,
			":",
			err,
		);
	});
}

function cleanupSession(sessionId: string): void {
	const state = sessions.get(sessionId);
	if (!state) return;

	sessions.delete(sessionId);
	// Pending-edit tab dots must drop for this session's files.
	syncPendingReviewDots();

	// Close the hosting panel (no-op if already disposed — cleanup may be
	// triggered from the panel's own onDidDispose).
	try {
		state.panel.dispose();
	} catch {
		/* ignore */
	}

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
	const agentDir = getCanonicalAgentDir();

	// Make fd/rg available in <agentDir>/bin BEFORE the TUI's init() looks
	// for them. The canonical agent directory is shared with the Pi CLI.
	await ensureRuntimeTools(agentDir);

	const extensionUri = extensionContext?.extensionUri;
	const extensionDir = extensionUri
		? vscode.Uri.joinPath(extensionUri, "resources", "extensions")
		: undefined;

	// Build all resource paths inside the runtime factory. The SDK may invoke this
	// factory for more than one new session; each session must see current settings
	// and bundled-resource toggles rather than activation-time snapshots.
	const createRuntime: any = async (opts: any) => {
		const settingsManager = pi.SettingsManager.create(opts.cwd, agentDir);
		const resourcePaths = buildCurrentPiRuntimeResourcePaths(
			extensionDir?.fsPath ?? "",
			agentDir,
			() => readJsonFile(getSettingsPath()) ?? {},
		);
		const bundledExtensions = resourcePaths.bundledExtensionPaths.filter((p) =>
			fs.existsSync(p),
		);
		const bundledThemes = resourcePaths.bundledThemePaths.filter((p) =>
			fs.existsSync(p),
		);
		if (fs.existsSync(resourcePaths.rpivTodoPath)) {
			bundledExtensions.push(resourcePaths.rpivTodoPath);
		} else {
			console.warn(
				"[CodePi] rpiv-todo extension not found at",
				resourcePaths.rpivTodoPath,
				"— no todo tool will be available to the agent.",
			);
		}
		const bundledThemeEnabled = bundledThemes.length > 0;
		const loaderOptions = buildPiResourceLoaderOptions(opts.cwd, agentDir, {
			...resourcePaths,
			bundledExtensionPaths: bundledExtensions,
			bundledThemePaths: bundledThemes,
		});
		const loader = new pi.DefaultResourceLoader({
			...loaderOptions,
			settingsManager,
			extensionsOverride: (base: any) => {
				const bundled = new Set(bundledExtensions);
				return {
					...base,
					extensions: [
						...base.extensions.filter(
							(extension: any) =>
								!bundled.has(extension.resolvedPath ?? extension.path),
						),
						...base.extensions.filter((extension: any) =>
							bundled.has(extension.resolvedPath ?? extension.path),
						),
					],
				};
			},
		});
		await loader.reload();
		applyImplicitBundledTheme(settingsManager, bundledThemeEnabled);
		// CodePi's workspace tools, plus pi's STOCK bash tool when the codepi-bash
		// bundled extension is disabled in Settings (spawn-based, no approval
		// layer — the user explicitly opted out). When codepi-bash is enabled the
		// extension itself registers `bash` (VS Code terminal + approval modes).
		const customTools = createVscodeTools(state.review);
		const settings = readJsonFile(getSettingsPath()) ?? {};
		if (!isBashExtensionEnabled(settings)) {
			(customTools as Array<unknown>).push(pi.createBashToolDefinition(opts.cwd));
		}

		const result = await pi.createAgentSession({
			resourceLoader: loader,
			settingsManager,
			cwd: opts.cwd,
			agentDir,
			noTools: "builtin",
			customTools,
			sessionManager: opts.sessionManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		installImplicitBundledThemeReload(result.session, settingsManager, () =>
			buildPiRuntimeResourcePaths(
				extensionDir?.fsPath ?? "",
				agentDir,
				readJsonFile(getSettingsPath()) ?? {},
			).bundledThemePaths.some((p) => fs.existsSync(p)),
		);
		return result;
	};

	const runtime = await pi.createAgentSessionRuntime(createRuntime, {
		cwd: workspaceRoot,
		agentDir,
		sessionManager: state.sessionManager,
	});
	state.runtime = runtime;

	// Auto-verify: after a turn that edited files, lint exactly those files
	// and feed the findings back to the model (mode from codepi.autoVerify).
	const autoVerify = installAutoVerify(runtime.session, {
		getMode: () => {
			try {
				return readAutoVerifyMode(readJsonFile(getSettingsPath()) ?? {});
			} catch {
				return DEFAULT_AUTO_VERIFY_MODE;
			}
		},
	});
	state.disposables.push({ dispose: autoVerify.dispose });

	state.tui = new pi.InteractiveMode(runtime, {
		terminal: state.pty,
		verbose: true,
	});

	state.isBackendReady = true;
	state.isBusy = true;
	treeProvider?.refresh();

	// Dismiss the webview's loading overlay (PI logo + dots). The TUI's first
	// render lands right after run() below, so the fade covers the gap.
	try {
		void state.panel.webview.postMessage({ command: "tuiLoadingDone" });
	} catch {
		/* webview disposed */
	}

	// run() resolves when the TUI exits (e.g. /quit) → close the panel tab.
	void state.tui
		.run()
		.then(() => {
			state.panel.dispose();
		})
		.catch((err: Error) => {
			console.error("[CodePi] TUI exited with error:", err);
			void vscode.window.showErrorMessage(
				`CodePi TUI error: ${err.message || String(err)}`,
			);
		});
}

// ── Pending-edit tab dots (Copilot-style) ────────────────────

// FileDecorationProvider that marks files with pending review edits with the
// same "squared-dot" indicator Copilot uses: a colored dot badge on the editor
// tab (and Explorer). The color matches VS Code's chat.editedFileForeground
// (the color Copilot uses for edited files). The dot disappears once every
// hunk of the proposal is accepted or declined.
let pendingReviewDotsEmitter:
	| vscode.EventEmitter<vscode.Uri | vscode.Uri[]>
	| undefined;
let pendingReviewUris = new Set<string>(); // uri.toString() with pending hunks

function registerPendingReviewDots(context: vscode.ExtensionContext): void {
	pendingReviewDotsEmitter = new vscode.EventEmitter<
		vscode.Uri | vscode.Uri[]
	>();
	const provider: vscode.FileDecorationProvider = {
		onDidChangeFileDecorations: pendingReviewDotsEmitter.event,
		provideFileDecoration(uri: vscode.Uri) {
			if (!pendingReviewUris.has(uri.toString())) return undefined;
			return {
				badge: "●",
				color: new vscode.ThemeColor("chat.editedFileForeground"),
				tooltip: "CodePi: edits pending review",
			};
		},
	};
	context.subscriptions.push(
		vscode.window.registerFileDecorationProvider(provider),
		pendingReviewDotsEmitter,
	);
}

/** Recompute which files carry a pending-edit dot and notify VS Code. */
function syncPendingReviewDots(): void {
	if (!pendingReviewDotsEmitter) return;
	const next = new Set<string>();
	for (const [, st] of sessions) {
		for (const p of st.review.allProposals()) {
			if (p.status !== "pending") continue;
			if (st.review.counts(p).pending === 0) continue;
			next.add(p.uri);
		}
	}
	const changed: vscode.Uri[] = [];
	for (const u of next) {
		if (!pendingReviewUris.has(u)) changed.push(vscode.Uri.parse(u));
	}
	for (const u of pendingReviewUris) {
		if (!next.has(u)) changed.push(vscode.Uri.parse(u));
	}
	if (changed.length === 0) return;
	pendingReviewUris = next;
	pendingReviewDotsEmitter.fire(changed);
}

function getWorkspaceRoot(): string {
	const ws = vscode.workspace.workspaceFolders?.[0];
	return ws?.uri.fsPath ?? os.homedir();
}

// ── Panel Status Icon ────────────────────────────────────────

/**
 * Set the tab icon to a colored status dot (no logo):
 * green = idle, yellow = generating, red = backend error.
 */
function setPanelIcon(
	panel: vscode.WebviewPanel,
	mode: "idle" | "busy" | "error",
): void {
	const uri = vscode.Uri.joinPath(
		extensionContext!.extensionUri,
		"media",
		`pi-icon-${mode}.svg`,
	);
	panel.iconPath = { light: uri, dark: uri };
}

// ── Terminal Webview HTML ────────────────────────────────────

/**
 * HTML shell for the TUI webview. Loads the xterm.js bundle (dist/terminal.js)
 * with a nonce against the CSP; xterm.css is embedded in the bundle.
 *
 * The session id is embedded as a meta tag so the webview content can persist
 * it via `vscode.setState` — VS Code keeps that state with the panel and hands
 * it back to the registered serializer on a window reload, which is how the
 * tab knows which session to restore.
 */
function buildTerminalHtml(
	extensionUri: vscode.Uri,
	webview: vscode.Webview,
	sessionId: string,
): string {
	const distUri = vscode.Uri.joinPath(extensionUri, "webview-ui", "dist");
	const scriptUri = webview.asWebviewUri(
		vscode.Uri.joinPath(distUri, "terminal.js"),
	);
	// Bundled terminal font: Fira Code Nerd Font (SIL OFL 1.1 — license in
	// media/OFL-FiraCodeNerd.txt). One family with both the Fira Code text
	// glyphs and the powerline/nerd symbols (branch U+E0A0 in the TUI footer,
	// separators), shipped as woff2. The files live in media/ AND are copied
	// into webview-ui/dist/ by the build (scripts/copy-fonts.mjs) — dist is
	// permanently in the panel's localResourceRoots, so even panels created
	// before media/ was added can fetch the font. The @font-face is only
	// emitted when the configured family actually uses it, so choosing a
	// different font skips the 2 MB download.
	const fontUri = webview.asWebviewUri(
		vscode.Uri.joinPath(distUri, "fira-code-nerd-regular.woff2"),
	);
	const fontBoldUri = webview.asWebviewUri(
		vscode.Uri.joinPath(distUri, "fira-code-nerd-bold.woff2"),
	);
	// Loading-screen logo (media/): gray glyph on dark themes, dark glyph on
	// light themes — the webview <html> carries vscode-dark/vscode-light.
	const logoDarkUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, "media", "pi-icon.svg"),
	);
	const logoLightUri = webview.asWebviewUri(
		vscode.Uri.joinPath(extensionUri, "media", "pi-icon-light.svg"),
	);

	// Terminal font preferences from the user's settings.json (codepi.*).
	// Read fresh on every panel creation so new sessions pick up changes.
	let fontFamily = "FiraCode Nerd Font";
	let fontSize = 14;
	try {
		const prefs = readTerminalPrefs(readJsonFile(getSettingsPath()) ?? {});
		fontFamily = prefs.fontFamily;
		fontSize = prefs.fontSize;
	} catch {
		/* malformed settings — fall back to defaults */
	}
	const useBundledFont =
		fontFamily.toLowerCase().replace(/\s+/g, "").includes("firacode");
	const safeFamily = fontFamily.replace(/"/g, "&quot;");
	const nonce = getNonce();
	const safeSessionId = sessionId.replace(/"/g, "&quot;");
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="codepi-session-id" content="${safeSessionId}" />
  <meta name="codepi-font-family" content="${safeFamily}" />
  <meta name="codepi-font-size" content="${fontSize}" />
  <title>PI</title>
  <style>
${useBundledFont
		? `    /* Bundled terminal font — Fira Code Nerd Font (OFL 1.1). Preloaded
       by terminal.ts so the xterm canvas builds its glyph atlas with the
       real font from the first frame. */
    @font-face {
      font-family: "FiraCode Nerd Font";
      font-display: block;
      font-weight: 400;
      src: url("${fontUri}") format("woff2");
    }
    @font-face {
      font-family: "FiraCode Nerd Font";
      font-display: block;
      font-weight: 700;
      src: url("${fontBoldUri}") format("woff2");
    }
`
		: ""}
    html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; background: var(--vscode-terminal-background, var(--vscode-editor-background, #1e1e1e)); }
    /* Absolute-fill: robust against webview percentage-height quirks. */
    #terminal { position: absolute; top: 0; left: 0; right: 0; bottom: 0; }
    #terminal .xterm { width: 100%; height: 100%; }
    /* xterm.css paints .xterm-viewport #000 and it fills the whole .xterm,
       while the grid canvas only covers whole rows — the leftover strip at
       the bottom would render black. Make it transparent so the painted
       layers behind it (html/body/#terminal/.xterm) show through; the
       background is re-applied from the theme in terminal.ts. */
    .xterm .xterm-viewport { background-color: transparent; }

    /* ── Startup loading overlay ──
       Shown from first paint until the TUI backend is live (extension posts
       tuiLoadingDone; terminal.ts adds .loading-done to fade it out). A
       centered PI logo with a gentle breathing pulse and three staggered
       dots — minimal, theme-aware (vscode-dark/vscode-light classes). */
    #loading {
      position: absolute; inset: 0; z-index: 10;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 18px;
      background: var(--vscode-terminal-background, var(--vscode-editor-background, #1e1e1e));
      opacity: 1; visibility: visible;
      transition: opacity 0.35s ease, visibility 0s linear 0s;
    }
    #loading.loading-done {
      opacity: 0; visibility: hidden;
      pointer-events: none;
      transition: opacity 0.35s ease, visibility 0s linear 0.35s;
    }
    .loading-logo {
      width: 56px; height: 56px;
      animation: codepi-breathe 1.8s ease-in-out infinite;
    }
    html.vscode-light .loading-logo[data-theme="dark"] { display: none; }
    html:not(.vscode-light) .loading-logo[data-theme="light"] { display: none; }
    .loading-dots { display: flex; gap: 7px; }
    .loading-dots span {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--vscode-terminal-foreground, #cccccc);
      animation: codepi-dot 1.2s ease-in-out infinite;
    }
    .loading-dots span:nth-child(2) { animation-delay: 0.15s; }
    .loading-dots span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes codepi-breathe {
      0%, 100% { opacity: 0.55; transform: scale(0.96); }
      50% { opacity: 1; transform: scale(1); }
    }
    @keyframes codepi-dot {
      0%, 100% { opacity: 0.2; transform: translateY(0); }
      50% { opacity: 1; transform: translateY(-4px); }
    }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <div id="loading" role="status" aria-label="Starting CodePi">
    <img class="loading-logo" data-theme="dark" src="${logoDarkUri}" alt="PI" />
    <img class="loading-logo" data-theme="light" src="${logoLightUri}" alt="PI" />
    <div class="loading-dots" aria-hidden="true"><span></span><span></span><span></span></div>
  </div>
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

// ── Deactivation ─────────────────────────────────────────────

export function deactivate() {
	disposeDiagnosticsCache();
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
