/**
 * Host-side fallback definitions for the codepi-context tools.
 *
 * Normally the bundled `codepi-context` extension registers
 * `get_editor_context` / `get_git_diff` through pi's extension loader. If that
 * extension fails to load in a given environment (no extension-load errors,
 * tool simply missing), the host registers these same tools via
 * `createAgentSession({ customTools })` instead — the same channel CodePi's
 * workspace tools (ffgrep, fffind, get_diagnostics, …) use, which is proven
 * active in every session.
 *
 * The tool definitions are intentionally identical (name, schema, description,
 * snippet, guidelines, execution mode) to the extension's, so behavior is the
 * same regardless of which path registered them. The collection logic lives in
 * src/context-snapshot.ts (also host-side), so there is no duplication of the
 * snapshot/git logic.
 */
import * as vscode from "vscode";
import { Type } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	collectEditorContext,
	collectGitDiffs,
	formatContextSnapshot,
	type EditorContextOptions,
} from "./context-snapshot";

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

/** Build both context tools for host-side customTools registration. */
export function createHostContextTools(): ToolDefinition[] {
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
			ctx: { cwd: string },
		): Promise<AgentToolResult<unknown>> {
			if (signal?.aborted) {
				return textResult("get_editor_context aborted.");
			}
			const options: EditorContextOptions = {
				includeSelection: params.includeSelection,
				maxFiles: params.maxFiles,
			};
			try {
				const collected = await collectEditorContext(vscode, ctx.cwd, options);
				let text = formatContextSnapshot(collected, ctx.cwd, { fresh: true });
				if (params.includeDiff) {
					text +=
						"\n\n" +
						(await collectGitDiffs(vscode, ctx.cwd, {
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
			ctx: { cwd: string },
		): Promise<AgentToolResult<unknown>> {
			if (signal?.aborted) {
				return textResult("get_git_diff aborted.");
			}
			try {
				const text = await collectGitDiffs(vscode, ctx.cwd, {
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

	return [getEditorContext, getGitDiff];
}
