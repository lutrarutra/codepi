# Extensions & Tools Sidebar Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third "Extensions" tab to the CodePi sidebar that probes installed pi extensions (bundled, agent dir, project dir, npm packages) and renders a tree of their slash commands and tools, with Ask-mode read-only status chips.

**Architecture:** A webview tab (`codepi.extensions`) in the existing `codepi-sessions` sidebar container. The host probes extensions through the pi SDK's public loader APIs (`SettingsManager` + `DefaultResourceLoader`, the CLI's own startup path) without starting a session, builds a JSON-safe snapshot via pure functions in `src/extension-snapshot.ts`, and serves it to a thin React app in `webview-ui/src/extensions/` over a postMessage protocol.

**Tech Stack:** TypeScript, VS Code extension API (WebviewViewProvider), pi SDK (`@earendil-works/pi-coding-agent`), React 18 + Vite, vitest.

## Global Constraints

- `src/extension-snapshot.ts` must NOT import `vscode` or `@earendil-works/pi-coding-agent` statically — it must stay pure (unit-tested in vitest). SDK access happens only in `src/extensions-view.ts` (dynamic import).
- Probe uses public SDK APIs only: `SettingsManager.create(cwd, agentDir)`, `new DefaultResourceLoader({...})`, `loader.reload()`, `loader.getExtensions()`, `loader.getSkills()`, `loader.prompts`, and the exported `clearExtensionCache()` — never session internals (`_extensionRunner`).
- Snapshot must be JSON-safe: plain objects/arrays/strings/numbers only, maps → arrays, functions stripped.
- `askMode` precedence: settings whitelist wins → baseline → else `blocked`. Baseline MUST come from `ASK_MODE_DEFAULT_ALLOWED_TOOLS` in `src/pi-store.ts` (the existing mirror of `resources/extensions/codepi-modes.ts` — do not redefine).
- Whitelist read from `<agentDir>/settings.json` path `codepi.modes.ask.allowedTools`; malformed/missing → `[]` (fall back to baseline).
- Tab switching uses the existing `codepi.sidebarTab` context key. New view id `codepi.extensions`, command `codepi.openExtensionsTab`. Register with `{ webviewOptions: { retainContextWhenHidden: true } }`.
- Webview must not import across the vite root: `webview-ui/src/extensions/types.ts` is a manual mirror of `src/shared/extensions-protocol.ts` (same pattern as `webview-ui/src/settings/types.ts`).
- Vite entry: `webview-ui/extensions.html` → built as `assets/extensions.js` (entryFileNames `assets/[name].js`); CSS stays shared (`cssCodeSplit: false`).
- Extension files use `export default function (pi: ExtensionAPI) { ... }` (existing convention).
- Every task ends with a commit. Run the full suite (`npm test`, 307 tests currently) after each task.

---

### Task 1: Shared protocol types + webview mirror

**Files:**

- Create: `src/shared/extensions-protocol.ts`
- Create: `webview-ui/src/extensions/types.ts`
- Create: `src/__tests__/extensions-protocol.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `ExtensionsSnapshot`, `ExtensionEntry`, `CommandEntry`, `ToolEntry`, `SourceTag`, `AskMode`, `CommandSource`, `ModeInfo`, `ExtensionsMessage`, `ExtensionsReply` — used by every later task.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/extensions-protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type {
 ExtensionsMessage,
 ExtensionsReply,
 ExtensionsSnapshot,
} from "../shared/extensions-protocol";

describe("extensions protocol", () => {
 it("message union covers getSnapshot and refresh", () => {
  const msgs: ExtensionsMessage[] = [{ type: "getSnapshot" }, { type: "refresh" }];
  expect(msgs.map((m) => m.type)).toEqual(["getSnapshot", "refresh"]);
 });

 it("reply union covers snapshot and error", () => {
  const snapshot: ExtensionsSnapshot = {
   generatedAt: 0,
   cwd: "/cwd",
   agentDir: "/agent",
   mode: { active: false },
   askPolicy: { baseline: [], whitelisted: [] },
   extensions: [],
   core: { commands: [], tools: [] },
   loadErrors: [],
  };
  const replies: ExtensionsReply[] = [
   { type: "snapshot", snapshot },
   { type: "error", message: "boom" },
  ];
  expect(replies.map((r) => r.type)).toEqual(["snapshot", "error"]);
 });

 it("snapshot round-trips through JSON without losing fields", () => {
  const snapshot: ExtensionsSnapshot = {
   generatedAt: 1,
   cwd: "/cwd",
   agentDir: "/agent",
   mode: { active: true, current: "ask", sessionName: "s1" },
   askPolicy: { baseline: ["read"], whitelisted: ["web_search"] },
   extensions: [
    {
     displayName: "codepi-bash",
     path: "/b/codepi-bash.ts",
     source: "bundled",
     enabled: true,
     commands: [{ name: "codepi-bash-allow", source: "extension" }],
     tools: [{ name: "bash", label: "Bash", description: "d", askMode: "blocked" }],
     events: 2,
     flags: 0,
     shortcuts: 1,
     messageRenderers: 0,
    },
   ],
   core: {
    commands: [{ name: "help", description: "h", source: "extension" }],
    tools: [{ name: "read", label: "Read", description: "r", askMode: "safe" }],
   },
   loadErrors: [{ path: "/bad.ts", error: "x" }],
  };
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/extensions-protocol.test.ts`
Expected: FAIL — cannot find module `../shared/extensions-protocol`.

- [ ] **Step 3: Implement the protocol types**

Create `src/shared/extensions-protocol.ts`:

```ts
/** Message and data types for the Extensions sidebar tab (host ↔ webview). */

/** Where an extension (or its items) comes from. */
export type SourceTag = "bundled" | "agent" | "project" | "package" | "other";

/** Ask-mode read-only policy for a tool: blocked / read-only-safe / user-whitelisted. */
export type AskMode = "safe" | "whitelisted" | "blocked";

/** Slash-command origin. The probe only ever sees "extension" (skills and
 * prompt templates are enumerated into the core section separately), but the
 * field mirrors the SDK's SlashCommandInfo.source for future live data. */
export type CommandSource = "extension" | "skill" | "prompt";

export interface CommandEntry {
 name: string; // without the leading "/"
 description?: string;
 source: CommandSource;
}

export interface ToolEntry {
 name: string;
 label: string;
 description: string;
 askMode: AskMode;
}

export interface ExtensionEntry {
 displayName: string; // "codepi-bash" | "@juicesharp/rpiv-todo"
 path: string; // resolved path on disk
 source: SourceTag;
 enabled: boolean; // bundled → settings toggle; on-disk → true
 commands: CommandEntry[];
 tools: ToolEntry[];
 events: number;
 flags: number;
 shortcuts: number;
 messageRenderers: number;
}

export interface ModeInfo {
 active: boolean; // a pi session is running in a panel
 current?: "ask" | "plan" | "implement";
 sessionName?: string;
}

export interface ExtensionsSnapshot {
 generatedAt: number;
 cwd: string;
 agentDir: string;
 mode: ModeInfo;
 askPolicy: { baseline: string[]; whitelisted: string[] };
 extensions: ExtensionEntry[];
 core: { commands: CommandEntry[]; tools: ToolEntry[] };
 loadErrors: Array<{ path: string; error: string }>;
}

export type ExtensionsMessage = { type: "getSnapshot" } | { type: "refresh" };

export type ExtensionsReply =
 | { type: "snapshot"; snapshot: ExtensionsSnapshot }
 | { type: "error"; message: string };
```

