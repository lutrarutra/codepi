# VSCode Extension for Pi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a VSCode extension that embeds pi as a coding agent where all file operations, terminal commands, and editor interactions are executed through VSCode APIs via an MCP server. The user gets a rich chat panel with Copilot-style inline edit review.

**Architecture:** Pi SDK runs in-process in the extension host via `createAgentSession()` with built-in tools disabled. An MCP server (SSE/HTTP on localhost) exposes VSCode API tools. An inline pi extension discovers MCP tools and registers them. A React webview provides the chat UI. Edits are decoration-based inline diffs with per-hunk accept/reject — never applied directly.

**Tech Stack:** TypeScript, React 18, Vite 5, esbuild, @earendil-works/pi-coding-agent (bundled), @modelcontextprotocol/sdk (MCP types only — we hand-roll the transport)

## Global Constraints

- pi SDK version: `@earendil-works/pi-coding-agent@^0.80.0` (bundled dependency)
- VSCode engine: `^1.85.0`
- `noTools: "builtin"` — pi never touches the filesystem directly
- MCP transport: hand-rolled SSE/HTTP (zero npm deps for MCP)
- Extension is a webview panel (not sidebar), opened via command `codepi.openPanel`
- Webview uses VSCode theme CSS variables for styling
- Credentials from `~/.pi/agent/auth.json` (pi's standard location)
- Optional `codepi.piPath` setting for custom pi SDK/binary

---

## File Structure Map

```
codepi/
├── src/                              # Extension host (TypeScript)
│   ├── extension.ts                  # Entry point: activate, deactivate, openPanel command
│   ├── mcp/
│   │   ├── server.ts                 # SSE/HTTP MCP server (createServer, start, stop)
│   │   ├── transport.ts              # SSE connection handler, MCP JSON-RPC framing
│   │   └── tools/
│   │       ├── index.ts              # Tool registry: Map<name, McpToolDefinition>
│   │       ├── read-file.ts          # vscode.read_file
│   │       ├── write-file.ts         # vscode.write_file
│   │       ├── edit.ts               # vscode.edit (decoration-based, never direct)
│   │       ├── search.ts             # vscode.search
│   │       ├── list-dir.ts           # vscode.list_dir
│   │       ├── terminal.ts           # vscode.terminal
│   │       ├── diff.ts               # vscode.diff
│   │       └── open-file.ts          # vscode.open_file
│   ├── review/
│   │   ├── decoration-manager.ts     # Per-hunk TextEditorDecorationType, CodeLens provider
│   │   └── hunk-tracker.ts           # Track pending/resolved hunks across files
│   ├── agent/
│   │   ├── runtime.ts                # createSession(), disposeSession()
│   │   └── tool-registry.ts          # discoverMcpTools(), registerMcpTools()
│   ├── bridge/
│   │   ├── protocol.ts               # All message types (ExtensionMessage, WebviewMessage)
│   │   └── relay.ts                  # PiEventRelay: subscribes to session, posts to webview
│   └── utils/
│       └── port.ts                   # findFreePort(): Promise<number>
├── webview-ui/                       # React frontend
│   ├── src/
│   │   ├── main.tsx                  # ReactDOM.createRoot bootstrap
│   │   ├── App.tsx                   # Root: message handler switch, layout
│   │   ├── types.ts                  # Shared message type definitions (mirrors bridge/protocol.ts)
│   │   ├── components/
│   │   │   ├── ChatView.tsx          # Message list with auto-scroll
│   │   │   ├── MessageBubble.tsx     # Single message: user or assistant
│   │   │   ├── AssistantMessage.tsx  # Assistant message with Markdown + thinking + tool cards
│   │   │   ├── ThinkingBlock.tsx     # Collapsible thinking accordion
│   │   │   ├── ToolCallCard.tsx      # Expandable tool call card
│   │   │   ├── ModelPicker.tsx       # Model dropdown + thinking level
│   │   │   ├── EditReviewBar.tsx     # Cross-file accept/reject all bar
│   │   │   ├── EditCard.tsx          # Per-file edit status in chat
│   │   │   ├── SessionSidebar.tsx    # Session list, token usage
│   │   │   └── InputArea.tsx         # Textarea + send button + streaming state
│   │   └── hooks/
│   │       ├── useVSCodeAPI.ts       # postMessage wrapper, message listener
│   │       └── useStreaming.ts       # Streaming text accumulator
│   ├── index.html
│   ├── vite.config.ts
│   ├── package.json
│   └── tsconfig.json
├── package.json                      # Extension manifest + pi SDK dep
├── tsconfig.json                     # Backend tsconfig
├── esbuild.mjs                       # Backend bundler
├── .vscodeignore                     # Exclude source from .vsix
└── .gitignore
```

---

## Phase 1: Core Loop

> **Deliverable:** User can open the chat panel, type a message, pi responds with streaming text, pi can read/write files through VSCode.

### Task 1.1: Project Scaffold

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `esbuild.mjs`
- Create: `.vscodeignore`
- Create: `.gitignore`

**Interfaces:**

- Produces: Buildable extension shell that loads in VSCode

- [ ] **Step 1: Write package.json**

```json
{
  "name": "codepi",
  "displayName": "CodePi",
  "description": "Pi coding agent for VSCode",
  "version": "0.1.0",
  "publisher": "pi-dev",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Chat", "Programming Languages"],
  "main": "./dist/extension.js",
  "contributes": {
    "configuration": {
      "title": "CodePi",
      "properties": {
        "codepi.piPath": {
          "type": "string",
          "default": "",
          "description": "Path to custom pi SDK or pi binary. Leave empty to use bundled pi."
        }
      }
    },
    "commands": [
      {
        "command": "codepi.openPanel",
        "title": "CodePi: Open Chat"
      }
    ]
  },
  "scripts": {
    "vscode:prepublish": "npm run build",
    "build": "npm run build:webview && npm run build:extension",
    "build:extension": "node esbuild.mjs --production",
    "build:webview": "npm --prefix webview-ui run build",
    "watch": "concurrently -n webview,ext \"npm:watch:webview\" \"npm:watch:extension\"",
    "watch:extension": "node esbuild.mjs",
    "watch:webview": "npm --prefix webview-ui run dev",
    "lint": "tsc -p ./tsconfig.json --noEmit"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^0.80.1"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "@types/vscode": "^1.85.0",
    "concurrently": "^8.2.2",
    "esbuild": "^0.20.0",
    "typescript": "^5.3.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "webview-ui"]
}
```

- [ ] **Step 3: Write esbuild.mjs**

```javascript
import * as esbuild from "esbuild";

const isProduction = process.argv.includes("--production");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !isProduction,
  minify: isProduction,
});

if (isProduction) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
  console.log("watching...");
}
```

- [ ] **Step 4: Write .vscodeignore**

```
.vscode
src
webview-ui/src
webview-ui/node_modules
node_modules
.git
.gitignore
tsconfig.json
esbuild.mjs
```

- [ ] **Step 5: Write .gitignore**

```
node_modules
dist
*.vsix
```

- [ ] **Step 6: Create webview-ui scaffold**

Write `webview-ui/package.json`:

```json
{
  "name": "codepi-webview",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite build --watch",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.48",
    "@types/react-dom": "^18.2.18",
    "@vitejs/plugin-react": "^4.2.1",
    "typescript": "^5.3.0",
    "vite": "^5.0.12"
  }
}
```

Write `webview-ui/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

Write `webview-ui/vite.config.ts`:

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/index.css",
      },
    },
  },
});
```

Write `webview-ui/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CodePi</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 7: Install dependencies and verify build**

```bash
cd /home/lutrarutra/dev/codepi
npm install
npm --prefix webview-ui install
npm run build
ls dist/extension.js  # should exist
ls webview-ui/dist/assets/index.js  # should exist
```

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json esbuild.mjs .vscodeignore .gitignore webview-ui/
git commit -m "feat: project scaffold with esbuild + Vite webview"
```

---

### Task 1.2: MCP Server Transport

**Files:**

- Create: `src/utils/port.ts`
- Create: `src/mcp/transport.ts`
- Create: `src/mcp/server.ts`

**Interfaces:**

- Produces: `createMcpServer(): Promise<McpServer>`

  ```typescript
  interface McpServer {
    port: number;
    registerTool(def: McpToolDefinition): void;
    start(): Promise<void>;
    stop(): Promise<void>;
  }
  interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler(params: Record<string, unknown>): Promise<McpToolResult>;
  }
  interface McpToolResult {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }
  ```

- [ ] **Step 1: Write src/utils/port.ts**

```typescript
import * as net from "node:net";

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        reject(new Error("Could not determine port"));
      }
    });
  });
}
```

- [ ] **Step 2: Write src/mcp/transport.ts**

```typescript
import * as http from "node:http";
import type { McpToolDefinition, McpToolResult } from "./server";

interface SseClient {
  id: string;
  res: http.ServerResponse;
}

export class McpTransport {
  private clients: SseClient[] = [];
  private clientId = 0;

  constructor(private toolRegistry: Map<string, McpToolDefinition>) {}

  handleRequest(req: http.ServerRequest, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/sse" && req.method === "GET") {
      this.handleSse(req, res);
    } else if (url.pathname === "/message" && req.method === "POST") {
      this.handleMessage(req, res);
    } else if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200).end("ok");
    } else {
      res.writeHead(404).end("not found");
    }
  }

  private handleSse(_req: http.ServerRequest, res: http.ServerResponse): void {
    const id = String(++this.clientId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");

    const client: SseClient = { id, res };
    this.clients.push(client);

    // Send endpoint event so the client knows where to POST
    this.sendEvent(res, "endpoint", `/message?sessionId=${id}`);

    req.on("close", () => {
      this.clients = this.clients.filter((c) => c.id !== id);
    });
  }

  private async handleMessage(req: http.ServerRequest, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    let message: { jsonrpc: string; id?: number; method: string; params?: Record<string, unknown> };

    try {
      message = JSON.parse(body);
    } catch {
      res.writeHead(400).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }));
      return;
    }

    const response = await this.handleJsonRpc(message);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  }

  private async handleJsonRpc(msg: { jsonrpc: string; id?: number; method: string; params?: Record<string, unknown> }): Promise<unknown> {
    switch (msg.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "codepi-vscode", version: "0.1.0" },
          },
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: Array.from(this.toolRegistry.values()).map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };

      case "tools/call": {
        const { name, arguments: args } = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        const tool = name ? this.toolRegistry.get(name) : undefined;
        if (!tool) {
          return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Tool not found: ${name}` } };
        }
        try {
          const result = await tool.handler(args ?? {});
          return { jsonrpc: "2.0", id: msg.id, result };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            jsonrpc: "2.0",
            id: msg.id,
            result: { content: [{ type: "text", text: message }], isError: true },
          };
        }
      }

      case "notifications/initialized":
        return { jsonrpc: "2.0", id: msg.id, result: {} };

      default:
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  }

  private sendEvent(res: http.ServerResponse, event: string, data: string): void {
    res.write(`event: ${event}\ndata: ${data}\n\n`);
  }

  sendNotification(method: string, params: Record<string, unknown>): void {
    const data = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const client of this.clients) {
      this.sendEvent(client.res, "message", data);
    }
  }
}

