import * as vscode from "vscode";
import type { McpToolDefinition } from "../server";

export const readFileTool: McpToolDefinition = {
  name: "vscode.read_file",
  description:
    "Read the contents of a file. Returns the file text. " +
    "Use offset and limit to read specific line ranges (1-indexed).",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or workspace-relative path to the file" },
      offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
      limit: { type: "number", description: "Maximum number of lines to read" },
    },
    required: ["path"],
  },
  async handler(params) {
    const { path: filePath, offset, limit } = params as { path: string; offset?: number; limit?: number };
    const uri = resolveUri(filePath);
    const content = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder().decode(content);
    return selectLines(text, offset, limit);
  },
};

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
): { content: Array<{ type: "text"; text: string }> } {
  if (offset === undefined && limit === undefined) {
    return { content: [{ type: "text", text }] };
  }
  const lines = text.split("\n");
  const start = (offset ?? 1) - 1;
  const end = limit ? start + limit : lines.length;
  const sliced = lines.slice(start, end).join("\n");
  return { content: [{ type: "text", text: sliced }] };
}