Create the webview mirror `webview-ui/src/extensions/types.ts` — a verbatim copy of the protocol types (types only, no comments needed beyond the header):

```ts
/** Local mirror of src/shared/extensions-protocol.ts. */

export type SourceTag = "bundled" | "agent" | "project" | "package" | "other";
export type AskMode = "safe" | "whitelisted" | "blocked";
export type CommandSource = "extension" | "skill" | "prompt";

export interface CommandEntry {
 name: string;
 description?: string;
 source: CommandSource;
}

export interface ToolEntry {
 name: string;
 label: string;
 description: string;
 askMode: AskMode;
}

export interface ExtensionEntry {
 displayName: string;
 path: string;
 source: SourceTag;
 enabled: boolean;
 commands: CommandEntry[];
 tools: ToolEntry[];
 events: number;
 flags: number;
 shortcuts: number;
 messageRenderers: number;
}

export interface ModeInfo {
 active: boolean;
 current?: "ask" | "plan" | "implement";
 sessionName?: string;
}

export interface ExtensionsSnapshot {
 generatedAt: number;
 cwd: string;
 agentDir: string;
 mode: ModeInfo;
 askPolicy: { baseline: string[]; whitelisted: string[] };
 extensions: ExtensionEntry[];
 core: { commands: CommandEntry[]; tools: ToolEntry[] };
 loadErrors: Array<{ path: string; error: string }>;
}

export type ExtensionsMessage = { type: "getSnapshot" } | { type: "refresh" };

export type ExtensionsReply =
 | { type: "snapshot"; snapshot: ExtensionsSnapshot }
 | { type: "error"; message: string };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/extensions-protocol.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/extensions-protocol.ts webview-ui/src/extensions/types.ts src/__tests__/extensions-protocol.test.ts
git commit -m "feat: extensions tab protocol types (host + webview mirror)"
```

---

### Task 2: Pure snapshot builder

**Files:**

- Create: `src/extension-snapshot.ts`
- Create: `src/__tests__/extension-snapshot.test.ts`

**Interfaces:**

- Consumes: `ExtensionsSnapshot`, `ExtensionEntry`, `CommandEntry`, `ToolEntry`, `SourceTag`, `AskMode`, `ModeInfo` from `src/shared/extensions-protocol.ts` (Task 1); `ASK_MODE_DEFAULT_ALLOWED_TOOLS` from `./pi-store`.
- Produces (consumed by Task 3):
  - `classifySource(path: string, roots: SnapshotRoots): SourceTag`
  - `deriveDisplayName(path: string): string`
  - `computeAskMode(toolName: string, baseline: readonly string[], whitelist: ReadonlySet<string>): AskMode`
  - `modeFromSessionBranch(branch: readonly unknown[]): "ask" | "plan" | "implement" | undefined`
  - `readAskAllowedToolsFromSettings(settings: unknown): string[]`
  - `buildSnapshot(input: BuildSnapshotInput): ExtensionsSnapshot`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/extension-snapshot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
 buildSnapshot,
 classifySource,
 computeAskMode,
 deriveDisplayName,
 modeFromSessionBranch,
 readAskAllowedToolsFromSettings,
} from "../extension-snapshot";
import type { ExtensionsSnapshot } from "../shared/extensions-protocol";

const ROOTS = {
 bundledDir: "/ext/codepi/resources/extensions",
 agentDir: "/home/u/.pi/agent",
 cwd: "/proj/app",
};

const MINIMAL: ExtensionsSnapshot = {
 generatedAt: 0,
 cwd: ROOTS.cwd,
 agentDir: ROOTS.agentDir,
 mode: { active: false },
 askPolicy: { baseline: ["read"], whitelisted: [] },
 extensions: [],
 core: { commands: [], tools: [] },
 loadErrors: [],
};

describe("classifySource", () => {
 it("classifies bundled, agent, project, and package paths", () => {
  expect(classifySource("/ext/codepi/resources/extensions/codepi-bash.ts", ROOTS)).toBe("bundled");
  expect(classifySource("/home/u/.pi/agent/extensions/safety-guard.ts", ROOTS)).toBe("agent");
  expect(classifySource("/proj/app/.pi/extensions/team-ext/index.ts", ROOTS)).toBe("project");
  expect(classifySource("/home/u/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo/index.ts", ROOTS)).toBe("package");
  expect(classifySource("/elsewhere/foo.ts", ROOTS)).toBe("other");
 });
});

describe("deriveDisplayName", () => {
 it("strips extensions and resolves npm package names", () => {
  expect(deriveDisplayName("/x/codepi-bash.ts")).toBe("codepi-bash");
  expect(deriveDisplayName("/x/team-ext/index.ts")).toBe("team-ext");
  expect(deriveDisplayName("/home/u/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo/index.ts")).toBe("@juicesharp/rpiv-todo");
  expect(deriveDisplayName("/home/u/.pi/agent/npm/node_modules/plain-pkg/main.js")).toBe("plain-pkg");
 });
});

describe("computeAskMode", () => {
 const baseline = ["read", "grep"];
 it("marks whitelisted tools before baseline, then blocked", () => {
  expect(computeAskMode("web_search", baseline, new Set(["web_search"]))).toBe("whitelisted");
  expect(computeAskMode("read", baseline, new Set(["read"]))).toBe("whitelisted"); // whitelist wins
  expect(computeAskMode("read", baseline, new Set())).toBe("safe");
  expect(computeAskMode("bash", baseline, new Set())).toBe("blocked");
 });
});

describe("modeFromSessionBranch", () => {
 it("reads the latest codepi-modes:mode entry", () => {
  const branch = [
   { type: "custom", customType: "codepi-modes:mode", data: { mode: "ask" } },
   { type: "message", message: { role: "user" } },
   { type: "custom", customType: "codepi-modes:mode", data: { mode: "implement" } },
  ];
  expect(modeFromSessionBranch(branch)).toBe("implement");
  expect(modeFromSessionBranch([{ type: "custom", customType: "codepi-bash:mode", data: { mode: "auto" } }])).toBeUndefined();
  expect(modeFromSessionBranch([{ type: "message", message: { role: "user" } }])).toBeUndefined();
 });
});

describe("readAskAllowedToolsFromSettings", () => {
 it("reads codepi.modes.ask.allowedTools defensively", () => {
  expect(readAskAllowedToolsFromSettings({ codepi: { modes: { ask: { allowedTools: ["web_search"] } } } })).toEqual(["web_search"]);
  expect(readAskAllowedToolsFromSettings({ codepi: {} })).toEqual([]);
  expect(readAskAllowedToolsFromSettings({ codepi: { modes: { ask: { allowedTools: "nope" } } } })).toEqual([]);
  expect(readAskAllowedToolsFromSettings(null)).toEqual([]);
 });
});