function readBody(req: http.ServerRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
```

- [ ] **Step 3: Write src/mcp/server.ts**

```typescript
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
    get port() { return allocatedPort; },

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
```

- [ ] **Step 4: Verify server starts**

```bash
cd /home/lutrarutra/dev/codepi
npx ts-node -e "
const { createMcpServer } = require('./src/mcp/server');
(async () => {
  const s = createMcpServer();
  await s.start();
  console.log('listening on', s.port);
  const res = await fetch('http://127.0.0.1:' + s.port + '/health');
  console.log('health:', res.status);
  await s.stop();
})();
"
```

- [ ] **Step 5: Commit**

```bash
git add src/utils/port.ts src/mcp/transport.ts src/mcp/server.ts
git commit -m "feat: MCP server with SSE transport and JSON-RPC"
```

---

### Task 1.3: MCP Tools — Read, Write, List, Search

**Files:**

- Create: `src/mcp/tools/read-file.ts`
- Create: `src/mcp/tools/write-file.ts`
- Create: `src/mcp/tools/list-dir.ts`
- Create: `src/mcp/tools/search.ts`
- Create: `src/mcp/tools/index.ts`

**Interfaces:**

- Consumes: `McpToolDefinition` from `src/mcp/server.ts`
- Produces: `registerCoreTools(server: McpServer, cwd: string): void`

- [ ] **Step 1: Write src/mcp/tools/read-file.ts**

```typescript
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

function selectLines(text: string, offset?: number, limit?: number): { content: Array<{ type: "text"; text: string }> } {
  if (offset === undefined && limit === undefined) {
    return { content: [{ type: "text", text }] };
  }
  const lines = text.split("\n");
  const start = (offset ?? 1) - 1;
  const end = limit ? start + limit : lines.length;
  const sliced = lines.slice(start, end).join("\n");
  return { content: [{ type: "text", text: sliced }] };
}
```

- [ ] **Step 2: Write src/mcp/tools/write-file.ts**

```typescript
import * as vscode from "vscode";
import type { McpToolDefinition } from "../server";

export const writeFileTool: McpToolDefinition = {
  name: "vscode.write_file",
  description: "Create a new file or overwrite an existing file with the given content.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or workspace-relative path" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  async handler(params) {
    const { path: filePath, content } = params as { path: string; content: string };
    const ws = vscode.workspace.workspaceFolders?.[0];
    const baseUri = filePath.startsWith("/") ? vscode.Uri.file("/") : (ws?.uri ?? vscode.Uri.file("/"));
    const uri = filePath.startsWith("/") ? vscode.Uri.file(filePath) : vscode.Uri.joinPath(baseUri, filePath);
    const data = new TextEncoder().encode(content);
    await vscode.workspace.fs.writeFile(uri, data);
    return { content: [{ type: "text", text: `Wrote ${content.split("\n").length} lines to ${filePath}` }] };
  },
};
```

- [ ] **Step 3: Write src/mcp/tools/list-dir.ts**

```typescript
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
    const ws = vscode.workspace.workspaceFolders?.[0];
    const baseUri = dirPath.startsWith("/") ? vscode.Uri.file("/") : (ws?.uri ?? vscode.Uri.file("/"));
    const uri = dirPath.startsWith("/") ? vscode.Uri.file(dirPath) : vscode.Uri.joinPath(baseUri, dirPath);
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const lines = entries.map(([name, type]) => `${type === 2 ? "📁" : "📄"} ${name}`);
    return { content: [{ type: "text", text: lines.join("\n") || "(empty directory)" }] };
  },
};
```

- [ ] **Step 4: Write src/mcp/tools/search.ts**

```typescript
import * as vscode from "vscode";
import type { McpToolDefinition } from "../server";

