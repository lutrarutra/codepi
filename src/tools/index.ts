import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { askUserQuestionTool } from "./ask-user-question";
export { askUserQuestionTool } from "./ask-user-question";
export type {
	Question,
	QuestionOption,
	QuestionAnswer,
	AskQuestionsParams,
} from "./ask-user-question";
import { ReviewManager } from "../review/review-manager";
import type { EditProposal } from "../review/types";
import { applyEditsToContent } from "../review/edit-apply";

/**
 * VS Code workspace tool definitions.
 *
 * Tools are defined as plain objects with JSON Schema parameters so they can
 * be passed to the PI SDK at runtime without resolving ESM imports at bundle
 * time. The execute functions are self-contained and use VS Code workspace APIs.
 */

export interface VscodeTool {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
	): Promise<{
		content: Array<{ type: "text"; text: string }>;
		isError?: boolean;
		details: Record<string, unknown>;
	}>;
}

/** Build tool result details that carry the review proposal summary. */
function proposalDetails(
	proposal: EditProposal | undefined,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	if (!proposal) return { ...extra };
	return {
		...extra,
		editProposal: {
			proposalId: proposal.proposalId,
			path: proposal.path,
			hunkCount: proposal.hunks.length,
			status: proposal.status,
		},
	};
}

/** Read a file from the workspace with optional line-range selection. */
export const readFileTool: VscodeTool = {
	name: "read",
	label: "Read File",
	description:
		"Read the contents of a file using VS Code's workspace file system. " +
		"Supports text files and images (jpg, png, gif, webp, bmp). " +
		"Images are sent as attachments. For text files, output is truncated to 2000 lines or " +
		"50KB (whichever is hit first). Use offset/limit for large files.",
	parameters: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "Path to the file to read (relative or absolute)",
			},
			offset: {
				type: "number",
				description: "Line number to start reading from (1-indexed)",
			},
			limit: { type: "number", description: "Maximum number of lines to read" },
		},
		required: ["path"],
	},
	async execute(_toolCallId, params) {
		const {
			path: filePath,
			offset,
			limit,
		} = params as {
			path: string;
			offset?: number;
			limit?: number;
		};
		const uri = resolveUri(filePath);
		try {
			const content = await vscode.workspace.fs.readFile(uri);
			const text = new TextDecoder().decode(content);
			return selectLines(text, offset, limit);
		} catch {
			return {
				content: [
					{ type: "text" as const, text: `File not found: ${filePath}` },
				],
				isError: true,
				details: {},
			};
		}
	},
};

/** Create or overwrite a file in the workspace. */
export function createWriteFileTool(review: ReviewManager): VscodeTool {
	return {
		name: "write",
		label: "Write File",
		description:
			"Create a new file or overwrite an existing file with the given content using VS Code's workspace file system. " +
			"Automatically creates parent directories. " +
			"The change is applied immediately but tracked for review — the user can accept or revert it from the editor.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to the file to write (relative or absolute)",
				},
				content: {
					type: "string",
					description: "Content to write to the file",
				},
			},
			required: ["path", "content"],
		},
		async execute(toolCallId, params) {
			if (writeMode === "disabled") {
				return {
					content: [
						{
							type: "text" as const,
							text: "Writing files is not available in Ask mode. Switch to Agent or Plan mode to write files.",
						},
					],
					isError: true,
					details: {},
				};
			}
			const { path: filePath, content } = params as {
				path: string;
				content: string;
			};
			if (writeMode === "plan" && !filePath.endsWith(".md")) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Cannot write to ${filePath}. In Plan mode, you can only create/edit markdown (.md) files for planning.`,
						},
					],
					isError: true,
					details: {},
				};
			}
			const uri = resolveUri(filePath);
			const uriStr = uri.toString();

			// Capture the current content (empty for new files) BEFORE writing so
			// the review proposal can compute hunks and later revert.
			let originalContent = "";
			try {
				const existing = await vscode.workspace.fs.readFile(uri);
				originalContent = new TextDecoder().decode(existing);
			} catch {
				// New file — treat as an all-add proposal.
				try {
					await vscode.workspace.fs.createDirectory(
						vscode.Uri.joinPath(uri, ".."),
					);
				} catch {
					/* parent may already exist */
				}
			}

			const data = new TextEncoder().encode(content);
			await vscode.workspace.fs.writeFile(uri, data);

			const proposal = review.createProposal({
				toolCallId,
				uri: uriStr,
				path: filePath,
				originalContent,
				proposedContent: content,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${content.split("\n").length} lines to ${filePath}${
							proposal.hunks.length > 0
								? ` — ${proposal.hunks.length} change${proposal.hunks.length > 1 ? "s" : ""} pending review`
								: ""
						}`,
					},
				],
				details: proposalDetails(proposal),
			};
		},
	};
}

