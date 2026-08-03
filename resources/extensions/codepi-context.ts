/**
 * codepi-context — CodePi's editor-context tools.
 *
 * A bundled PI extension that gives the agent a feel for what the user is up
 * to in the editor: active file + cursor, selection text, open editors, recent
 * file switches, git branch + changed files with ±line counts, the SCM commit
 * box, open terminals, and the active debug session — all read live through
 * the VS Code API.
 *
 * Two mechanisms (see docs/superpowers/plans/2026-08-03-codepi-context.md):
 *   1. The host injects a compact `<editor_context>` snapshot into pi's system
 *      prompt at session start (appendSystemPromptOverride in createRuntime).
 *   2. This extension registers the live tools `get_editor_context` (combined
 *      snapshot) and `get_git_diff` (full unified diffs), so the agent can
 *      refresh — the system-prompt snapshot is static for the session.
 *
 * VS Code access: the host hands the API over via the
 * `globalThis.__codepiVscode` bridge (set in extension.ts activate, shared
 * with codepi-bash). createRequire is a second-chance fallback: the extension
 * host intercepts CJS Module._load for "vscode", so a require from the jiti
 * context resolves to the real API.
 *
 * The context COLLECTION logic lives in the host's src/context-snapshot.ts;
 * the host exposes it to this (same-process) extension via
 * `globalThis.__codepiContextCore`. This keeps the extension free of relative
 * imports — structurally identical to codepi-bash — while keeping a single
 * source of truth for snapshot formatting and one shared recent-file cache.
 */
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const VSCODE_BRIDGE_KEY = "__codepiVscode";
const CONTEXT_CORE_KEY = "__codepiContextCore";

// ── VS Code access (mirrors codepi-bash.ts) ─────────────────

export async function getVscode(): Promise<any | undefined> {
	const g = globalThis as Record<string, any>;
	if (g[VSCODE_BRIDGE_KEY]?.vscode) return g[VSCODE_BRIDGE_KEY].vscode;
	try {
		const { createRequire } = await import("node:module");
		const req = createRequire(import.meta.url);
		return req("vscode");
	} catch {
		/* not in an extension host */
	}
	try {
		return await import("vscode");
	} catch {
		return undefined;
	}
}

// ── Context core (host-provided, same process) ──────────────

/** The context-collection functions the host exposes on the shared global. */
export interface ContextCore {
	collectEditorContext(
		vscode: any,
		cwd: string,
		options?: {
			includeSelection?: boolean;
			maxFiles?: number;
			includeGitStats?: boolean;
		},
	): Promise<{
		workspace: { folders: string[]; name?: string; trusted: boolean };
		active?: {
			path: string;
			languageId: string;
			line: number;
			col: number;
			lineCount: number;
			dirty: boolean;
		};
		selection?: {
			start: string;
			end: string;
			lines: number;
			text?: string;
		};
		selections: Array<{
			file: string;
			start: string;
			end: string;
			lines: number;
			text?: string;
		}>;
		openEditors: Array<{ path: string; active: boolean; dirty: boolean }>;
		recent: string[];
		git?: { available: boolean; repos: any[]; reason?: string };
		scmInput?: string;
		terminals: string[];
		debug?: { name: string; type: string } | null;
		collectedAt: number;
		errors: string[];
	}>;
	formatContextSnapshot(
		ctx: any,
		cwd: string,
		options?: { fresh?: boolean },
	): string;
	collectGitDiffs(
		vscode: any,
		cwd: string,
		options?: { path?: string; maxFiles?: number; maxDiffLines?: number },
	): Promise<string>;
	trackContextEvents(vscode: any): void;
	getRecentFiles(): string[];
	formatLiveContext(ctx: any, cwd: string): string;
}

export function getContextCore(): ContextCore | undefined {
	const g = globalThis as Record<string, any>;
	return g[CONTEXT_CORE_KEY];
}

// ── Tool definitions ─────────────────────────────────────────

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

