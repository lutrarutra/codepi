import * as http from "node:http";
import { findFreePort } from "../utils/port";
import { McpTransport } from "./transport";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(params: Record<string, unknown>): Promise<McpToolResult>;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface McpServer {
  port: number;
  registerTool(def: McpToolDefinition): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createMcpServer(): McpServer {
  const toolRegistry = new Map<string, McpToolDefinition>();
  const transport = new McpTransport(toolRegistry);
  let server: http.Server | undefined;
  let allocatedPort = 0;

  return {
    get port() {
      return allocatedPort;
    },

    registerTool(def: McpToolDefinition): void {
      toolRegistry.set(def.name, def);
    },

    async start(): Promise<void> {
      allocatedPort = await findFreePort();
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => transport.handleRequest(req, res));
        server.on("error", reject);
        server.listen(allocatedPort, "127.0.0.1", () => resolve());
      });
    },

    async stop(): Promise<void> {
      return new Promise((resolve) => {
        if (server) {
          server.close(() => resolve());
        } else {
          resolve();
        }
      });
    },
  };
}