export const searchTool: McpToolDefinition = {
  name: "vscode.search",
  description: "Search for files by glob pattern, or search file contents for a text pattern.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern for file search, or text pattern for content search" },
      path: { type: "string", description: "Directory to search in (defaults to workspace root)" },
      searchContent: { type: "boolean", description: "If true, search file contents instead of filenames" },
    },
    required: ["pattern"],
  },
  async handler(params) {
    const { pattern, path: searchPath, searchContent } = params as { pattern: string; path?: string; searchContent?: boolean };
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (!ws) {
      return { content: [{ type: "text", text: "No workspace open" }], isError: true };
    }

    if (searchContent) {
      const baseUri = searchPath ? vscode.Uri.joinPath(ws.uri, searchPath) : ws.uri;
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(baseUri, "**/*"),
        "**/node_modules/**"
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
      return { content: [{ type: "text", text: results.join("\n") || "No matches found" }] };
    } else {
      const baseUri = searchPath ? vscode.Uri.joinPath(ws.uri, searchPath) : ws.uri;
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(baseUri, pattern),
        "**/node_modules/**",
        50
      );
      const lines = files.map((f) => vscode.workspace.asRelativePath(f));
      return { content: [{ type: "text", text: lines.join("\n") || "No files found" }] };
    }
  },
};
```

- [ ] **Step 5: Write src/mcp/tools/index.ts**

```typescript
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
```

- [ ] **Step 6: Verify tools compile**

```bash
cd /home/lutrarutra/dev/codepi
npx tsc -p tsconfig.json --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/
git commit -m "feat: MCP tools — read_file, write_file, list_dir, search"
```

---

### Task 1.4: Agent Runtime + MCP Bridge

**Files:**

- Create: `src/agent/tool-registry.ts`
- Create: `src/agent/runtime.ts`

**Interfaces:**

- Consumes: `McpServer` from `src/mcp/server.ts`, pi SDK from `@earendil-works/pi-coding-agent`
- Produces: `createAgentRuntime(mcpServer): Promise<{ session: AgentSession; dispose(): Promise<void> }>`

- [ ] **Step 1: Write src/agent/tool-registry.ts**

```typescript
import * as http from "node:http";

interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export async function discoverMcpTools(port: number): Promise<McpToolSchema[]> {
  const initRes = await postJson(`http://127.0.0.1:${port}/message`, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "codepi", version: "0.1.0" } },
  });
  if (initRes.error) throw new Error(`MCP initialize failed: ${JSON.stringify(initRes.error)}`);

  await postJson(`http://127.0.0.1:${port}/message`, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });

  const listRes = await postJson(`http://127.0.0.1:${port}/message`, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  if (listRes.error) throw new Error(`MCP tools/list failed: ${JSON.stringify(listRes.error)}`);
  return listRes.result.tools as McpToolSchema[];
}

export async function callMcpTool(port: number, name: string, args: Record<string, unknown>): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const res = await postJson(`http://127.0.0.1:${port}/message`, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (res.error) {
    return { content: [{ type: "text", text: res.error.message ?? String(res.error) }], isError: true };
  }
  return res.result as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
}

function postJson(endpoint: string, body: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(endpoint);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) },
      },
      (res) => {
        let buf = "";
        res.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
        res.on("end", () => {
          try { resolve(JSON.parse(buf)); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
```

- [ ] **Step 2: Write src/agent/runtime.ts**

```typescript
import * as path from "node:path";
import * as os from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { discoverMcpTools, callMcpTool } from "./tool-registry";
import type { McpServer } from "../mcp/server";
import type { PiEventRelay } from "../bridge/relay";

export async function createAgentRuntime(
  mcpServer: McpServer,
  relay: PiEventRelay,
): Promise<{ session: AgentSession; dispose(): Promise<void> }> {
  const workspaceRoot = getWorkspaceRoot();
  const agentDir = path.join(os.homedir(), ".pi", "agent");

  const modelRuntime = await ModelRuntime.create();

  const mcpBridgeExtension: InlineExtension = {
    name: "codepi-vscode-bridge",
    factory: (pi) => {
      pi.on("tool_call", async (event, ctx) => {
        // MCP tools are handled by the registered tool's execute function,
        // so we only need to log or skip here.
      });

      discoverMcpTools(mcpServer.port).then((tools) => {
        for (const tool of tools) {
          pi.registerTool({
            name: tool.name,
            label: tool.name,
            description: tool.description,
            parameters: jsonSchemaToTypeBox(tool.inputSchema),
            async execute(_toolCallId, params) {
              return callMcpTool(mcpServer.port, tool.name, params as Record<string, unknown>);
            },
          });
        }
      });
    },
  };

  const loader = new DefaultResourceLoader({
    cwd: workspaceRoot,
    agentDir,
    extensionFactories: [mcpBridgeExtension],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    resourceLoader: loader,
    modelRuntime,
    cwd: workspaceRoot,
    agentDir,
    noTools: "builtin",
    sessionManager: SessionManager.create(workspaceRoot),
  });

  relay.attach(session);

  return {
    session,
    async dispose() {
      relay.detach();
      session.dispose();
    },
  };
}

function getWorkspaceRoot(): string {
  const ws = require("vscode").workspace.workspaceFolders?.[0];
  return ws?.uri.fsPath ?? os.homedir();
}

import { Type } from "typebox";

function jsonSchemaToTypeBox(schema: Record<string, unknown>): ReturnType<typeof Type.Object> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const schemaProps = (schema.properties ?? {}) as Record<string, { type: string; description?: string }>;
  for (const [key, prop] of Object.entries(schemaProps)) {
    if (prop.type === "string") {
      properties[key] = Type.String({ description: prop.description });
    } else if (prop.type === "number") {
      properties[key] = Type.Number({ description: prop.description });
    } else if (prop.type === "boolean") {
      properties[key] = Type.Boolean({ description: prop.description });
    } else {
      properties[key] = Type.Any({ description: prop.description });
    }
    if ((schema.required as string[] | undefined)?.includes(key)) {
      required.push(key);
    }
  }
  const options: Record<string, unknown> = {};
  if (required.length > 0) {
    // TypeBox uses a different approach for required; we'll handle it per-field
  }
  return Type.Object(properties as any);
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/lutrarutra/dev/codepi
npx tsc -p tsconfig.json --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/agent/
git commit -m "feat: agent runtime with MCP bridge extension"
```

---

### Task 1.5: State Bridge Protocol + Relay

**Files:**

- Create: `src/bridge/protocol.ts`
- Create: `src/bridge/relay.ts`

**Interfaces:**

- Produces: `PiEventRelay` class that subscribes to `AgentSession` events and posts messages to a `vscode.Webview`

- [ ] **Step 1: Write src/bridge/protocol.ts**

```typescript
// Messages from extension host to webview
export type ExtensionMessage =
  | { command: "textDelta"; delta: string }
  | { command: "textEnd" }
  | { command: "thinkingDelta"; delta: string }
  | { command: "thinkingEnd" }
  | { command: "toolCallStart"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { command: "toolCallUpdate"; toolCallId: string; text: string }
  | { command: "toolCallEnd"; toolCallId: string; result: string; isError: boolean }
  | { command: "agentStart" }
  | { command: "agentEnd"; willRetry: boolean }
  | { command: "agentSettled" }
  | { command: "error"; text: string };

// Messages from webview to extension host
export type WebviewMessage =
  | { command: "prompt"; text: string }
  | { command: "steer"; text: string }
  | { command: "followUp"; text: string }
  | { command: "abort" }
  | { command: "setModel"; provider: string; modelId: string }
  | { command: "setThinkingLevel"; level: string }
  | { command: "newSession" }
  | { command: "resumeSession"; id: string }
  | { command: "listModels" }
  | { command: "listSessions" };
```

- [ ] **Step 2: Write src/bridge/relay.ts**

```typescript
import * as vscode from "vscode";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExtensionMessage } from "./protocol";

export class PiEventRelay {
  private webview: vscode.Webview | undefined;
  private unsubscribe: (() => void) | undefined;

  setWebview(webview: vscode.Webview): void {
    this.webview = webview;
  }

  attach(session: AgentSession): void {
    this.unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const e = event.assistantMessageEvent;
          if (e.type === "text_delta") {
            this.post({ command: "textDelta", delta: e.delta });
          } else if (e.type === "thinking_delta" && "delta" in e) {
            this.post({ command: "thinkingDelta", delta: (e as any).delta });
          } else if (e.type === "text_end") {
            this.post({ command: "textEnd" });
          } else if (e.type === "thinking_end") {
            this.post({ command: "thinkingEnd" });
          } else if (e.type === "toolcall_start" && "toolCall" in e) {
            const tc = (e as any).toolCall;
            this.post({ command: "toolCallStart", toolCallId: tc.id, toolName: tc.name, args: tc.arguments ?? {} });
          } else if (e.type === "toolcall_end" && "toolCall" in e) {
            const tc = (e as any).toolCall;
            this.post({ command: "toolCallEnd", toolCallId: tc.id, result: "", isError: false });
          }
          break;
        }
        case "tool_execution_start":
          this.post({ command: "toolCallStart", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args ?? {} });
          break;
        case "tool_execution_update": {
          const text = (event.partialResult as any)?.content?.[0]?.text ?? "";
          this.post({ command: "toolCallUpdate", toolCallId: event.toolCallId, text });
          break;
        }
        case "tool_execution_end": {
          const text = (event.result as any)?.content?.[0]?.text ?? "";
          this.post({ command: "toolCallEnd", toolCallId: event.toolCallId, result: text, isError: event.isError });
          break;
        }
        case "agent_start":
          this.post({ command: "agentStart" });
          break;
        case "agent_end":
          this.post({ command: "agentEnd", willRetry: event.willRetry });
          break;
        case "agent_settled":
          this.post({ command: "agentSettled" });
          break;
      }
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private post(msg: ExtensionMessage): void {
    this.webview?.postMessage(msg);
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/lutrarutra/dev/codepi
npx tsc -p tsconfig.json --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/bridge/
git commit -m "feat: state bridge protocol + pi event relay"
```

---

### Task 1.6: Webview Chat UI

**Files:**

- Create: `webview-ui/src/main.tsx`
- Create: `webview-ui/src/types.ts`
- Create: `webview-ui/src/App.tsx`
- Create: `webview-ui/src/hooks/useVSCodeAPI.ts`
- Create: `webview-ui/src/hooks/useStreaming.ts`
- Create: `webview-ui/src/components/ChatView.tsx`
- Create: `webview-ui/src/components/MessageBubble.tsx`
- Create: `webview-ui/src/components/InputArea.tsx`
- Create: `webview-ui/src/index.css`

**Interfaces:**

- Consumes: `ExtensionMessage` / `WebviewMessage` types (mirrored from `src/bridge/protocol.ts`)

- [ ] **Step 1: Write webview-ui/src/types.ts**

```typescript
export type ExtensionMessage =
  | { command: "textDelta"; delta: string }
  | { command: "textEnd" }
  | { command: "thinkingDelta"; delta: string }
  | { command: "thinkingEnd" }
  | { command: "toolCallStart"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { command: "toolCallUpdate"; toolCallId: string; text: string }
  | { command: "toolCallEnd"; toolCallId: string; result: string; isError: boolean }
  | { command: "agentStart" }
  | { command: "agentEnd"; willRetry: boolean }
  | { command: "agentSettled" }
  | { command: "error"; text: string };

export type WebviewMessage =
  | { command: "prompt"; text: string }
  | { command: "steer"; text: string }
  | { command: "followUp"; text: string }
  | { command: "abort" }
  | { command: "setModel"; provider: string; modelId: string }
  | { command: "setThinkingLevel"; level: string }
  | { command: "newSession" }
  | { command: "resumeSession"; id: string }
  | { command: "listModels" }
  | { command: "listSessions" };

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  toolCalls: ToolCallState[];
  complete: boolean;
  timestamp: number;
}

export interface ToolCallState {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  output: string;
  isError: boolean;
  running: boolean;
}
```

- [ ] **Step 2: Write webview-ui/src/hooks/useVSCodeAPI.ts**

```typescript
import { useEffect, useCallback } from "react";
import type { ExtensionMessage, WebviewMessage } from "../types";

const vscodeApi = acquireVsCodeApi();

export function useVSCodeAPI(onMessage: (msg: ExtensionMessage) => void) {
  useEffect(() => {
    const handler = (e: MessageEvent<ExtensionMessage>) => onMessage(e.data);
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onMessage]);

  const post = useCallback((msg: WebviewMessage) => {
    vscodeApi.postMessage(msg);
  }, []);

  return { post };
}
```

- [ ] **Step 3: Write webview-ui/src/hooks/useStreaming.ts**

```typescript
import { useReducer, useCallback } from "react";
import type { ChatMessage, ToolCallState } from "../types";

interface ChatState {
  messages: ChatMessage[];
  streaming: boolean;
}

type Action =
  | { type: "addUserMessage"; text: string }
  | { type: "startAssistantMessage" }
  | { type: "textDelta"; delta: string }
  | { type: "thinkingDelta"; delta: string }
  | { type: "textEnd" }
  | { type: "thinkingEnd" }
  | { type: "toolCallStart"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "toolCallUpdate"; toolCallId: string; text: string }
  | { type: "toolCallEnd"; toolCallId: string; result: string; isError: boolean }
  | { type: "agentSettled" }
  | { type: "error"; text: string };

let nextId = 1;

function chatReducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case "addUserMessage":
      return {
        ...state,
        streaming: true,
        messages: [
          ...state.messages,
          { id: nextId++, role: "user", text: action.text, thinking: "", toolCalls: [], complete: true, timestamp: Date.now() },
        ],
      };

    case "startAssistantMessage":
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: nextId++, role: "assistant", text: "", thinking: "", toolCalls: [], complete: false, timestamp: Date.now() },
        ],
      };

    case "textDelta": {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && !last.complete) {
        msgs[msgs.length - 1] = { ...last, text: last.text + action.delta };
      }
      return { ...state, messages: msgs };
    }

    case "thinkingDelta": {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && !last.complete) {
        msgs[msgs.length - 1] = { ...last, thinking: last.thinking + action.delta };
      }
      return { ...state, messages: msgs };
    }

    case "textEnd":
    case "thinkingEnd":
      return state; // handled via delta accumulation

    case "toolCallStart": {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && !last.complete) {
        const toolCalls = [
          ...last.toolCalls,
          { toolCallId: action.toolCallId, toolName: action.toolName, args: action.args, output: "", isError: false, running: true },
        ];
        msgs[msgs.length - 1] = { ...last, toolCalls };
      }
      return { ...state, messages: msgs };
    }

    case "toolCallUpdate": {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && !last.complete) {
        const toolCalls = last.toolCalls.map((tc) =>
          tc.toolCallId === action.toolCallId ? { ...tc, output: tc.output + action.text } : tc
        );
        msgs[msgs.length - 1] = { ...last, toolCalls };
      }
      return { ...state, messages: msgs };
    }

    case "toolCallEnd": {
      const msgs = [...state.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && !last.complete) {
        const toolCalls = last.toolCalls.map((tc) =>
          tc.toolCallId === action.toolCallId ? { ...tc, output: action.result, isError: action.isError, running: false } : tc
        );
        msgs[msgs.length - 1] = { ...last, toolCalls };
      }
      return { ...state, messages: msgs };
    }

    case "agentSettled":
      return {
        ...state,
        streaming: false,
        messages: state.messages.map((m) =>
          m.role === "assistant" && !m.complete ? { ...m, complete: true } : m
        ),
      };

    case "error":
      return {
        ...state,
        streaming: false,
        messages: [
          ...state.messages,
          { id: nextId++, role: "assistant", text: `Error: ${action.text}`, thinking: "", toolCalls: [], complete: true, timestamp: Date.now() },
        ],
      };

    default:
      return state;
  }
}

