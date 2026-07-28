import * as vscode from "vscode";
import type { McpToolDefinition } from "../server";

export const listDirTool: McpToolDefinition = {
  name: "vscode.list_dir",
  description: "List files and directories in a given path.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or workspace-relative directory path" },
    },
    required: ["path"],
  },
  async handler(params) {
    const { path: dirPath } = params as { path: string };
    const uri = dirPath.startsWith("/")
      ? vscode.Uri.file(dirPath)
      : vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("/"), dirPath);
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const lines = entries.map(([name, type]) => `${type === 2 ? "📁" : "📄"} ${name}`);
    return { content: [{ type: "text", text: lines.join("\n") || "(empty directory)" }] };
  },
};