describe("buildSnapshot", () => {
 it("maps extensions, core, chips, enabled flags, and load errors", () => {
  const snapshot = buildSnapshot({
   ...ROOTS,
   settings: { codepi: { modes: { ask: { allowedTools: ["web_search"] } } } },
   mode: { active: true, current: "ask", sessionName: "s1" },
   extensions: [
    {
     resolvedPath: "/ext/codepi/resources/extensions/codepi-bash.ts",
     commands: new Map([["codepi-bash-allow", { name: "codepi-bash-allow", description: "Set mode" }]]),
     tools: new Map([["bash", { definition: { name: "bash", label: "Bash", description: "Run a command" } }]]),
     flags: new Map(),
     shortcuts: new Map([["ctrl+r", {}]]),
     handlers: new Map([["tool_call", [() => {}]], ["input", [() => {}]]]),
     messageRenderers: new Map(),
    },
    {
     resolvedPath: "/home/u/.pi/agent/extensions/safety-guard.ts",
     commands: new Map(),
     tools: new Map([["edit", { definition: { name: "edit", label: "Edit", description: "Edit file" } }]]),
     flags: new Map(), shortcuts: new Map(), handlers: new Map(), messageRenderers: new Map(),
    },
   ],
   loadErrors: [{ path: "/home/u/.pi/agent/extensions/broken.ts", error: "SyntaxError: x" }],
   coreCommands: [
    { name: "help", description: "Show help", source: "extension" },
    { name: "skill:diagnose", description: "Diagnose", source: "skill" },
   ],
   coreTools: [
    { name: "read", label: "Read", description: "Read a file" },
    { name: "bash", label: "Bash", description: "Run" },
   ],
  });

  expect(snapshot.mode).toEqual({ active: true, current: "ask", sessionName: "s1" });
  expect(snapshot.askPolicy.whitelisted).toEqual(["web_search"]);

  const [bashExt, guardExt] = snapshot.extensions;
  expect(bashExt.displayName).toBe("codepi-bash");
  expect(bashExt.source).toBe("bundled");
  expect(bashExt.enabled).toBe(true);
  expect(bashExt.commands).toEqual([
   { name: "codepi-bash-allow", description: "Set mode", source: "extension" },
  ]);
  expect(bashExt.tools).toEqual([
   { name: "bash", label: "Bash", description: "Run a command", askMode: "blocked" },
  ]);
  expect(bashExt.events).toBe(2);
  expect(bashExt.shortcuts).toBe(1);
  expect(bashExt.flags).toBe(0);
  expect(bashExt.messageRenderers).toBe(0);

  expect(guardExt.source).toBe("agent");
  expect(guardExt.tools[0].askMode).toBe("blocked"); // edit is not read-only

  expect(snapshot.core.commands).toEqual([
   { name: "help", description: "Show help", source: "extension" },
   { name: "skill:diagnose", description: "Diagnose", source: "skill" },
  ]);
  expect(snapshot.core.tools).toEqual([
   { name: "read", label: "Read", description: "Read a file", askMode: "safe" },
   { name: "bash", label: "Bash", description: "Run", askMode: "blocked" },
  ]);
  expect(snapshot.loadErrors).toEqual([
   { path: "/home/u/.pi/agent/extensions/broken.ts", error: "SyntaxError: x" },
  ]);
 });

 it("honors the bundled settings toggle for enabled", () => {
  const snapshot = buildSnapshot({
   ...ROOTS,
   settings: { codepi: { bundledExtensions: { "codepi-bash": false } } },
   mode: { active: false },
   extensions: [
    {
     resolvedPath: "/ext/codepi/resources/extensions/codepi-bash.ts",
     commands: new Map(), tools: new Map(),
     flags: new Map(), shortcuts: new Map(), handlers: new Map(), messageRenderers: new Map(),
    },
   ],
   loadErrors: [],
   coreCommands: [],
   coreTools: [],
  });
  expect(snapshot.extensions[0].enabled).toBe(false);
 });

 it("produces a JSON-safe snapshot", () => {
  const snapshot = buildSnapshot({
   ...ROOTS,
   settings: {},
   mode: { active: false },
   extensions: [
    {
     resolvedPath: "/ext/codepi/resources/extensions/codepi-footer.ts",
     commands: new Map(), tools: new Map(),
     flags: new Map(), shortcuts: new Map(), handlers: new Map(), messageRenderers: new Map(),
    },
   ],
   loadErrors: [],
   coreCommands: [],
   coreTools: [],
  });
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/extension-snapshot.test.ts`
Expected: FAIL — cannot find module `../extension-snapshot`.

- [ ] **Step 3: Implement the builder**

Create `src/extension-snapshot.ts`:

```ts
/** Pure snapshot construction for the Extensions sidebar tab.
 *
 * This module must stay free of `vscode` imports and static SDK imports so it
 * can be unit-tested in vitest. The probe (extensions-view.ts) supplies raw
 * loader objects; everything here is deterministic functions. */
import { basename } from "node:path";
import { ASK_MODE_DEFAULT_ALLOWED_TOOLS } from "./pi-store";
import type {
 AskMode,
 CommandEntry,
 CommandSource,
 ExtensionEntry,
 ExtensionsSnapshot,
 ModeInfo,
 SourceTag,
 ToolEntry,
} from "./shared/extensions-protocol";

/** Settings path for the Ask-mode whitelist: codepi.modes.ask.allowedTools. */
export const ASK_ALLOWED_TOOLS_KEY = ["codepi", "modes", "ask", "allowedTools"];

/** Rich view of a loaded SDK extension as the probe sees it. */
export interface LoadedExtensionRich {
 resolvedPath?: string;
 path?: string;
 commands?: Map<string, { name?: string; description?: string }>;
 tools?: Map<string, { definition?: { name?: string; label?: string; description?: string } }>;
 flags?: Map<string, unknown>;
 shortcuts?: Map<string, unknown>;
 handlers?: Map<string, unknown>;
 messageRenderers?: Map<string, unknown>;
}

export interface SnapshotRoots {
 bundledDir: string;
 agentDir: string;
 cwd: string;
}

export interface BuildSnapshotInput extends SnapshotRoots {
 settings: unknown;
 mode: ModeInfo;
 extensions: LoadedExtensionRich[];
 loadErrors: Array<{ path: string; error: string }>;
 coreCommands: CommandEntry[];
 /** Raw tool definitions (name/label/description); askMode is computed here. */
 coreTools: Array<{ name?: string; label?: string; description?: string }>;
 generatedAt?: number;
}

function normalize(p: string): string {
 return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Classify an extension path into a SourceTag. Pure path prefix logic. */
export function classifySource(path: string, roots: SnapshotRoots): SourceTag {
 const p = normalize(path);
 const under = (root: string): boolean => {
  const r = normalize(root);
  if (!r) return false;
  return p === r || p.startsWith(r.endsWith("/") ? r : r + "/");
 };
 if (roots.bundledDir && under(roots.bundledDir)) return "bundled";
 if (under(normalize(roots.agentDir) + "/extensions")) return "agent";
 if (under(normalize(roots.cwd) + "/.pi/extensions")) return "project";
 if (p.includes("/node_modules/")) return "package";
 return "other";
}

/** "codepi-bash.ts" → "codepi-bash"; npm package paths → "@scope/name". */
export function deriveDisplayName(path: string): string {
 const p = normalize(path);
 const base = basename(p).replace(/\.(ts|js|mjs|cjs)$/i, "");
 const nm = p.lastIndexOf("/node_modules/");
 if (nm !== -1) {
  const rest = p.slice(nm + "/node_modules/".length);
  const parts = rest.split("/");
  if (parts[0]?.startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0] ?? base;
 }
 // Subdirectory extensions (dir/index.ts) display as the directory name.
 if (base === "index") {
  const slash = p.lastIndexOf("/");
  if (slash > 0) {
   const parent = p.slice(0, slash).split("/").pop();
   if (parent) return parent;
  }
 }
 return base;
}

/** Ask-mode policy: explicit whitelist wins, then baseline, else blocked. */
export function computeAskMode(
 toolName: string,
 baseline: readonly string[],
 whitelist: ReadonlySet<string>,
): AskMode {
 if (whitelist.has(toolName)) return "whitelisted";
 if (baseline.includes(toolName)) return "safe";
 return "blocked";
}

/** Latest mode from session-branch custom entries (codepi-modes:mode). */
export function modeFromSessionBranch(
 branch: readonly unknown[],
): "ask" | "plan" | "implement" | undefined {
 let mode: "ask" | "plan" | "implement" | undefined;
 for (const entry of branch) {
  if (!entry || typeof entry !== "object") continue;
  const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
  if (e.type !== "custom" || e.customType !== "codepi-modes:mode") continue;
  const data = (e.data ?? {}) as { mode?: unknown };
  if (data.mode === "ask" || data.mode === "plan" || data.mode === "implement") {
   mode = data.mode;
  }
 }
 return mode;
}

/** Read codepi.modes.ask.allowedTools from a settings object. Defensive. */
export function readAskAllowedToolsFromSettings(settings: unknown): string[] {
 let value: unknown = settings;
 for (const key of ASK_ALLOWED_TOOLS_KEY) {
  if (value === null || typeof value !== "object") return [];
  value = (value as Record<string, unknown>)[key];
 }
 if (!Array.isArray(value)) return [];
 return value.filter((v): v is string => typeof v === "string");
}

function isRecord(v: unknown): v is Record<string, unknown> {
 return v !== null && typeof v === "object" && !Array.isArray(v);
}

function commandEntry(
 name: string,
 reg: { name?: string; description?: string } | undefined,
): CommandEntry {
 return {
  name: reg?.name ?? name,
  ...(reg?.description ? { description: reg.description } : {}),
  source: "extension" as CommandSource,
 };
}

function toolEntry(
 name: string,
 def: { name?: string; label?: string; description?: string } | undefined,
 baseline: readonly string[],
 whitelist: ReadonlySet<string>,
): ToolEntry {
 const toolName = def?.name ?? name;
 return {
  name: toolName,
  label: def?.label ?? toolName,
  description: def?.description ?? "",
  askMode: computeAskMode(toolName, baseline, whitelist),
 };
}

/** Build the full JSON-safe snapshot. */
export function buildSnapshot(input: BuildSnapshotInput): ExtensionsSnapshot {
 const baseline = [...ASK_MODE_DEFAULT_ALLOWED_TOOLS];
 const whitelisted = readAskAllowedToolsFromSettings(input.settings);
 const whitelist = new Set(whitelisted);
 const roots: SnapshotRoots = {
  bundledDir: input.bundledDir,
  agentDir: input.agentDir,
  cwd: input.cwd,
 };
 // Bundled toggles: codepi.bundledExtensions.<id> — id matches displayName
 // for bundled extensions (codepi-footer, codepi-diff, codepi-modes,
 // codepi-bash, codepi-context).
 let bundledConfig: Record<string, unknown> = {};
 const s = isRecord(input.settings) ? input.settings : {};
 const codepi = isRecord(s.codepi) ? s.codepi : {};
 const bundledExt = isRecord(codepi.bundledExtensions) ? codepi.bundledExtensions : {};
 bundledConfig = bundledExt;

 const extensions: ExtensionEntry[] = input.extensions.map((ext) => {
  const path = ext.resolvedPath ?? ext.path ?? "";
  const commands: CommandEntry[] = [];
  for (const [name, reg] of ext.commands ?? []) commands.push(commandEntry(name, reg));
  const tools: ToolEntry[] = [];
  for (const [name, tool] of ext.tools ?? []) {
   tools.push(toolEntry(name, tool?.definition, baseline, whitelist));
  }
  const source = classifySource(path, roots);
  const enabled = source !== "bundled" || bundledConfig[deriveDisplayName(path)] !== false;
  return {
   displayName: deriveDisplayName(path),
   path,
   source,
   enabled,
   commands,
   tools,
   events: ext.handlers?.size ?? 0,
   flags: ext.flags?.size ?? 0,
   shortcuts: ext.shortcuts?.size ?? 0,
   messageRenderers: ext.messageRenderers?.size ?? 0,
  };
 });

 const coreTools: ToolEntry[] = input.coreTools.map((def) =>
  toolEntry(def?.name ?? "?", def, baseline, whitelist),
 );

 return {
  generatedAt: input.generatedAt ?? Date.now(),
  cwd: input.cwd,
  agentDir: input.agentDir,
  mode: input.mode,
  askPolicy: { baseline, whitelisted },
  extensions,
  core: { commands: input.coreCommands, tools: coreTools },
  loadErrors: input.loadErrors,
 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/extension-snapshot.test.ts`
Expected: PASS (6 describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/extension-snapshot.ts src/__tests__/extension-snapshot.test.ts
git commit -m "feat: pure extensions snapshot builder with ask-mode policy"
```

---

### Task 3: Probe + view provider + registration

**Files:**

- Create: `src/extensions-view.ts`
- Modify: `src/extension.ts` (register provider + `codepi.openExtensionsTab` command; add `getModeInfoFromSessions` helper)
- Modify: `package.json` (view + command contribution)
- Create: `src/__tests__/extensions-probe.test.ts`

**Interfaces:**

- Consumes: `buildSnapshot`, `modeFromSessionBranch`, `LoadedExtensionRich` (Task 2); `ExtensionsMessage`, `ExtensionsReply`, `ExtensionsSnapshot`, `ModeInfo` (Task 1); `buildCurrentPiRuntimeResourcePaths`, `buildPiResourceLoaderOptions`, `filterConflictingExtensions` from `./pi-runtime-config`; `getVscodeTools` from `./tools`; `readJsonFile`, `getCanonicalAgentDir`, `getSettingsPath` from `./pi-store`.
- Produces: `probeExtensions(opts: ProbeOptions): Promise<ProbeResult>`; `ExtensionsViewProvider` class (viewType `"codepi.extensions"`); view contribution `codepi.extensions` (when `codepi.sidebarTab == extensions`); command `codepi.openExtensionsTab`.

- [ ] **Step 1: Write the failing probe integration test**

Create `src/__tests__/extensions-probe.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeExtensions } from "../extensions-view";

const FAKE_EXT = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
 pi.registerCommand("fake-hello", {
  description: "A fixture command",
  handler: async () => {},
 });
 pi.registerTool({
  name: "fake_tool",
  label: "Fake Tool",
  description: "A fixture tool",
  parameters: {},
  execute: async () => ({ content: [] }),
 });
}
`;

describe("probeExtensions", () => {
 it("loads a fixture extension from the agent dir with its command and tool", async () => {
  const dir = join(tmpdir(), "codepi-probe-test-" + process.pid + "-" + Date.now());
  const extDir = join(dir, "extensions");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, "fake-ext.ts"), FAKE_EXT);
  try {
   const result = await probeExtensions({
    cwd: dir,
    agentDir: dir,
    extensionResourcesDir: join(dir, "bundled"),
    readSettings: () => ({}),
   });
   const ext = result.extensions.find((e) => (e.resolvedPath ?? e.path).endsWith("fake-ext.ts"));
   expect(ext).toBeDefined();
   const commands = ext?.commands ? [...ext.commands.keys()] : [];
   const tools = ext?.tools ? [...ext.tools.keys()] : [];
   expect(commands).toContain("fake-hello");
   expect(tools).toContain("fake_tool");
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/extensions-probe.test.ts`
Expected: FAIL — cannot find module `../extensions-view`.

- [ ] **Step 3: Implement the provider with the probe**

Create `src/extensions-view.ts`:

```ts
import * as vscode from "vscode";
import { existsSync } from "node:fs";
import {
 buildCurrentPiRuntimeResourcePaths,
 buildPiResourceLoaderOptions,
 filterConflictingExtensions,
} from "./pi-runtime-config";
import { getCanonicalAgentDir, getSettingsPath, readJsonFile } from "./pi-store";
import { buildSnapshot, type LoadedExtensionRich } from "./extension-snapshot";
import type {
 ExtensionsMessage,
 ExtensionsReply,
 ExtensionsSnapshot,
 ModeInfo,
} from "./shared/extensions-protocol";
import { getVscodeTools } from "./tools";

let sdkPromise: Promise<typeof import("@earendil-works/pi-coding-agent")> | undefined;
function getSdk(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
 if (!sdkPromise) sdkPromise = import("@earendil-works/pi-coding-agent");
 return sdkPromise;
}

export interface ProbeOptions {
 cwd: string;
 agentDir: string;
 extensionResourcesDir: string;
 readSettings: () => unknown;
}

export interface ProbeResult {
 extensions: LoadedExtensionRich[];
 loadErrors: Array<{ path: string; error: string }>;
 skills: Array<{ name: string; description?: string }>;
 prompts: Array<{ name: string; description?: string }>;
}

/**
 * Load extensions exactly like a fresh session would (same loader options,
 * same bundled-path construction, same conflict filtering) but WITHOUT
 * creating a session. Uses public SDK loader APIs only.
 */
export async function probeExtensions(opts: ProbeOptions): Promise<ProbeResult> {
 const pi = await getSdk();
 const settingsManager = pi.SettingsManager.create(opts.cwd, opts.agentDir);
 const settings = opts.readSettings();
 const resourcePaths = buildCurrentPiRuntimeResourcePaths(
  opts.extensionResourcesDir,
  opts.agentDir,
  opts.readSettings,
 );
 const bundledExtensions = resourcePaths.bundledExtensionPaths.filter((p: string) =>
  existsSync(p),
 );
 // The runtime factory also appends the rpiv-todo package extension when
 // present — mirror it so the probe shows exactly what a session loads.
 if (existsSync(resourcePaths.rpivTodoPath)) {
  bundledExtensions.push(resourcePaths.rpivTodoPath);
 }
 const bundledThemes = resourcePaths.bundledThemePaths.filter((p: string) =>
  existsSync(p),
 );
 const loader = new pi.DefaultResourceLoader({
  ...buildPiResourceLoaderOptions(opts.cwd, opts.agentDir, {
   ...resourcePaths,
   bundledExtensionPaths: bundledExtensions,
   bundledThemePaths: bundledThemes,
  }),
  settingsManager,
  extensionsOverride: (base: unknown) => {
   const b = base as {
    extensions?: LoadedExtensionRich[];
    errors?: Array<{ path?: string }>;
   };
   const { extensions, droppedPaths } = filterConflictingExtensions(
    b.extensions ?? [],
    bundledExtensions,
   );
   const dropped = new Set(droppedPaths);
   return {
    ...b,
    extensions,
    errors: (b.errors ?? []).filter((error) => !dropped.has(error?.path ?? "")),
   };
  },
 });
 await loader.reload();
 const result = loader.getExtensions();
 const loaderAny = loader as unknown as {
  getSkills?: () => Array<{ name?: string; description?: string }>;
  prompts?: Array<{ name?: string; description?: string }>;
 };
 let skills: ProbeResult["skills"] = [];
 try {
  skills = (loaderAny.getSkills?.() ?? []).map((s) => ({
   name: s.name ?? "?",
   ...(s.description ? { description: s.description } : {}),
  }));
 } catch {
  skills = [];
 }
 let prompts: ProbeResult["prompts"] = [];
 try {
  prompts = (loaderAny.prompts ?? []).map((p) => ({
   name: p.name ?? "?",
   ...(p.description ? { description: p.description } : {}),
  }));
 } catch {
  prompts = [];
 }
 return {
  extensions: (result.extensions ?? []) as LoadedExtensionRich[],
  loadErrors: (result.errors ?? []).map((e) => ({
   path: e.path ?? "?",
   error: e.error ?? String(e),
  })),
  skills,
  prompts,
 };
}

export class ExtensionsViewProvider implements vscode.WebviewViewProvider {
 public static readonly viewType = "codepi.extensions";
 private view: vscode.WebviewView | undefined;
 private snapshot: ExtensionsSnapshot | undefined;

 constructor(
  private readonly extensionUri: vscode.Uri,
  private readonly getModeInfo: () => ModeInfo,
  private readonly getCwd: () => string,
  private readonly agentDir = getCanonicalAgentDir(),
 ) {}

 resolveWebviewView(webviewView: vscode.WebviewView): void {
  this.view = webviewView;
  webviewView.webview.options = {
   enableScripts: true,
   localResourceRoots: [
    vscode.Uri.joinPath(this.extensionUri, "webview-ui", "dist"),
   ],
  };
  webviewView.webview.html = buildExtensionsHtml(this.extensionUri, webviewView.webview);
  webviewView.webview.onDidReceiveMessage((msg: ExtensionsMessage) => {
   void this.handleMessage(msg);
  });
 }

 private async handleMessage(msg: ExtensionsMessage): Promise<void> {
  try {
   if (msg.type === "refresh") {
    const sdk = await getSdk();
    sdk.clearExtensionCache();
    this.snapshot = undefined;
   }
   if (msg.type === "getSnapshot" || msg.type === "refresh") {
    this.snapshot ??= await this.build();
    this.post({ type: "snapshot", snapshot: this.snapshot });
   }
  } catch (err) {
   this.post({
    type: "error",
    message: err instanceof Error ? err.message : String(err),
   });
  }
 }

 private async build(): Promise<ExtensionsSnapshot> {
  const sdk = await getSdk();
  const cwd = this.getCwd();
  const agentDir = this.agentDir;
  const extensionDir = vscode.Uri.joinPath(
   this.extensionUri,
   "resources",
   "extensions",
  ).fsPath;
  const probe = await probeExtensions({
   cwd,
   agentDir,
   extensionResourcesDir: extensionDir,
   readSettings: () => readJsonFile(getSettingsPath()) ?? {},
  });
  const coreTools = [
   ...sdk.createCodingToolDefinitions(cwd),
   ...getVscodeTools(),
  ];
  return buildSnapshot({
   bundledDir: extensionDir,
   agentDir,
   cwd,
   settings: readJsonFile(getSettingsPath()) ?? {},
   mode: this.getModeInfo(),
   extensions: probe.extensions,
   loadErrors: probe.loadErrors,
   coreCommands: [
    ...sdk.BUILTIN_SLASH_COMMANDS.map((c: { name: string; description: string }) => ({
     name: c.name,
     description: c.description,
     source: "extension" as const,
    })),
    ...probe.skills.map((s) => ({
     name: `skill:${s.name}`,
     ...(s.description ? { description: s.description } : {}),
     source: "skill" as const,
    })),
    ...probe.prompts.map((p) => ({
     name: p.name,
     ...(p.description ? { description: p.description } : {}),
     source: "prompt" as const,
    })),
   ],
   coreTools: coreTools as Array<{ name?: string; label?: string; description?: string }>,
  });
 }

 private post(msg: ExtensionsReply): void {
  this.view?.webview.postMessage(msg);
 }
}

function buildExtensionsHtml(extensionUri: vscode.Uri, webview: vscode.Webview): string {
 const distUri = vscode.Uri.joinPath(extensionUri, "webview-ui", "dist");
 const scriptUri = webview.asWebviewUri(
  vscode.Uri.joinPath(distUri, "assets", "extensions.js"),
 );
 const styleUri = webview.asWebviewUri(
  vscode.Uri.joinPath(distUri, "assets", "index.css"),
 );
 const nonce = getNonce();
 return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" crossorigin href="${styleUri}" />
  <title>CodePi Extensions</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" crossorigin nonce="${nonce}" src="${scriptUri}"></script>
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
```

- [ ] **Step 4: Register the provider, command, and view**

In `src/extension.ts`, add the import:

```ts
import { ExtensionsViewProvider, probeExtensions } from "./extensions-view";
```

(If the biome linter flags the unused `probeExtensions` import, import only `ExtensionsViewProvider` — the probe test imports from `extensions-view.ts` directly. Prefer: `import { ExtensionsViewProvider } from "./extensions-view";`)

Add the mode-info helper next to the existing sidebar registration (near the `codepi.openSettingsTab` command registration, ~line 376):

```ts
/** Live mode chip data: the visible panel's session, else any session. */
function getModeInfoFromSessions(): ModeInfo {
 const pick = (state: SessionState): ModeInfo => {
  try {
   const branch: readonly unknown[] = state.sessionManager?.getBranch?.() ?? [];
   return {
    active: true,
    current: modeFromSessionBranch(branch),
    sessionName: state.sessionManager?.getSessionName?.(),
   };
  } catch {
   return { active: true };
  }
 };
 for (const state of sessions.values()) {
  if (state.panel.visible) return pick(state);
 }
 const first = sessions.values().next().value;
 return first ? pick(first) : { active: false };
}
```

Add imports for `modeFromSessionBranch` (from `./extension-snapshot`) and `ModeInfo` (from `./shared/extensions-protocol`) to `src/extension.ts`.

In the same block that registers `SettingsViewProvider` (inside `activate`, ~line 376), add:

```ts
 // Extensions sidebar tab (toggled with Sessions/Settings via codepi.sidebarTab)
 context.subscriptions.push(
  vscode.window.registerWebviewViewProvider(
   ExtensionsViewProvider.viewType,
   new ExtensionsViewProvider(
    context.extensionUri,
    getModeInfoFromSessions,
    getWorkspaceRoot,
   ),
   { webviewOptions: { retainContextWhenHidden: true } },
  ),
  vscode.commands.registerCommand("codepi.openExtensionsTab", () =>
   vscode.commands.executeCommand(
    "setContext",
    "codepi.sidebarTab",
    "extensions",
   ),
  ),
 );
```

In `package.json` `contributes.views["codepi-sessions"]`, add after the settings entry:

```json
   {
    "id": "codepi.extensions",
    "name": "Extensions",
    "type": "webview",
    "when": "codepi.sidebarTab == extensions"
   },
```

In `package.json` `contributes.commands`, add:

```json
   {
    "command": "codepi.openExtensionsTab",
    "title": "CodePi: Open Extensions"
   },
```

- [ ] **Step 5: Run the probe test, then the full suite**

Run: `npx vitest run src/__tests__/extensions-probe.test.ts`
Expected: PASS.

Run: `npx vitest run src/__tests__/extension-snapshot.test.ts src/__tests__/extensions-probe.test.ts`
Expected: PASS.

Run: `npm run check-types` (from the repo root — `tsc --noEmit` if no such script exists, run `npx tsc --noEmit`)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/extensions-view.ts src/extension.ts package.json src/__tests__/extensions-probe.test.ts
git commit -m "feat: extensions sidebar tab provider, probe, and registration"
```

---

### Task 4: Webview React app

**Files:**

- Create: `webview-ui/extensions.html`
- Create: `webview-ui/src/extensions/main.tsx`
- Create: `webview-ui/src/extensions/App.tsx`
- Create: `webview-ui/src/extensions/SnapshotTree.tsx`
- Create: `webview-ui/src/extensions/extensions.css`
- Modify: `webview-ui/vite.config.ts` (add input entry)
- Modify: `webview-ui/src/settings/types.ts` — no change; `webview-ui/src/extensions/types.ts` already exists from Task 1.

**Interfaces:**

- Consumes: `ExtensionsSnapshot`, `ExtensionsMessage`, `ExtensionsReply`, `AskMode`, `SourceTag` from `webview-ui/src/extensions/types.ts` (Task 1); `ExtensionsViewProvider` postMessage replies (Task 3).
- Produces: `assets/extensions.js` + shared `assets/index.css` in `webview-ui/dist`.

- [ ] **Step 1: Create the HTML entry**

Create `webview-ui/extensions.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CodePi Extensions</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/extensions/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create the React app**

Create `webview-ui/src/extensions/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { ExtensionsApp } from "./App";
import "./extensions.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
 <React.StrictMode>
  <ExtensionsApp />
 </React.StrictMode>,
);
```

Create `webview-ui/src/extensions/App.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { SnapshotTree } from "./SnapshotTree";
import type { ExtensionsMessage, ExtensionsReply, ExtensionsSnapshot } from "./types";

declare global {
 interface Window {
  acquireVsCodeApi(): { postMessage(msg: unknown): void };
 }
}

const vscode = window.acquireVsCodeApi();

function modeLabel(snapshot: ExtensionsSnapshot): { text: string; tone: string } {
 const { mode } = snapshot;
 if (!mode.active) return { text: "No active session — showing policy", tone: "dim" };
 switch (mode.current) {
  case "ask":
   return { text: "Ask mode active — 🔒 tools are blocked", tone: "warning" };
  case "plan":
   return { text: "Plan mode active — no read-only restriction", tone: "ok" };
  case "implement":
   return { text: "Implement mode active — no read-only restriction", tone: "ok" };
  default:
   return { text: "Session active — mode unknown", tone: "dim" };
 }
}

export function ExtensionsApp() {
 const [snapshot, setSnapshot] = useState<ExtensionsSnapshot | undefined>();
 const [error, setError] = useState<string | undefined>();
 const [query, setQuery] = useState("");
 const [busy, setBusy] = useState(true);

 useEffect(() => {
  const listener = (event: MessageEvent<ExtensionsReply>) => {
   const msg = event.data;
   if (msg.type === "snapshot") {
    setSnapshot(msg.snapshot);
    setError(undefined);
   } else if (msg.type === "error") {
    setError(msg.message);
   }
   setBusy(false);
  };
  window.addEventListener("message", listener);
  vscode.postMessage({ type: "getSnapshot" } satisfies ExtensionsMessage);
  return () => window.removeEventListener("message", listener);
 }, []);

 const refresh = useCallback(() => {
  setBusy(true);
  vscode.postMessage({ type: "refresh" } satisfies ExtensionsMessage);
 }, []);

 const header = snapshot ? modeLabel(snapshot) : { text: "", tone: "dim" };

 return (
  <div className="ext-root">
   {snapshot && (
    <div className="ext-header">
     <div className={`ext-mode ext-mode-${header.tone}`}>{header.text}</div>
     <div className="ext-legend">
      <span className="chip chip-safe">✓ read-only safe</span>
      <span className="chip chip-whitelisted">★ whitelisted (user)</span>
      <span className="chip chip-blocked">🔒 blocked in Ask mode</span>
     </div>
     <div className="ext-controls">
      <input
       className="ext-search"
       type="text"
       placeholder="Search extensions, commands, tools…"
       value={query}
       onChange={(e) => setQuery(e.target.value)}
      />
      <button className="ext-refresh" onClick={refresh} disabled={busy}>
       {busy ? "Scanning…" : "↻ Refresh"}
      </button>
     </div>
     <div className="ext-meta">
      Scanned {new Date(snapshot.generatedAt).toLocaleTimeString()} ·{" "}
      {snapshot.loadErrors.length > 0
       ? `${snapshot.loadErrors.length} load error(s)`
       : "no load errors"}
     </div>
    </div>
   )}
   {error && (
    <div className="ext-error">
     <span>{error}</span>
     <button onClick={refresh}>Retry</button>
    </div>
   )}
   {busy && !snapshot && <div className="ext-busy">Scanning extensions…</div>}
   {snapshot && (
    <SnapshotTree snapshot={snapshot} query={query.trim().toLowerCase()} />
   )}
  </div>
 );
}
```

Create `webview-ui/src/extensions/SnapshotTree.tsx`:

```tsx
import { useMemo } from "react";
import type {
 CommandEntry,
 ExtensionEntry,
 ExtensionsSnapshot,
 ToolEntry,
} from "./types";

function AskChip({ askMode }: { askMode: ToolEntry["askMode"] }) {
 switch (askMode) {
  case "safe":
   return <span className="chip chip-safe">✓ read-only safe</span>;
  case "whitelisted":
   return <span className="chip chip-whitelisted">★ whitelisted</span>;
  case "blocked":
   return <span className="chip chip-blocked">🔒 blocked in Ask</span>;
 }
}

function CommandRow({ cmd }: { cmd: CommandEntry }) {
 return (
  <div className="row">
   <span className="cmd-name">/{cmd.name}</span>
   {cmd.description && <span className="row-desc">{cmd.description}</span>}
   {cmd.source !== "extension" && (
    <span className={`tag tag-${cmd.source}`}>{cmd.source}</span>
   )}
  </div>
 );
}

function ToolRow({ tool }: { tool: ToolEntry }) {
 return (
  <div className="row">
   <span className="tool-name">{tool.name}</span>
   {tool.label && tool.label !== tool.name && (
    <span className="row-desc">{tool.label}</span>
   )}
   <AskChip askMode={tool.askMode} />
  </div>
 );
}

function Card({
 title,
 badge,
 disabled,
 commands,
 tools,
 meta,
}: {
 title: string;
 badge: string;
 disabled?: boolean;
 commands: CommandEntry[];
 tools: ToolEntry[];
 meta?: string;
}) {
 return (
  <div className={`card${disabled ? " card-disabled" : ""}`}>
   <div className="card-title">
    <span className="card-name">{title}</span>
    <span className="badge">{badge}</span>
    {disabled && <span className="tag tag-disabled">disabled in settings</span>}
   </div>
   {commands.length > 0 && (
    <div className="group">
     <div className="group-label">Commands</div>
     {commands.map((cmd) => (
      <CommandRow key={cmd.name} cmd={cmd} />
     ))}
    </div>
   )}
   {tools.length > 0 && (
    <div className="group">
     <div className="group-label">Tools</div>
     {tools.map((tool) => (
      <ToolRow key={tool.name} tool={tool} />
     ))}
    </div>
   )}
   {commands.length === 0 && tools.length === 0 && (
    <div className="row-desc">no commands or tools</div>
   )}
   {meta && <div className="card-meta">{meta}</div>}
  </div>
 );
}

function matches(entry: ExtensionEntry, query: string): boolean {
 if (!query) return true;
 const hay = [
  entry.displayName,
  ...entry.commands.map((c) => c.name),
  ...entry.tools.map((t) => t.name),
  ...entry.tools.map((t) => t.label),
 ]
  .join(" ")
  .toLowerCase();
 return hay.includes(query);
}

export function SnapshotTree({
 snapshot,
 query,
}: {
 snapshot: ExtensionsSnapshot;
 query: string;
}) {
 const filtered = useMemo(
  () => snapshot.extensions.filter((e) => matches(e, query)),
  [snapshot, query],
 );
 const coreVisible = !query || matchesCore(snapshot, query);

 return (
  <div className="ext-tree">
   {filtered.map((entry) => (
    <Card
     key={entry.path}
     title={entry.displayName}
     badge={entry.source}
     disabled={!entry.enabled}
     commands={entry.commands}
     tools={entry.tools}
     meta={`${entry.events} events · ${entry.flags} flags · ${entry.shortcuts} shortcuts · ${entry.messageRenderers} renderers`}
    />
   ))}
   {coreVisible && (
    <Card
     title="pi core (SDK)"
     badge="builtin"
     commands={snapshot.core.commands}
     tools={snapshot.core.tools}
     meta="Built-in slash commands and SDK tools — not from any extension"
    />
   )}
   {filtered.length === 0 && !coreVisible && (
    <div className="row-desc">Nothing matches “{query}”.</div>
   )}
   {snapshot.loadErrors.length > 0 && (
    <div className="card card-errors">
     <div className="card-title">
      <span className="card-name">
       {snapshot.loadErrors.length} extension(s) failed to load
      </span>
     </div>
     {snapshot.loadErrors.map((e) => (
      <div className="row" key={e.path}>
       <span className="tool-name">{e.path}</span>
       <span className="row-desc">{e.error}</span>
      </div>
     ))}
    </div>
   )}
  </div>
 );
}

function matchesCore(snapshot: ExtensionsSnapshot, query: string): boolean {
 if (!query) return true;
 const hay = [
  "pi core",
  ...snapshot.core.commands.map((c) => c.name),
  ...snapshot.core.tools.map((t) => t.name),
 ]
  .join(" ")
  .toLowerCase();
 return hay.includes(query);
}
```

Create `webview-ui/src/extensions/extensions.css`:

```css
:root {
 color-scheme: light dark;
}

body {
 font-family: var(--vscode-font-family, sans-serif);
 font-size: var(--vscode-font-size, 13px);
 color: var(--vscode-foreground);
 padding: 0;
 margin: 0;
}

.ext-root {
 display: flex;
 flex-direction: column;
 gap: 8px;
 padding: 8px;
 box-sizing: border-box;
}

.ext-header {
 display: flex;
 flex-direction: column;
 gap: 6px;
 border-bottom: 1px solid var(--vscode-panel-border);
 padding-bottom: 8px;
}

.ext-mode {
 font-weight: 600;
}

.ext-mode-dim {
 color: var(--vscode-descriptionForeground);
}

.ext-mode-warning {
 color: var(--vscode-editorWarning-foreground);
}

.ext-mode-ok {
 color: var(--vscode-charts-green, #89d185);
}

.ext-legend {
 display: flex;
 gap: 8px;
 flex-wrap: wrap;
 font-size: 11px;
 color: var(--vscode-descriptionForeground);
}

.ext-controls {
 display: flex;
 gap: 6px;
}

.ext-search {
 flex: 1;
 background: var(--vscode-input-background);
 color: var(--vscode-input-foreground);
 border: 1px solid var(--vscode-input-border, transparent);
 padding: 3px 6px;
}

.ext-refresh {
 background: var(--vscode-button-background);
 color: var(--vscode-button-foreground);
 border: none;
 padding: 3px 10px;
 cursor: pointer;
}

.ext-refresh:disabled {
 opacity: 0.6;
 cursor: default;
}

.ext-meta {
 font-size: 11px;
 color: var(--vscode-descriptionForeground);
}

.ext-error {
 display: flex;
 align-items: center;
 gap: 8px;
 padding: 6px 8px;
 background: var(--vscode-inputValidation-errorBackground);
 color: var(--vscode-inputValidation-errorForeground);
 border: 1px solid var(--vscode-inputValidation-errorBorder);
}

.ext-error button {
 background: var(--vscode-button-background);
 color: var(--vscode-button-foreground);
 border: none;
 cursor: pointer;
 padding: 2px 8px;
}

.ext-busy {
 color: var(--vscode-descriptionForeground);
 padding: 12px 0;
 text-align: center;
}

.ext-tree {
 display: flex;
 flex-direction: column;
 gap: 8px;
}

.card {
 border: 1px solid var(--vscode-panel-border);
 border-radius: 4px;
 padding: 6px 8px;
 display: flex;
 flex-direction: column;
 gap: 4px;
 background: var(--vscode-editorWidget-background);
}

.card-disabled {
 opacity: 0.55;
}

.card-errors {
 border-color: var(--vscode-inputValidation-errorBorder);
}

.card-title {
 display: flex;
 align-items: center;
 gap: 6px;
 font-weight: 600;
}

.card-name {
 overflow: hidden;
 text-overflow: ellipsis;
 white-space: nowrap;
}

.badge {
 font-size: 10px;
 font-weight: 400;
 padding: 1px 5px;
 border-radius: 8px;
 background: var(--vscode-badge-background);
 color: var(--vscode-badge-foreground);
 text-transform: uppercase;
 letter-spacing: 0.4px;
}

.tag {
 font-size: 10px;
 padding: 0 4px;
 border-radius: 3px;
 background: var(--vscode-textCodeBlock-background);
}

.tag-skill {
 color: var(--vscode-charts-purple, #b180d7);
}

.tag-prompt {
 color: var(--vscode-charts-blue, #519aba);
}

.tag-disabled {
 color: var(--vscode-descriptionForeground);
}

.group {
 display: flex;
 flex-direction: column;
 gap: 1px;
 padding-left: 6px;
}

.group-label {
 font-size: 10px;
 text-transform: uppercase;
 letter-spacing: 0.6px;
 color: var(--vscode-descriptionForeground);
 margin-top: 2px;
}

.row {
 display: flex;
 align-items: center;
 gap: 6px;
 font-size: 12px;
}

.cmd-name {
 color: var(--vscode-textLink-foreground);
}

.tool-name {
 font-family: var(--vscode-editor-font-family, monospace);
}

.row-desc {
 color: var(--vscode-descriptionForeground);
 overflow: hidden;
 text-overflow: ellipsis;
 white-space: nowrap;
 flex: 1;
}

.chip {
 font-size: 10px;
 padding: 1px 6px;
 border-radius: 8px;
 white-space: nowrap;
}

.chip-safe {
 background: var(--vscode-inputValidation-infoBackground, transparent);
 color: var(--vscode-charts-green, #89d185);
 border: 1px solid var(--vscode-charts-green, #89d185);
}

.chip-whitelisted {
 color: var(--vscode-charts-yellow, #e2c08d);
 border: 1px solid var(--vscode-charts-yellow, #e2c08d);
}

.chip-blocked {
 color: var(--vscode-errorForeground, #f48771);
 border: 1px solid var(--vscode-errorForeground, #f48771);
}

.card-meta {
 font-size: 10px;
 color: var(--vscode-descriptionForeground);
}
```

- [ ] **Step 3: Add the vite entry**

Modify `webview-ui/vite.config.ts` — change the `input` block:

```ts
  rollupOptions: {
   input: {
    settings: "settings.html",
    extensions: "extensions.html",
   },
```

- [ ] **Step 4: Type-check and build the webview**

Run: `cd webview-ui && npx tsc --noEmit`
Expected: no errors.

Run: `cd webview-ui && npm run build`
Expected: builds; `dist/assets/extensions.js` and `dist/assets/index.css` exist (verify with `ls dist/assets`).

- [ ] **Step 5: Run the full host test suite + build**

Run (from repo root): `npm test`
Expected: all pass (307 + new tests).

Run: `npm run build` (root — esbuild + webview check-types)
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add webview-ui/extensions.html webview-ui/src/extensions/ webview-ui/vite.config.ts webview-ui/package-lock.json
git commit -m "feat: extensions tab webview (React tree, ask-mode chips, search, refresh)"
```

(If `webview-ui/package-lock.json` is unchanged, omit it from the `git add`.)

---

### Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass. Record the count.

- [ ] **Step 2: Run the full build**

Run: `npm run build`
Expected: check-types clean, webview build clean, esbuild bundle clean.

- [ ] **Step 3: Verify the snapshot end-to-end against the REAL user environment**

Run a one-off probe against the real user environment from plain Node (the
probe itself never touches `vscode` — but it is bundled with it, so import
it through the repo's installed SDK instead by writing a tiny script that
re-implements `probeExtensions`' three calls — or, simpler, launch the
extension host (F5) and open the Extensions tab. Expected result: bundled
extensions (codepi-modes, codepi-bash, codepi-footer, codepi-diff,
codepi-context, codepi-compact), agent-dir extensions (safety-guard.ts,
local-models.ts, context-command.ts, flow-title.ts, filechanges/), npm
packages (rpiv-todo), and the pi core card — with ask chips:
read/grep/find/ls ✓, bash/edit/write 🔒.

- [ ] **Step 4: Update the plan/spec status if needed**

No changes expected. If the F5 check reveals mismatches (e.g. an extension that fails to load), log the loader error in the Extensions tab and verify it matches the panel's own session-start diagnostics.

- [ ] **Step 5: Commit any verification fixes**

```bash
git add -A
git commit -m "fix: verification adjustments for extensions tab"
```

(Only if Step 3/4 produced changes.)