/**
 * Edit a file with targeted oldText/newText replacements.
 * Follows Pi's `edit` tool schema; changes are applied immediately and saved,
 * then tracked for review like writes.
 */
export function createEditFileTool(review: ReviewManager): VscodeTool {
	return {
		name: "edit",
		label: "Edit File",
		description:
			"Apply targeted replacements to an existing file. Each edit must contain a unique oldText (matching exactly, including whitespace) " +
			"and a newText replacement. Edits must not overlap. The change is applied immediately but tracked for review.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to the file to edit (relative or absolute)",
				},
				edits: {
					type: "array",
					description:
						"One or more targeted replacements. Each edit is matched against the original file, not incrementally.",
					items: {
						type: "object",
						properties: {
							oldText: {
								type: "string",
								description:
									"Exact text to replace. Must be unique in the original file and must not overlap with other edits.",
							},
							newText: {
								type: "string",
								description: "Replacement text.",
							},
						},
						required: ["oldText", "newText"],
					},
				},
			},
			required: ["path", "edits"],
		},
		async execute(toolCallId, params) {
			if (writeMode === "disabled") {
				return {
					content: [
						{
							type: "text" as const,
							text: "Editing files is not available in Ask mode. Switch to Agent or Plan mode.",
						},
					],
					isError: true,
					details: {},
				};
			}
			const { path: filePath, edits } = params as {
				path: string;
				edits?: Array<{ oldText: string; newText: string }>;
			};
			if (writeMode === "plan" && !filePath.endsWith(".md")) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Cannot edit ${filePath}. In Plan mode, you can only edit markdown (.md) files for planning.`,
						},
					],
					isError: true,
					details: {},
				};
			}
			if (!Array.isArray(edits) || edits.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Edit tool input is invalid. edits must contain at least one replacement.",
						},
					],
					isError: true,
					details: {},
				};
			}

			const uri = resolveUri(filePath);
			const uriStr = uri.toString();
			let originalContent: string;
			try {
				const raw = await vscode.workspace.fs.readFile(uri);
				originalContent = new TextDecoder().decode(raw);
			} catch {
				return {
					content: [
						{ type: "text" as const, text: `File not found: ${filePath}` },
					],
					isError: true,
					details: {},
				};
			}

			let proposedContent: string;
			try {
				proposedContent = applyEditsToContent(originalContent, edits, filePath);
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: err instanceof Error ? err.message : String(err),
						},
					],
					isError: true,
					details: {},
				};
			}

			const data = new TextEncoder().encode(proposedContent);
			await vscode.workspace.fs.writeFile(uri, data);

			const proposal = review.createProposal({
				toolCallId,
				uri: uriStr,
				path: filePath,
				originalContent,
				proposedContent,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `Edited ${filePath}: ${proposal.hunks.length} change${
							proposal.hunks.length > 1 ? "s" : ""
						} pending review`,
					},
				],
				details: proposalDetails(proposal),
			};
		},
	};
}

/** List directory contents in the workspace. */
export const listDirTool: VscodeTool = {
	name: "list_dir",
	label: "List Directory",
	description:
		"List files and directories in a given path using VS Code's workspace file system.",
	parameters: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "Absolute or workspace-relative directory path",
			},
		},
		required: ["path"],
	},
	async execute(_toolCallId, params) {
		const { path: dirPath } = params as { path: string };
		const uri = resolveUri(dirPath);
		const entries = await vscode.workspace.fs.readDirectory(uri);
		const lines = entries.map(
			([name, type]) =>
				`${type === vscode.FileType.Directory ? "📁" : "📄"} ${name}`,
		);
		return {
			content: [
				{
					type: "text" as const,
					text: lines.join("\n") || "(empty directory)",
				},
			],
			details: {},
		};
	},
};

/** Default exclude patterns (merged with any user-provided exclude). */
const DEFAULT_EXCLUDE =
	"{node_modules,.git,dist,build,out,target,.next,__pycache__,.venv,*.min.js}";

/** ── Tool: find_files — Search file names/paths by glob ───────────── */

export const findFilesTool: VscodeTool = {
	name: "find_files",
	label: "Find Files",
	description:
		"Search for files and directories by name/glob pattern using VS Code's file index. " +
		"Uses glob syntax: `**/*.ts`, `src/**/*.css`, `**/*.{ts,js}`. " +
		"Prefix with `**/` to search recursively. Excludes node_modules, .git, dist, build by default.",
	parameters: {
		type: "object",
		properties: {
			pattern: {
				type: "string",
				description:
					"Glob pattern to match file paths against. Examples: `**/*.ts`, `src/**/*.test.ts`, `**/*.{py,js}`",
			},
			path: {
				type: "string",
				description:
					"Subdirectory to search within (relative to workspace, e.g. 'src/'). Defaults to workspace root",
			},
			excludePattern: {
				type: "string",
				description:
					"Glob to exclude (merged with defaults: node_modules, .git, dist, build, out, target). E.g. '**/*.test.ts'",
			},
			maxResults: {
				type: "number",
				description: "Maximum files to return (default 100, max 500)",
			},
		},
		required: ["pattern"],
	},
	async execute(_toolCallId, params) {
		const {
			pattern,
			path: searchPath,
			excludePattern,
			maxResults,
		} = params as {
			pattern: string;
			path?: string;
			excludePattern?: string;
			maxResults?: number;
		};
		const ws = vscode.workspace.workspaceFolders?.[0];
		if (!ws) {
			return {
				content: [{ type: "text" as const, text: "No workspace open" }],
				isError: true,
				details: {},
			};
		}
		const limit = maxResults ? Math.min(maxResults, 500) : 100;
		const mergedExclude = excludePattern
			? `{${DEFAULT_EXCLUDE},${excludePattern}}`
			: DEFAULT_EXCLUDE;
		const baseUri = searchPath
			? vscode.Uri.joinPath(ws.uri, searchPath)
			: ws.uri;
		const files = await vscode.workspace.findFiles(
			new vscode.RelativePattern(baseUri, pattern),
			mergedExclude,
			limit,
		);
		const lines = files.map((f) => vscode.workspace.asRelativePath(f));
		return {
			content: [
				{
					type: "text" as const,
					text: lines.join("\n") || "No files found",
				},
			],
			details: { total: files.length },
		};
	},
};

