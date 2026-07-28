import * as vscode from "vscode";
import type { McpToolDefinition } from "../server";

export const writeFileTool: McpToolDefinition = {
	name: "vscode.write_file",
	description:
		"Create a new file or overwrite an existing file with the given content.",
	inputSchema: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "Absolute or workspace-relative path",
			},
			content: { type: "string", description: "Content to write" },
		},
		required: ["path", "content"],
	},
	async handler(params) {
		const { path: filePath, content } = params as {
			path: string;
			content: string;
		};
		const uri = filePath.startsWith("/")
			? vscode.Uri.file(filePath)
			: vscode.Uri.joinPath(
					vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("/"),
					filePath,
				);
		const data = new TextEncoder().encode(content);
		await vscode.workspace.fs.writeFile(uri, data);
		return {
			content: [
				{
					type: "text",
					text: `Wrote ${content.split("\n").length} lines to ${filePath}`,
				},
			],
		};
	},
};
