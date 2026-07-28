import * as vscode from "vscode";
import type { McpToolDefinition } from "../server";

export const searchTool: McpToolDefinition = {
	name: "vscode.search",
	description:
		"Search for files by glob pattern, or search file contents for a text pattern.",
	inputSchema: {
		type: "object",
		properties: {
			pattern: {
				type: "string",
				description:
					"Glob pattern for file search, or text pattern for content search",
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
	async handler(params) {
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
				content: [{ type: "text", text: "No workspace open" }],
				isError: true,
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
					{ type: "text", text: results.join("\n") || "No matches found" },
				],
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
			content: [{ type: "text", text: lines.join("\n") || "No files found" }],
		};
	},
};
