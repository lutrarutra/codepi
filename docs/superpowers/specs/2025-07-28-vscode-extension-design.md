# VSCode Extension for Pi — Design Spec

**Date:** 2025-07-28
**Status:** Draft

## Overview

A VSCode extension that brings the [pi](https://pi.dev) coding agent into VSCode. Pi provides the reasoning (LLM loop), while all file operations, terminal commands, and editor interactions are executed through VSCode APIs via an MCP server. The user gets a rich chat panel with streaming, thinking blocks, tool call visualization, model management, session management, and deep editor integration.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  VSCode Extension Host                                                       │
│                                                                              │
│  ┌──────────────────────┐   postMessage   ┌──────────────────────────────┐  │
│  │  Webview (React)     │ ◄─────────────► │  Extension Backend (TS)      │  │
│  │                      │                 │                              │  │
│  │  • Chat messages     │                 │  • MCP Server (SSE/HTTP)     │  │
│  │  • Streaming text    │                 │    - vscode.read_file        │  │
│  │  • Thinking blocks   │                 │    - vscode.write_file       │  │
│  │  • Tool call display │                 │    - vscode.edit             │  │
│  │  • Model picker      │                 │    - vscode.terminal         │  │
│  │  • Session manager   │                 │    - vscode.search           │  │
│  │                      │                 │    - vscode.list_dir         │  │
│  └──────────────────────┘                 │    - vscode.diff             │  │
│                                           │    - vscode.open_file        │  │
│                                           │                              │  │
│                                           │  • Agent Runtime (pi SDK)    │  │
│                                           │    createAgentSession()      │  │
│                                           │    noBuiltinTools            │  │
│                                           │    DefaultResourceLoader     │  │
│                                           │                              │  │
│                                           │  • State Bridge              │  │
│                                           │    relays pi events → UI     │  │
│                                           │    relays UI actions → pi    │  │
│                                           └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Key decisions

- **Pi runs in-process via SDK** (`createAgentSession()`), not as a subprocess. No pi binary needed.
- **Built-in tools disabled** (`noTools: "builtin"`). Pi cannot touch the filesystem directly.
- **MCP server in extension host** exposes VSCode APIs as MCP tools over SSE (localhost loopback).
- **Pi extensions and skills preserved** via `DefaultResourceLoader` — user's existing pi packages, extensions, skills, and prompt templates load normally.
- **Webview is pure presentation** — React chat UI, no business logic.
- **Start from scratch** — the existing `codepi` prototype is discarded.

## Component Design

### 1. MCP Server

Local SSE+HTTP server in the extension host. This is the stable boundary — all execution flows through it.

**Tools:**

| Tool | VSCode API | Description |
| ------ | ----------- | ------------- |
| `vscode.read_file` | `workspace.fs.readFile(uri)` | Read file contents by path |
| `vscode.write_file` | `workspace.fs.writeFile(uri, data)` | Create or overwrite a file |
| `vscode.edit` | `TextEditorDecorationType` + `WorkspaceEdit` | Propose edits as inline decorations for review (see Editor Review Flow). Edits are NOT applied directly — they appear as highlighted hunks in the editor that the user accepts/rejects.
| `vscode.search` | `workspace.findFiles` + `commands.executeCommand` | Search files by glob or content |
| `vscode.list_dir` | `workspace.fs.readDirectory(uri)` | List directory contents |
| `vscode.terminal` | `window.createTerminal` + output capture | Run shell commands |
| `vscode.diff` | `commands.executeCommand('vscode.diff', ...)` | Show diff between two files/versions |
| `vscode.open_file` | `window.showTextDocument(uri)` | Open file in editor |

**Transport:** SSE (Server-Sent Events) on a random localhost port, with HTTP POST for tool calls. Follows MCP 2024-11-05 protocol.

**Port allocation:** Bind to port 0 (OS assigns free port), write port to a known temp file so the agent runtime can discover it.

### 2. Agent Runtime

Thin wrapper around pi's SDK. MCP tools are registered via an **inline extension** that connects to the MCP server at startup, calls `tools/list`, and registers each tool via `pi.registerTool()`. The `context-mode` pi package already demonstrates this exact pattern (`mcp-bridge.js`).

```typescript
// Inline extension factory — runs at session startup
const mcpBridgeExtension: InlineExtension = {
  name: "vscode-mcp-bridge",
  factory: (pi) => {
    // Connect to MCP server, list tools, register each one
    for (const tool of await discoverMcpTools(mcpPort)) {
      pi.registerTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,  // JSON Schema → TypeBox
        async execute(_toolCallId, params) {
          const result = await callMcpTool(tool.name, params);
          return {
            content: [{ type: "text", text: result }],
            details: {},
          };
        },
      });
    }
  },
};

const loader = new DefaultResourceLoader({
  cwd: workspaceRoot,
  agentDir: piAgentDir,
  extensionFactories: [mcpBridgeExtension],
});
await loader.reload();

const session = await createAgentSession({
  resourceLoader: loader,
  modelRuntime,
  noTools: "builtin",       // disable read/bash/edit/write/grep/find/ls
  sessionManager: SessionManager.create(workspaceRoot),
});
```

**Responsibilities:**

- Load extensions, skills, prompts, themes via `DefaultResourceLoader`
- MCP bridge extension discovers and registers MCP tools as pi tools
- Configure model from VSCode settings or `/login` flow
- Subscribe to agent events and bridge to webview
- Handle prompt queueing (steer/follow-up during streaming)

### 3. State Bridge

Typed message protocol over `postMessage` between extension host and webview.

```
Webview → Extension:         Extension → Webview:
  prompt(text)                 textDelta(delta)
  steer(text)                  thinkingDelta(delta)
  followUp(text)               toolCallStart(name, args)
  abort()                      toolCallUpdate(partialOutput)
  setModel(provider, id)       toolCallEnd(result, isError)
  setThinkingLevel(level)      agentStart()
  newSession()                 agentEnd(messages, willRetry)
  resumeSession(id)            agentSettled()
  listModels()                 queueUpdate(steering[], followUp[])
  listSessions()               sessionState(model, tokens, cost)
                               error(message)
                               modelsList(models[])
                               sessionsList(sessions[])
```

### 4. Chat UI (Webview)

React application rendered in a VSCode webview panel.

**Views:**

- **Chat view** (primary): message bubbles, streaming text, thinking blocks, tool cards
- **Model picker** (dropdown in header): select model and thinking level
- **Session sidebar** (toggle): list sessions, token usage, new/resume/delete

**Message rendering:**

- User messages: plain text bubbles
- Assistant text: Markdown with syntax-highlighted code blocks (using a lightweight renderer)
- Thinking blocks: collapsible accordion, shows reasoning chain
- Tool calls: expandable card with tool name, arguments, output, and for edits — an "Apply" button that opens a diff view
- Streaming: cursor blink on incomplete messages, real-time token display

**Styling:** Uses VSCode theme CSS variables for native look and feel.

## Editor Review Flow (Copilot-style Inline Diffs)

When pi calls `vscode.edit`, edits are **never applied directly**. Instead, they go through a review pipeline:

```
pi calls vscode.edit(file, hunks)
        │
        ▼
MCP tool opens file in editor if not already open
        │
        ▼
DecorationManager applies per-hunk decorations:
  • Green background on added lines
  • Red background on removed lines
  • Gutter icons (➕/➖) on changed lines
        │
        ▼
Each hunk gets a CodeLens: [Accept] [Reject]
The file tab shows a badge: "3 edits pending"
        │
        ▼
Chat panel shows an EditCard:
  "Edited src/foo.ts — 3 hunks pending review"
  [Accept All in File] [Reject All in File]
        │
        ▼
User reviews inline in editor:
  • Click [Accept] on a CodeLens → that hunk is applied
  • Click [Reject] on a CodeLens → decoration removed, hunk discarded
  • Keyboard shortcuts: Alt+Shift+Y (accept hunk), Alt+Shift+N (reject hunk)
        │
        ▼
When all hunks in a file are resolved, decorations clear.
Chat panel EditCard updates to show resolved count.
```

### Multi-file edits

When pi edits multiple files in one turn, an **Edit Summary** bar appears at the top of the chat panel:

```
┌─────────────────────────────────────────────────────────┐
│ 📝 2 files edited (5 hunks pending)                     │
│ [Accept All] [Reject All]                               │
└─────────────────────────────────────────────────────────┘
```

"Accept All" applies every pending hunk across all files. "Reject All" clears all decorations without applying.

### Decoration API details

- Uses `vscode.window.createTextEditorDecorationType()` for before/after render options
- Per-hunk decorations tracked via `DecorationManager` so they can be individually cleared
- Uses `vscode.languages.registerCodeLensProvider()` for hunk-level accept/reject buttons
- File tab badge uses `vscode.window.tabGroups` API (or status bar fallback)
- All decoration state is ephemeral — no temp files, no patching on disk until user accepts

### State bridge additions

```
Extension → Webview:
  editProposed(filePath, hunkCount)     // new edit pending review
  hunkResolved(filePath, acceptedCount, rejectedCount, totalCount)
  allEditsResolved(totalAccepted, totalRejected)

Webview → Extension:
  acceptHunk(filePath, hunkIndex)       // accept specific hunk
  rejectHunk(filePath, hunkIndex)       // reject specific hunk
  acceptAllInFile(filePath)             // accept all hunks in file
  rejectAllInFile(filePath)             // reject all hunks in file
  acceptAllEdits()                      // accept all hunks across all files
  rejectAllEdits()                      // reject all hunks across all files
```

## Pi Ecosystem Compatibility

Users bring their existing pi setup:

| Resource | Source | Behavior |
| ---------- | -------- | ---------- |
| Extensions | `~/.pi/agent/extensions/`, `.pi/extensions/`, pi packages | Loaded, tools registered alongside MCP tools |
| Skills | `~/.pi/agent/skills/`, `.pi/skills/`, pi packages | Injected into system prompt |
| Prompt templates | `~/.pi/agent/prompts/`, `.pi/prompts/` | Available as `/template` commands |
| Themes | `~/.pi/agent/themes/` | Not applicable (webview uses VSCode theme) |
| Context files | `AGENTS.md`, `CLAUDE.md` | Loaded from home, ancestors, and cwd |
| Settings | `~/.pi/agent/settings.json`, `.pi/settings.json` | Respected for compaction, retry, model config |
| Credentials | `~/.pi/agent/auth.json` | API keys and OAuth tokens |
| Custom models | `~/.pi/agent/models.json` | Additional providers and models |

## Pi Distribution

**Default: bundled SDK.** `@earendil-works/pi-coding-agent` is a normal npm dependency. It ships inside the `.vsix`, so users get pi automatically — no separate install.

**Optional override: `codepi.piPath`.** A VSCode setting that lets users point to their own pi installation:

```json
{
  "codepi.piPath": "/home/user/custom-pi/node_modules/@earendil-works/pi-coding-agent"
}
```

Resolution order:

1. If `codepi.piPath` is set and the path exists, load pi SDK from that path
2. Otherwise, use the bundled SDK from the extension's own `node_modules`
3. If neither works, show an error with setup instructions

**SDK path vs binary path:** When `codepi.piPath` points to a pi SDK directory (contains `package.json` with `@earendil-works/pi-coding-agent`), the extension loads it in-process via `require()` / dynamic `import()`. When it points to a `pi` binary, the extension spawns it via `--mode rpc` as a subprocess instead (fallback RPC mode). Both paths support the same MCP tool set.

**Credentials:** Regardless of which pi is used, credentials are read from `~/.pi/agent/auth.json` (pi's standard location). Users authenticate once via `/login` in terminal pi.

## Error Handling

| Scenario | Handling |
| ---------- | ---------- |
| MCP tool failure (file not found, permission denied) | Error returned to pi as tool result; pi retries or reports to user |
| Pi SDK errors (auth, rate limit, network) | Surfaced in webview as error banner with retry action |
| Streaming interruption (network drop) | Auto-retry with backoff; user can abort |
| Extension host crash | VSCode auto-restarts; session state recovered from JSONL |
| MCP port conflict | Random port allocation with retry |
| Model auth missing | Prompt user to run `/login` or set API key in settings |
| Extension load failure | Logged, remaining extensions continue; errors shown in status bar |

## Session Management

- **Persistence:** Sessions stored as JSONL files in `~/.pi/agent/sessions/` (pi's default)
- **Tree branching:** Full pi session tree support (fork, branch, navigate history)
- **Compaction:** Enabled by default (pi's auto-compaction on context overflow)
- **Stats:** Token usage, cost, context window % displayed in UI

## Testing Strategy

| Layer | Technology | What it tests |
| ------- | ----------- | --------------- |
| MCP server tools | `node:test` + temp workspace | Each tool against real VSCode API mocks |
| MCP protocol | `node:test` + http | SSE transport, tool list, tool call |
| Agent runtime | `node:test` + pi SDK in-memory | Agent session creation, tool registration, event streaming |
| State bridge | `node:test` | Message serialization round-trips |
| Webview components | Vitest + React Testing Library | Rendering, user interactions, message handling |
| Integration | `@vscode/test-electron` | Full extension in Extension Development Host |

## Project Structure

```
codepi/
├── src/                        # Extension host (TypeScript)
│   ├── extension.ts            # Entry point, activation
│   ├── mcp/
│   │   ├── server.ts           # SSE/HTTP MCP server
│   │   ├── tools/
│   │   │   ├── read_file.ts
│   │   │   ├── write_file.ts
│   │   │   ├── edit.ts
│   │   │   ├── search.ts
│   │   │   ├── list_dir.ts
│   │   │   ├── terminal.ts
│   │   │   ├── diff.ts
│   │   │   └── open_file.ts
│   │   └── transport.ts        # SSE framing, JSON-RPC
│   ├── review/
│   │   ├── decoration-manager.ts  # Per-hunk decorations, CodeLens
│   │   └── hunk-tracker.ts        # Track pending/resolved hunks across files
│   ├── agent/
│   │   ├── runtime.ts          # createAgentSession wrapper
│   │   └── tool-registry.ts    # MCP → pi tool conversion
│   ├── bridge/
│   │   ├── protocol.ts         # Typed message types
│   │   └── relay.ts            # Event → postMessage bridge
│   └── utils/
│       └── port.ts             # Free port allocation
├── webview-ui/                 # React frontend
│   ├── src/
│   │   ├── App.tsx             # Root component
│   │   ├── components/
│   │   │   ├── ChatView.tsx
│   │   │   ├── MessageBubble.tsx
│   │   │   ├── ThinkingBlock.tsx
│   │   │   ├── ToolCallCard.tsx
│   │   │   ├── ModelPicker.tsx
│   │   │   ├── EditReviewBar.tsx      # Multi-file accept/reject all bar
│   │   │   ├── EditCard.tsx           # Per-file edit status in chat
│   │   │   ├── SessionSidebar.tsx
│   │   │   └── InputArea.tsx
│   │   ├── hooks/
│   │   │   ├── useVSCodeAPI.ts
│   │   │   └── useStreaming.ts
│   │   └── types.ts
│   ├── index.html
│   └── vite.config.ts
├── package.json
├── tsconfig.json
└── esbuild.mjs
```

## Implementation Phases

### Phase 1: Core Loop

- MCP server with `read_file`, `write_file`, `list_dir`, `search`
- Agent runtime with SDK, MCP tool discovery and registration
- State bridge with text streaming
- Webview chat UI with basic message display
- **Deliverable:** User can chat with pi, pi can read/write files through VSCode

### Phase 2: Inline Edit Review

- `edit` tool with decoration-based inline diffs (not direct file mutation)
- Per-hunk CodeLens [Accept]/[Reject] buttons
- File-level [Accept All]/[Reject All]
- Cross-file Edit Summary bar in chat panel
- Keyboard shortcuts for accept/reject hunk
- EditCard in chat showing per-file review status
- **Deliverable:** Copilot-style inline edit review — nothing applied until user approves

### Phase 3: Rich Tools

- `terminal` tool with output capture
- `open_file` and `diff` tools
- Tool call visualization in webview (expandable cards)
- **Deliverable:** Pi can run commands; user sees all tool activity in chat

### Phase 4: Full Experience

- Thinking block display
- Model picker and settings
- Session management (list, resume, fork)
- Markdown rendering in chat
- Extension/skill loading
- **Deliverable:** Feature-complete chat experience

### Phase 5: Polish

- File @-mention auto-complete from workspace
- VSCode theme integration (webview follows user's color theme)
- Error recovery and retry UX improvements
- Keyboard shortcut discoverability (cheat sheet)
- Testing suite (unit + integration)
- Package and publish to VSCode Marketplace
- **Deliverable:** Production-quality extension
