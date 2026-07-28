import type { McpServer } from "../server";
import { readFileTool } from "./read-file";
import { writeFileTool } from "./write-file";
import { listDirTool } from "./list-dir";
import { searchTool } from "./search";

export function registerCoreTools(server: McpServer): void {
	server.registerTool(readFileTool);
	server.registerTool(writeFileTool);
	server.registerTool(listDirTool);
	server.registerTool(searchTool);
}
