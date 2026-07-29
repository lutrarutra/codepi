import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import { PiEventRelay } from "./bridge/relay";
import {
	vscodeTools,
	setWriteMode,
	resolveQuestion,
	getTodoList,
	setTodoList,
	clearTodoList,
	reconstructFromEntries,
} from "./tools/index";
import { SessionTreeProvider, SessionTreeItem } from "./views/session-tree";
import type { WebviewMessage } from "./bridge/protocol";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

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
}

// ── Globals ──────────────────────────────────────────────────

const panels = new Map<string, PanelState>();
const agentDir = path.join(os.homedir(), ".pi", "agent");
let treeProvider: SessionTreeProvider | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

// Lazy import — pi SDK is ESM-only, must use dynamic import from CJS bundle
let _pi: any;
async function getPi(): Promise<any> {
	if (!_pi) {
		_pi = await import("@earendil-works/pi-coding-agent");
	}
	return _pi;
}

// ── Panel icon helpers ───────────────────────────────────────

function setPanelIcon(
	state: PanelState,
	mode: "idle" | "busy" | "error",
): void {
	const uri = vscode.Uri.joinPath(
		state.extensionUri,
		"media",
		`pi-icon-${mode}.svg`,
	);
	state.panel.iconPath = { light: uri, dark: uri };
}
// ── Activation ───────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	extensionContext = context;
	// Register session tree provider
	treeProvider = new SessionTreeProvider();
	const treeView = vscode.window.createTreeView("codepi.sessionsList", {
		treeDataProvider: treeProvider,
		showCollapseAll: false,
	});
	context.subscriptions.push(treeView);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand("codepi.openPanel", () => {
			createNewSessionPanel(context);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("codepi.newSession", () => {
			createNewSessionPanel(context);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"codepi.openSession",
			async (arg?: string | SessionTreeItem) => {
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
				// Check if this session is already open in a panel
				for (const [, state] of panels) {
					if (state.sessionPath === sessionPath) {
						state.panel.reveal();
						return;
					}
				}
				await openExistingSessionPanel(context, sessionPath);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"codepi.renameSession",
			async (item?: SessionTreeItem) => {
				if (!item) return;
				await treeProvider?.renameSession(item.session.path);
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
	);
}

// ── Panel Creation ───────────────────────────────────────────

async function createNewSessionPanel(
	context: vscode.ExtensionContext,
): Promise<void> {
	clearTodoList();

	const pi = await getPi();
	const workspaceRoot = getWorkspaceRoot();

	const sessionManager = pi.SessionManager.create(workspaceRoot);
	const sessionId = sessionManager.getSessionId();
	const sessionPath = sessionManager.getSessionFile() || "";

	await createChatPanel(context, sessionManager, sessionId, sessionPath, false);
}

async function openExistingSessionPanel(
	context: vscode.ExtensionContext,
	sessionPath: string,
): Promise<void> {
	const pi = await getPi();
	const workspaceRoot = getWorkspaceRoot();

	const sessionManager = pi.SessionManager.open(
		sessionPath,
		undefined,
		workspaceRoot,
	);
	const sessionId = sessionManager.getSessionId();

	await createChatPanel(context, sessionManager, sessionId, sessionPath);
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

async function createChatPanel(
	context: vscode.ExtensionContext,
	sessionManager: any,
	sessionId: string,
	sessionPath: string,
	viewColumn?: vscode.ViewColumn,
): Promise<PanelState> {
	const relay = new PiEventRelay();

	const panel = vscode.window.createWebviewPanel(
		"codepi",
		"PI",
		viewColumn ?? vscode.ViewColumn.Active,
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
	};

	// Set icon: white for empty sessions, green for sessions with history
	const hasMessages = state.sessionManager
		.getEntries()
		.some((e: any) => e.type === "message");
	if (hasMessages) {
		setPanelIcon(state, "idle");
	} else {
		const darkUri = vscode.Uri.joinPath(
			context.extensionUri,
			"media",
			"pi-icon-empty.svg",
		);
		const lightUri = vscode.Uri.joinPath(
			context.extensionUri,
			"media",
			"pi-icon-empty-light.svg",
		);
		state.panel.iconPath = { light: lightUri, dark: darkUri };
	}

	panels.set(sessionId, state);

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
			const vc = panel.viewColumn; // capture before cleanup deletes the state
			cleanupPanel(sessionId, vc ?? undefined);
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

function cleanupPanel(sessionId: string, viewColumn?: vscode.ViewColumn): void {
	const state = panels.get(sessionId);
	if (!state) return;

	const wasBusy = state.isBusy;
	const sessionPath = state.sessionPath;
	const savedSessionManager = state.sessionManager;

	panels.delete(sessionId);
	state.relay.detach();
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
				// Recreate panel in same position — feels like close was prevented
				const ec = extensionContext;
				if (ec) {
					const sid = savedSessionManager.getSessionId();
					await createChatPanel(
						ec,
						savedSessionManager,
						sid,
						sessionPath,
						false,
						viewColumn,
					);
				}
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
		agentDir,
		noExtensions: true,
	});
	await loader.reload();

	const { session } = await pi.createAgentSession({
		resourceLoader: loader,
		cwd: workspaceRoot,
		agentDir,
		noTools: "builtin",
		customTools: vscodeTools,
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

	// Get models
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

	if (session.model) {
		const curProv = String((session.model as any).provider ?? "");
		const curId = String(session.model.id ?? "");
		if (!models.some((m) => m.provider === curProv && m.modelId === curId)) {
			models.unshift({ provider: curProv, modelId: curId });
		}
	}

	state.panel.webview.postMessage({ command: "modelList", models });
	state.panel.webview.postMessage({
		command: "toolsInfo",
		tools: vscodeTools.map((t) => t.name),
	});
	state.panel.webview.postMessage({ command: "modeInfo", mode: "agent" });
	console.log(
		"[CodePi] Sent",
		models.length,
		"models, tools:",
		vscodeTools.map((t) => t.name).join(", "),
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
			// Set tab title from first user message
			const firstUserEntry = entries.find(
				(e: any) => e.type === "message" && e.message?.role === "user",
			);
			if (firstUserEntry) {
				const text = firstUserEntry.message.content?.[0]?.text || "";
				const truncated = text.length > 50 ? text.slice(0, 50) + "…" : text;
				state.panel.title = `PI: ${truncated}`;
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
			const truncated =
				message.text.length > 50
					? message.text.slice(0, 50) + "…"
					: message.text;
			state.panel.title = `PI: ${truncated}`;
		}
		const promptStartTime = Date.now();
		console.log(
			"[CodePi] Sending prompt to agent:",
			message.text.slice(0, 200),
		);
		state.isBusy = true;
		setPanelIcon(state, "busy");
		if (state.session.isStreaming) {
			state.session.steer(message.text).catch((err: Error) => {
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
		state.session.steer(message.text).catch(() => {});
	} else if (message.command === "followUp") {
		state.isBusy = true;
		setPanelIcon(state, "busy");
		state.session.followUp(message.text).catch(() => {});
	} else if (message.command === "setModel") {
		try {
			const registry: any = (state.session as any).modelRegistry;
			if (!registry) return;
			const avail: any[] = registry.getAvailable?.() ?? [];
			const model = avail.find(
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
						(t: any) => t.name !== "write" && t.name !== "todo",
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
						tools: ["read", "write", "list_dir", "find_files", "grep"],
					});
				}
			}
			state.panel.webview.postMessage({ command: "modeInfo", mode: newMode });
			console.log("[CodePi] Mode changed:", oldMode, "→", newMode);
		} catch (err) {
			console.error("[CodePi] setMode error:", err);
		}
	} else if (message.command === "setThinkingLevel") {
		state.session?.setThinkingLevel(message.level as any);
		state.relay.emitModelInfo();
	} else if (message.command === "newSession") {
		// Open a new panel with a fresh session instead of replacing current
		vscode.commands.executeCommand("codepi.newSession");
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
		tools: vscodeTools.map((t) => t.name),
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