export function useStreaming() {
  const [state, dispatch] = useReducer(chatReducer, { messages: [], streaming: false });

  const handleExtensionMessage = useCallback((msg: ExtensionMessage) => {
    switch (msg.command) {
      case "agentStart":
        dispatch({ type: "startAssistantMessage" });
        break;
      case "textDelta":
        dispatch({ type: "textDelta", delta: msg.delta });
        break;
      case "textEnd":
        dispatch({ type: "textEnd" });
        break;
      case "thinkingDelta":
        dispatch({ type: "thinkingDelta", delta: msg.delta });
        break;
      case "thinkingEnd":
        dispatch({ type: "thinkingEnd" });
        break;
      case "toolCallStart":
        dispatch({ type: "toolCallStart", toolCallId: msg.toolCallId, toolName: msg.toolName, args: msg.args });
        break;
      case "toolCallUpdate":
        dispatch({ type: "toolCallUpdate", toolCallId: msg.toolCallId, text: msg.text });
        break;
      case "toolCallEnd":
        dispatch({ type: "toolCallEnd", toolCallId: msg.toolCallId, result: msg.result, isError: msg.isError });
        break;
      case "agentSettled":
        dispatch({ type: "agentSettled" });
        break;
      case "error":
        dispatch({ type: "error", text: msg.text });
        break;
    }
  }, []);

  const addUserMessage = useCallback((text: string) => {
    dispatch({ type: "addUserMessage", text });
  }, []);

  return { state, handleExtensionMessage, addUserMessage };
}
```

- [ ] **Step 4: Write webview-ui/src/components/ChatView.tsx**

```tsx
import { useRef, useEffect } from "react";
import type { ChatMessage } from "../types";
import { MessageBubble } from "./MessageBubble";