/** ── Tool: grep — Search file CONTENTS for a text pattern ─────────── */

export const grepTool: VscodeTool = {
	name: "grep",
	label: "Grep",
	description:
		"Search FILE CONTENTS for a text or regex pattern. Scans files found via glob, then checks each line. " +
		"Results are grouped by file with line numbers. " +
		"Supports case-sensitive matching (isCaseSensitive) and regex (isRegExp). " +
		"Use includePattern to narrow to specific file types (`**/*.ts`, `**/*.{py,js}`). " +
		"Be specific: use function names, identifiers, unique strings, or error messages.",
	parameters: {
		type: "object",
		properties: {
			pattern: {
				type: "string",
				description: "Text or regex pattern to search for in file contents",
			},
			path: {
				type: "string",
				description:
					"Subdirectory to scope the search to (relative, e.g. 'src/'). Defaults to workspace root",
			},
			includePattern: {
				type: "string",
				description:
					"Glob to filter which files to search (e.g. '**/*.ts', '**/*.{ts,js}'). Defaults to all files",
			},
			excludePattern: {
				type: "string",
				description:
					"Glob to exclude files/dirs (merged with defaults: node_modules, .git, dist, build). E.g. '**/*.test.ts'",
			},
			isCaseSensitive: {
				type: "boolean",
				description:
					"Case-sensitive matching. Default: false (case-insensitive)",
			},
			isRegExp: {
				type: "boolean",
				description:
					"Treat pattern as a regex. Default: false (plain text substring match)",
			},
			maxResults: {
				type: "number",
				description: "Max match lines to return (default 80, max 500)",
			},
		},
		required: ["pattern"],
	},
	async execute(_toolCallId, params) {
		const {
			pattern,
			path: searchPath,
			includePattern,
			excludePattern,
			isCaseSensitive,
			isRegExp,
			maxResults,
		} = params as {
			pattern: string;
			path?: string;
			includePattern?: string;
			excludePattern?: string;
			isCaseSensitive?: boolean;
			isRegExp?: boolean;
			maxResults?: number;
		};
		const ws = vscode.workspace.workspaceFolders?.[0];
		if (!ws) {
			return {
				content: [{ type: "text" as const, text: "No workspace open" }],
				isError: true,
				details: {},
			};
		}

		try {
			const limit = maxResults ? Math.min(maxResults, 500) : 80;
			const rawLines = await searchWithRipgrep(ws.uri.fsPath, pattern, {
				searchPath,
				includePattern,
				excludePattern,
				isCaseSensitive: isCaseSensitive ?? false,
				isRegExp: isRegExp ?? false,
				maxResults: limit,
			});

			// Parse JSON lines from ripgrep output
			const matches: Array<{
				file: string;
				line: number;
				column: number;
				text: string;
			}> = [];
			for (const line of rawLines) {
				try {
					const event = JSON.parse(line);
					if (event.type === "match") {
						const rel = vscode.workspace.asRelativePath(event.data.path.text);
						matches.push({
							file: rel,
							line: event.data.line_number,
							column: (event.data.submatches[0]?.start ?? 0) + 1,
							text: (event.data.lines.text ?? "").trimEnd(),
						});
					}
				} catch {
					// skip non-JSON lines
				}
			}

			if (matches.length === 0) {
				// Patterns match literally by default — if the pattern contains
				// regex metacharacters, remind callers that escaping is NOT
				// needed (and isRegExp: true switches to regex syntax).
				const looksLikeRegex = /[.*+?^${}()|[\]\\]/.test(pattern);
				const hint = looksLikeRegex
					? "\n(No matches — patterns match literally by default. Set isRegExp: true to use regex syntax; do NOT escape regex chars for plain-text searches.)"
					: "";
				return {
					content: [{ type: "text" as const, text: `No matches found${hint}` }],
					details: {},
				};
			}

			// Format grouped by file
			const byFile = new Map<string, string[]>();
			for (const m of matches) {
				const fileLines = byFile.get(m.file) || [];
				fileLines.push(`  ${m.line}:${m.column}: ${m.text.substring(0, 150)}`);
				byFile.set(m.file, fileLines);
			}

			const output: string[] = [];
			let fileIdx = 0;
			for (const [file, fileLines] of byFile) {
				if (fileIdx >= 40) {
					output.push(`... and ${byFile.size - fileIdx} more files`);
					break;
				}
				output.push(`${file}:`);
				output.push(...fileLines.slice(0, 10));
				if (fileLines.length > 10) {
					output.push(`  ... and ${fileLines.length - 10} more matches`);
				}
				fileIdx++;
			}

			const totalFiles = byFile.size;
			if (matches.length >= limit) {
				output.push(
					`\n(First ${matches.length} matches across ${totalFiles} files — narrow your pattern for more precision)`,
				);
			} else {
				output.push(`\n(${matches.length} matches across ${totalFiles} files)`);
			}

			return {
				content: [{ type: "text" as const, text: output.join("\n") }],
				details: { matchedFiles: totalFiles, totalMatches: matches.length },
			};
		} catch (err) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
					},
				],
				isError: true,
				details: {},
			};
		}
	},
};