/** Build both context tools; exported for tests. */
export function createContextToolDefinitions(): {
	get_editor_context: ToolDefinition;
	get_git_diff: ToolDefinition;
} {
	const editorContextParameters = Type.Object({
		/** Force-include the full selection text (up to 2000 chars). */
		includeSelection: Type.Optional(Type.Boolean()),
		/** Append full unified diffs for changed files (capped). */
		includeDiff: Type.Optional(Type.Boolean()),
		/** Cap on the git changed-files list (default 30). */
		maxFiles: Type.Optional(Type.Number()),
	});

	const gitDiffParameters = Type.Object({
		/** Restrict to one changed file (path relative to cwd or the repo root). */
		path: Type.Optional(Type.String()),
		/** Cap on lines per diff (default 2000). */
		maxLines: Type.Optional(Type.Number()),
	});

	const getEditorContext: ToolDefinition = {
		name: "get_editor_context",
		label: "Editor context",
		description:
			"Read the current VS Code editor state: active file + cursor, selection, open editors, recent file switches, git branch and changed files with ±line counts, SCM commit box, open terminals, and the active debug session. Call this to see what the user is working on right now.",
		promptSnippet:
			"Inspect the current VS Code editor state (active file, selection, open editors, git changes, terminals, debug)",
		promptGuidelines: [
			"Before editing or explaining a file, call get_editor_context to see the active editor and selection.",
			"When the user changes files mid-task, call get_editor_context again — your session-start snapshot is stale.",
		],
		parameters: editorContextParameters,
		executionMode: "sequential",
		async execute(
			_toolCallId: string,
			params: { includeSelection?: boolean; includeDiff?: boolean; maxFiles?: number },
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			if (signal?.aborted) {
				return textResult("get_editor_context aborted.");
			}
			const core = getContextCore();
			const vscode = await getVscode();
			if (!core) {
				return textResult(
					"Editor-context core unavailable — reload the VS Code window so the host exposes it.",
				);
			}
			if (!vscode?.window) {
				return textResult(
					"VS Code API unavailable — the context tools must run inside the VS Code extension host.",
				);
			}
			try {
				const collected = await core.collectEditorContext(vscode, ctx.cwd, {
					includeSelection: params.includeSelection,
					maxFiles: params.maxFiles,
				});
				let text = core.formatContextSnapshot(collected, ctx.cwd, {
					fresh: true,
				});
				if (params.includeDiff) {
					text +=
						"\n\n" +
						(await core.collectGitDiffs(vscode, ctx.cwd, {
							maxFiles: params.maxFiles,
						}));
				}
				return textResult(text);
			} catch (err) {
				return textResult(
					`get_editor_context failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	};

	const getGitDiff: ToolDefinition = {
		name: "get_git_diff",
		label: "Git diff",
		description:
			"Return the full unified diffs (working tree vs HEAD) for the changed files in the workspace, or for one file via the path parameter. Untracked files are inlined with their content. Output is truncated at 2000 lines per file / 4000 lines total.",
		promptSnippet: "Fetch full git diffs for changed files (working tree vs HEAD)",
		parameters: gitDiffParameters,
		executionMode: "sequential",
		async execute(
			_toolCallId: string,
			params: { path?: string; maxLines?: number },
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			if (signal?.aborted) {
				return textResult("get_git_diff aborted.");
			}
			const core = getContextCore();
			const vscode = await getVscode();
			if (!core) {
				return textResult(
					"Editor-context core unavailable — reload the VS Code window so the host exposes it.",
				);
			}
			if (!vscode?.window) {
				return textResult(
					"VS Code API unavailable — the context tools must run inside the VS Code extension host.",
				);
			}
			try {
				const text = await core.collectGitDiffs(vscode, ctx.cwd, {
					path: params.path,
					maxDiffLines: params.maxLines,
				});
				return textResult(text);
			} catch (err) {
				return textResult(
					`get_git_diff failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	};

	return { get_editor_context: getEditorContext, get_git_diff: getGitDiff };
}

// ── Extension factory ────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Seed the recent-file tracker on session start. The core (host-side)
	// keeps one shared cache; this call is idempotent.
	pi.on("session_start", async () => {
		const vscode = await getVscode();
		getContextCore()?.trackContextEvents(vscode);
	});

	// Live per-turn context: the session-start snapshot in the system prompt
	// goes stale the moment the user switches files or makes a selection. This
	// handler injects a compact active-file + selection block into the next
	// turn's context (as a hidden custom message) whenever that state changed
	// since the last turn — so the agent can see what the user just selected
	// without being told to call get_editor_context. Unchanged state injects
	// nothing, keeping the token cost near zero.
	let lastLiveSignature: string | undefined;
	pi.on("before_agent_start", async (event, ctx) => {
		const core = getContextCore();
		const vscode = await getVscode();
		if (!core || !vscode?.window) return;
		try {
			const collected = await core.collectEditorContext(vscode, ctx.cwd, {
				includeGitStats: false,
			});
			// Re-inject only when the active file or any selection changed.
			const signature = JSON.stringify([
				collected.active?.path ?? null,
				(collected.selections ?? []).map((s) => [
					s.file,
					s.start,
					s.end,
					s.text,
				]),
			]);
			if (signature === lastLiveSignature) return;
			lastLiveSignature = signature;
			const text = core.formatLiveContext(collected, ctx.cwd);
			if (!text) return;
			return {
				message: {
					customType: "codepi-context:live",
					content: [{ type: "text", text }],
					display: false,
				},
			};
		} catch {
			return;
		}
	});

	const tools = createContextToolDefinitions();
	for (const [name, tool] of Object.entries(tools)) {
		try {
			pi.registerTool(tool);
			console.log(`[codepi-context] registered tool ${name}`);
		} catch (err) {
			console.error(`[codepi-context] registerTool(${name}) failed:`, err);
		}
	}
}
