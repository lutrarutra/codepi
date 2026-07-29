import * as vscode from "vscode";

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
			path: { type: "string", description: "Path to the file to read (relative or absolute)" },
			offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
			limit: { type: "number", description: "Maximum number of lines to read" },
		},
		required: ["path"],
	},
	async execute(_toolCallId, params) {
		const { path: filePath, offset, limit } = params as {
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
				content: [{ type: "text" as const, text: `File not found: ${filePath}` }],
				isError: true,
				details: {},
			};
		}
	},
};

/** Create or overwrite a file in the workspace. */
export const writeFileTool: VscodeTool = {
	name: "write",
	label: "Write File",
	description:
		"Create a new file or overwrite an existing file with the given content using VS Code's workspace file system. " +
		"Automatically creates parent directories.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file to write (relative or absolute)" },
			content: { type: "string", description: "Content to write to the file" },
		},
		required: ["path", "content"],
	},
	async execute(_toolCallId, params) {
		const { path: filePath, content } = params as {
			path: string;
			content: string;
		};
		const uri = resolveUri(filePath);
		const data = new TextEncoder().encode(content);
		await vscode.workspace.fs.writeFile(uri, data);
		return {
			content: [
				{
					type: "text" as const,
					text: `Wrote ${content.split("\n").length} lines to ${filePath}`,
				},
			],
			details: {},
		};
	},
};

/** List directory contents in the workspace. */
export const listDirTool: VscodeTool = {
	name: "list_dir",
	label: "List Directory",
	description: "List files and directories in a given path using VS Code's workspace file system.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Absolute or workspace-relative directory path" },
		},
		required: ["path"],
	},
	async execute(_toolCallId, params) {
		const { path: dirPath } = params as { path: string };
		const uri = resolveUri(dirPath);
		const entries = await vscode.workspace.fs.readDirectory(uri);
		const lines = entries.map(
			([name, type]) => `${type === vscode.FileType.Directory ? "📁" : "📄"} ${name}`,
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

/** Search files by glob or content in the workspace. */
export const searchTool: VscodeTool = {
	name: "search",
	label: "Search",
	description:
		"Search for files by glob pattern, or search file contents for a text pattern using VS Code's workspace APIs.",
	parameters: {
		type: "object",
		properties: {
			pattern: {
				type: "string",
				description: "Glob pattern for file search, or text pattern for content search",
			},
			path: {
				type: "string",
				description: "Directory to search in (defaults to workspace root)",
			},
			searchContent: {
				type: "boolean",
				description: "If true, search file contents instead of filenames",
			},
		},
		required: ["pattern"],
	},
	async execute(_toolCallId, params) {
		const {
			pattern,
			path: searchPath,
			searchContent,
		} = params as {
			pattern: string;
			path?: string;
			searchContent?: boolean;
		};
		const ws = vscode.workspace.workspaceFolders?.[0];
		if (!ws) {
			return {
				content: [{ type: "text" as const, text: "No workspace open" }],
				isError: true,
				details: {},
			};
		}

		if (searchContent) {
			const baseUri = searchPath
				? vscode.Uri.joinPath(ws.uri, searchPath)
				: ws.uri;
			const files = await vscode.workspace.findFiles(
				new vscode.RelativePattern(baseUri, "**/*"),
				"**/node_modules/**",
			);
			const results: string[] = [];
			for (const file of files.slice(0, 50)) {
				const content = await vscode.workspace.fs.readFile(file);
				const text = new TextDecoder().decode(content);
				const lines = text.split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].toLowerCase().includes(pattern.toLowerCase())) {
						const relPath = vscode.workspace.asRelativePath(file);
						results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
						if (results.length >= 20) break;
					}
				}
				if (results.length >= 20) break;
			}
			return {
				content: [
					{
						type: "text" as const,
						text: results.join("\n") || "No matches found",
					},
				],
				details: {},
			};
		}

		const baseUri = searchPath
			? vscode.Uri.joinPath(ws.uri, searchPath)
			: ws.uri;
		const files = await vscode.workspace.findFiles(
			new vscode.RelativePattern(baseUri, pattern),
			"**/node_modules/**",
			50,
		);
		const lines = files.map((f) => vscode.workspace.asRelativePath(f));
		return {
			content: [
				{
					type: "text" as const,
					text: lines.join("\n") || "No files found",
				},
			],
			details: {},
		};
	},
};

/** All VS Code tools as an array. */
export const vscodeTools: VscodeTool[] = [
	readFileTool,
	writeFileTool,
	listDirTool,
	searchTool,
];

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