/** ── ripgrep-based content search ─────────────────────────────── */

interface RgOptions {
	searchPath?: string;
	includePattern?: string;
	excludePattern?: string;
	isCaseSensitive?: boolean;
	isRegExp?: boolean;
	maxResults?: number;
}

/**
 * Search file contents using ripgrep via @vscode/ripgrep npm package.
 * Uses dynamic import() so esbuild doesn't bundle the ESM package incorrectly.
 * Returns raw JSON lines from rg --json output (caller parses them).
 */
let _rgPath: string | undefined;
async function searchWithRipgrep(
	cwd: string,
	pattern: string,
	options: RgOptions,
): Promise<string[]> {
	// Resolve rg path (cached after first call)
	if (!_rgPath) {
		try {
			const mod = await import("@vscode/ripgrep-universal");
			_rgPath = mod.rgPath;
		} catch {
			// @vscode/ripgrep-universal not available — fall back to system PATH
			_rgPath = process.platform === "win32" ? "rg.exe" : "rg";
		}
	}

	return new Promise((resolve, reject) => {
		const args: string[] = [
			"--json",
			"--line-number",
			"--column",
			"--color",
			"never",
		];

		// Default exclusions
		args.push("--glob", "!**/.git/**");
		args.push("--glob", "!**/node_modules/**");
		args.push("--glob", "!**/dist/**");
		args.push("--glob", "!**/build/**");

		// Case sensitivity: rg is case-sensitive by default
		if (!options.isCaseSensitive) {
			args.push("--ignore-case");
		}

		// Fixed strings vs regex
		if (!options.isRegExp) {
			args.push("--fixed-strings");
		}

		// Max results per file
		if (options.maxResults) {
			args.push("--max-count", String(options.maxResults));
		}

		// User-provided include pattern
		if (options.includePattern) {
			for (const g of options.includePattern.split(",")) {
				const trimmed = g.trim();
				if (trimmed) args.push("--glob", trimmed);
			}
		}

		// User-provided exclude pattern
		if (options.excludePattern) {
			for (const g of options.excludePattern.split(",")) {
				const trimmed = g.trim();
				if (trimmed) args.push("--glob", `!${trimmed}`);
			}
		}

		// Pattern
		args.push(pattern);

		// Search root
		args.push(options.searchPath || ".");

		const child = spawn(_rgPath!, args, {
			cwd,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"] as const,
		});

		const output: string[] = [];
		let stderr = "";

		child.stdout.on("data", (chunk: Buffer) => {
			output.push(chunk.toString());
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on("error", reject);

		child.on("close", (code: number | null) => {
			// ripgrep: 0 = matches, 1 = no matches, 2+ = error
			if (code === 0 || code === 1) {
				resolve(output.join("").split("\n").filter(Boolean));
			} else {
				reject(new Error(stderr || `ripgrep exited with code ${code}`));
			}
		});
	});
}
/** Build the full tool list for an agent session backed by `review`. */
export function createVscodeTools(review: ReviewManager): VscodeTool[] {
	return [
		readFileTool,
		createWriteFileTool(review),
		createEditFileTool(review),
		listDirTool,
		findFilesTool,
		grepTool,
		askUserQuestionTool,
	];
}

/**
 * Default tool list used when no review manager is injected (tests, fallback).
 * A fresh manager is created per call; tools created from this list still
 * register proposals so review state is always tracked.
 */
export function getVscodeTools(review?: ReviewManager): VscodeTool[] {
	return createVscodeTools(review ?? getDefaultReviewManager());
}

let _defaultReviewManager: ReviewManager | undefined;
function getDefaultReviewManager(): ReviewManager {
	if (!_defaultReviewManager) {
		_defaultReviewManager = new ReviewManager(
			{
				post: () => {},
				notify: () => {},
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
	}
	return _defaultReviewManager;
}

/** Back-compat: module-level tool array (uses the default review manager). */
export const vscodeTools: VscodeTool[] = getVscodeTools();

// ── Mode-controlled write tool behavior ──────────────────────

/**
 * Current write mode for the tools. Set by the extension when changing modes.
 * - "agent": full write access
 * - "plan": only .md files allowed
 * - "disabled": no writes allowed (Ask mode)
 */
export let writeMode: "agent" | "plan" | "disabled" = "agent";

/** Set the write mode for the tools (called by extension on mode change). */
export function setWriteMode(mode: "ask" | "plan" | "agent"): void {
	writeMode = mode === "ask" ? "disabled" : mode;
}

// ── helpers ────────────────────────────────────────────────────────

function resolveUri(filePath: string): vscode.Uri {
	if (filePath.startsWith("/")) {
		return vscode.Uri.file(filePath);
	}
	const ws = vscode.workspace.workspaceFolders?.[0];
	if (ws) {
		return vscode.Uri.joinPath(ws.uri, filePath);
	}
	return vscode.Uri.file(filePath);
}

function selectLines(
	text: string,
	offset?: number,
	limit?: number,
): {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
} {
	if (offset === undefined && limit === undefined) {
		return { content: [{ type: "text", text }], details: {} };
	}
	const lines = text.split("\n");
	const start = (offset ?? 1) - 1;
	const end = limit ? start + limit : lines.length;
	const sliced = lines.slice(start, end).join("\n");
	return { content: [{ type: "text", text: sliced }], details: {} };
}