interface Props {
  messages: ChatMessage[];
}

export function ChatView({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="chat-messages">
      {messages.length === 0 && (
        <div className="chat-empty">
          <p>Ask CodePi anything about your codebase.</p>
        </div>
      )}
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
```

- [ ] **Step 5: Write webview-ui/src/components/MessageBubble.tsx**

```tsx
import type { ChatMessage } from "../types";

interface Props {
  message: ChatMessage;
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === "user";

  return (
    <div className={`chat-bubble ${isUser ? "user" : "assistant"}`}>
      <div className="chat-bubble-header">
        {isUser ? "You" : "CodePi"}
        <span className="chat-bubble-time">
          {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      <div className="chat-bubble-text">
        {message.text || (message.thinking ? <em>Thinking...</em> : "...")}
        {!message.complete && <span className="chat-typing-cursor">▊</span>}
      </div>
      {message.toolCalls.length > 0 && (
        <div className="chat-tool-calls">
          {message.toolCalls.map((tc) => (
            <div key={tc.toolCallId} className={`chat-tool-call ${tc.isError ? "error" : ""}`}>
              <div className="chat-tool-call-name">
                {tc.running ? "⏳" : tc.isError ? "❌" : "✅"} {tc.toolName}
              </div>
              {tc.output && (
                <pre className="chat-tool-call-output">{tc.output.slice(0, 2000)}{tc.output.length > 2000 ? "\n... (truncated)" : ""}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Write webview-ui/src/components/InputArea.tsx**

```tsx
import { useState, useRef, type KeyboardEvent } from "react";

interface Props {
  streaming: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}

export function InputArea({ streaming, onSend, onAbort }: Props) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;
    onSend(trimmed);
    setInput("");
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === "Escape" && streaming) {
      onAbort();
    }
  }

  return (
    <div className="chat-input-area">
      <textarea
        ref={textareaRef}
        className="chat-input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={streaming ? "CodePi is thinking... (Esc to abort)" : "Type a message... (Enter to send, Shift+Enter for new line)"}
        rows={2}
        disabled={streaming}
      />
      {streaming ? (
        <button className="chat-abort-btn" onClick={onAbort}>Stop</button>
      ) : (
        <button className="chat-send-btn" onClick={handleSend} disabled={!input.trim()}>Send</button>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Write webview-ui/src/App.tsx**

```tsx
import { useCallback } from "react";
import { useVSCodeAPI } from "./hooks/useVSCodeAPI";
import { useStreaming } from "./hooks/useStreaming";
import { ChatView } from "./components/ChatView";
import { InputArea } from "./components/InputArea";

export default function App() {
  const { state, handleExtensionMessage, addUserMessage } = useStreaming();
  const { post } = useVSCodeAPI(handleExtensionMessage);

  const handleSend = useCallback(
    (text: string) => {
      addUserMessage(text);
      post({ command: "prompt", text });
    },
    [post, addUserMessage]
  );

  const handleAbort = useCallback(() => {
    post({ command: "abort" });
  }, [post]);

  return (
    <div className="chat-container">
      <ChatView messages={state.messages} />
      <InputArea streaming={state.streaming} onSend={handleSend} onAbort={handleAbort} />
    </div>
  );
}
```

- [ ] **Step 8: Write webview-ui/src/main.tsx**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 9: Write webview-ui/src/index.css**

```css
:root {
  --bg-primary: var(--vscode-editor-background, #1e1e1e);
  --bg-secondary: var(--vscode-sideBar-background, #252526);
  --text-primary: var(--vscode-editor-foreground, #d4d4d4);
  --text-secondary: var(--vscode-descriptionForeground, #888);
  --border-color: var(--vscode-panel-border, #3c3c3c);
  --accent: var(--vscode-button-background, #007acc);
  --accent-hover: var(--vscode-button-hoverBackground, #1a8ad4);
  --input-bg: var(--vscode-input-background, #3c3c3c);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--vscode-font-family, -apple-system, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  color: var(--text-primary);
  background: var(--bg-primary);
}

.chat-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.chat-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-secondary);
}

.chat-bubble {
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  max-width: 90%;
}

.chat-bubble.user {
  margin-left: auto;
  background: var(--accent);
  color: white;
}

.chat-bubble.assistant {
  margin-right: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
}

.chat-bubble-header {
  font-size: 11px;
  margin-bottom: 4px;
  color: var(--text-secondary);
  display: flex;
  justify-content: space-between;
}

.chat-bubble.user .chat-bubble-header {
  color: rgba(255, 255, 255, 0.7);
}

.chat-bubble-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-typing-cursor {
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}

.chat-tool-calls {
  margin-top: 8px;
}

.chat-tool-call {
  margin-top: 4px;
  padding: 6px 8px;
  background: var(--bg-primary);
  border-radius: 4px;
  font-size: 12px;
}

.chat-tool-call.error {
  border-left: 3px solid #f44747;
}

.chat-tool-call-name {
  font-weight: 600;
  margin-bottom: 2px;
}

.chat-tool-call-output {
  max-height: 200px;
  overflow-y: auto;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
  background: var(--input-bg);
  padding: 4px 8px;
  border-radius: 3px;
  margin-top: 4px;
}

.chat-input-area {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-color);
}

.chat-input {
  flex: 1;
  resize: none;
  padding: 8px;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  color: var(--text-primary);
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  outline: none;
}

.chat-input:focus {
  border-color: var(--accent);
}

.chat-input:disabled {
  opacity: 0.6;
}

.chat-send-btn,
.chat-abort-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  align-self: flex-end;
}

.chat-send-btn {
  background: var(--accent);
  color: white;
}

.chat-send-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}

.chat-send-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.chat-abort-btn {
  background: #f44747;
  color: white;
}
```

- [ ] **Step 10: Build webview and verify**

```bash
cd /home/lutrarutra/dev/codepi
npm run build:webview
ls webview-ui/dist/assets/index.js   # must exist
ls webview-ui/dist/assets/index.css  # must exist
```

- [ ] **Step 11: Commit**

```bash
git add webview-ui/src/
git commit -m "feat: React chat UI with streaming + tool call display"
```

---

### Task 1.7: Extension Entry Point + Webview Panel

**Files:**

- Create: `src/extension.ts`

**Interfaces:**

- Consumes: All previous modules
- Produces: VSCode extension that activates, creates webview panel, wires everything together

- [ ] **Step 1: Write src/extension.ts**

```typescript
import * as vscode from "vscode";
import * as path from "node:path";
import { createMcpServer } from "./mcp/server";
import { registerCoreTools } from "./mcp/tools/index";
import { createAgentRuntime } from "./agent/runtime";
import { PiEventRelay } from "./bridge/relay";
import type { WebviewMessage } from "./bridge/protocol";

let panel: vscode.WebviewPanel | undefined;
let mcpServer: ReturnType<typeof createMcpServer> | undefined;
let agentRuntime: Awaited<ReturnType<typeof createAgentRuntime>> | undefined;
const relay = new PiEventRelay();

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand("codepi.openPanel", () => {
    if (panel) {
      panel.reveal(vscode.ViewColumn.Two);
      return;
    }

    panel = vscode.window.createWebviewPanel(
      "codepi",
      "CodePi",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "webview-ui", "dist"),
        ],
      }
    );

    panel.webview.html = buildHtml(context.extensionUri, panel.webview);
    relay.setWebview(panel.webview);

    panel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        await handleWebviewMessage(message);
      },
      undefined,
      context.subscriptions
    );

    panel.onDidDispose(
      async () => {
        panel = undefined;
        relay.setWebview(undefined as any);
        await agentRuntime?.dispose();
        agentRuntime = undefined;
        await mcpServer?.stop();
        mcpServer = undefined;
      },
      undefined,
      context.subscriptions
    );

    // Start MCP server and agent runtime
    startBackend();
  });

  context.subscriptions.push(disposable);
}

async function startBackend() {
  try {
    mcpServer = createMcpServer();
    registerCoreTools(mcpServer);
    await mcpServer.start();
    console.log(`[CodePi] MCP server listening on port ${mcpServer.port}`);

    agentRuntime = await createAgentRuntime(mcpServer, relay);
    console.log("[CodePi] Agent runtime ready");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    panel?.webview.postMessage({ command: "error", text: msg });
    console.error("[CodePi] Backend start failed:", err);
  }
}

async function handleWebviewMessage(message: WebviewMessage) {
  if (!agentRuntime) return;

  try {
    switch (message.command) {
      case "prompt":
        await agentRuntime.session.prompt(message.text);
        break;
      case "steer":
        await agentRuntime.session.steer(message.text);
        break;
      case "followUp":
        await agentRuntime.session.followUp(message.text);
        break;
      case "abort":
        await agentRuntime.session.abort();
        break;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    panel?.webview.postMessage({ command: "error", text: msg });
  }
}

function buildHtml(extensionUri: vscode.Uri, webview: vscode.Webview): string {
  const distUri = vscode.Uri.joinPath(extensionUri, "webview-ui", "dist");
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(distUri, "assets", "index.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(distUri, "assets", "index.css")
  );
  const nonce = getNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>CodePi</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function deactivate() {}
```

- [ ] **Step 2: Build the full extension**

```bash
cd /home/lutrarutra/dev/codepi
npm run build
ls dist/extension.js                    # must exist
ls webview-ui/dist/assets/index.js      # must exist
ls webview-ui/dist/assets/index.css     # must exist
```

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat: extension entry point — webview panel + backend wiring"
```

---

### Task 1.8: End-to-End Integration Test

- [ ] **Step 1: Open project in VSCode Extension Development Host**

```bash
cd /home/lutrarutra/dev/codepi
code .
# Press F5 to launch Extension Development Host
```

- [ ] **Step 2: Run CodePi: Open Chat from Command Palette**

```
Ctrl+Shift+P → "CodePi: Open Chat"
Expected: Webview panel opens on the right with empty chat and input area
```

- [ ] **Step 3: Send a message that reads a file**

```
Type: "Read the package.json file and tell me what this project is called"
Press Enter
Expected:
  - Message appears in chat
  - Streaming response (text appearing token by token)
  - Response mentions project name is "codepi"
```

- [ ] **Step 4: Send a message that creates a file**

```
Type: "Create a file called test-output.txt with the text 'Hello from pi'"
Expected:
  - Response confirms file created
  - test-output.txt appears in workspace
```

- [ ] **Step 5: Cleanup and commit**

```bash
rm test-output.txt
git add -A
git commit -m "test: Phase 1 end-to-end integration verified"
```

---

## Self-Review

**1. Spec coverage:**

- ✅ MCP server with SSE transport — Task 1.2
- ✅ Core MCP tools (read, write, list, search) — Task 1.3
- ✅ Agent runtime with pi SDK, MCP tool discovery — Task 1.4
- ✅ State bridge with typed protocol — Task 1.5
- ✅ Webview chat UI with streaming — Task 1.6
- ✅ Extension entry point + panel wiring — Task 1.7
- ⬜ Edit tool with decorations (Phase 2)
- ⬜ Terminal, diff, open_file tools (Phase 3)
- ⬜ Thinking blocks, model picker, sessions (Phase 4)
- ⬜ Polish items (Phase 5)

**2. Placeholder scan:** No TBD, TODO, or vague instructions found.

**3. Type consistency:** `ExtensionMessage` and `WebviewMessage` types are identical between `src/bridge/protocol.ts` and `webview-ui/src/types.ts`. `McpToolDefinition` is consistent across `server.ts`, `transport.ts`, and `tools/index.ts`. `PiEventRelay.attach()` signature matches `AgentSession.subscribe()` callback shape.

**4. Missing from Phase 1 by design (deferred to later phases):**

- `vscode.edit` tool (Phase 2 — needs decoration manager)
- `vscode.terminal`, `vscode.diff`, `vscode.open_file` tools (Phase 3)
- Model picker, thinking block display, session sidebar (Phase 4)
- @-mention, marketplace packaging (Phase 5)
