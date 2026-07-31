# Native pi TUI in the Editor Webview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom React chat GUI with pi's native full-screen TUI (`InteractiveMode`) rendered in the editor's custom-editor webview via xterm.js, keeping the sidebar, the file-overlay review workflow, and the settings storage/GUI.

**Architecture:** Each `codepi-chat://` custom-editor tab hosts one `InteractiveMode` instance running in-process in the extension host, bound to the session's `AgentSessionRuntime` (same session options as today: `noTools: "builtin"` + the 8 VSCode custom tools). The TUI renders into an injected `WebviewTerminal` that streams ANSI to an xterm.js terminal in the webview and feeds keystrokes back. The published SDK hard-wires `new ProcessTerminal()` — a tiny patch-package hunk threads `options.terminal` through, so the TUI renders into our virtual terminal instead of stdin/stdout.

**Tech Stack:** `@earendil-works/pi-coding-agent@0.80.1` (patched), `@xterm/xterm` + `@xterm/addon-fit` (webview), Vite (webview build), esbuild (extension), vitest (tests), patch-package.

## Global Constraints

- SDK pinned `^0.80.1`; the patch targets **0.80.1 exactly** and `postinstall` fails loudly if the installed version changes (by design — update the patch then).
- esbuild externals unchanged: `vscode`, `@earendil-works/pi-coding-agent`, `@vscode/ripgrep-universal`.
- Root tsconfig has `rootDir: "src"` → all new extension code goes under `src/`.
- Vite entries stay `{index, settings}` with `cssCodeSplit: false`; extension HTML shells keep referencing `assets/index.js` + `assets/index.css`.
- Do NOT touch `src/tools/*` except `src/tools/ask-user-question.ts` (Task 5). Lint stays at exactly 3 pre-existing errors in `src/tools/*`.
- Settings sidebar app (`webview-ui/src/settings/*`) is untouched.
- Keep: sidebar sessions tree (preview/double-click), `ReviewManager` + decorations + CodeLens + review status bar, `pi-store`/env redirect, `settings-view`, `import-config`, white pi logo tab icon.
- SDK is ESM-only; extension is CJS → runtime SDK imports stay dynamic (`getPi()` pattern); `import type { ... } from "@earendil-works/pi-coding-agent"` is fine.
- Manual F5 verification runs on the user's Remote-SSH client only — all F5 checklist items are **pending-manual**; unit-test everything else that is testable.
- Known pre-existing packaging gap (out of scope, flagged only): `.vscodeignore` excludes `node_modules` while the SDK is an esbuild external — the extension is developed/run via F5 with `node_modules` present, not from a packaged VSIX.

---

### Task 1: SDK terminal-injection patch + patch-package infra

Threads `options.terminal` through `InteractiveModeOptions` in the installed SDK dist so the TUI can render into our virtual terminal. Reappliable, pinned, test-guarded.

**Files:**
- Modify: `package.json` (`patch-package` devDependency, `postinstall` script)
- Modify: `package-lock.json` (via npm install)
- Create: `patches/@earendil-works+pi-coding-agent+0.80.1.patch` (generated, not hand-written)
- Test: `src/__tests__/sdk-patch.test.ts`
- Modify (temporarily, then via patch): `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js` + `.d.ts` (never committed — regenerated from the patch)

**Interfaces:**
- Produces: patched SDK where `InteractiveModeOptions.terminal?: import("@earendil-works/pi-tui").Terminal` exists and the JS constructor uses `options.terminal ?? new ProcessTerminal()`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/sdk-patch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const DIST_DIR = path.resolve(
	process.cwd(),
	"node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive",
);

describe("SDK terminal-injection patch (0.80.1)", () => {
	it("threads options.terminal into the TUI constructor", () => {
		const js = fs.readFileSync(path.join(DIST_DIR, "interactive-mode.js"), "utf8");
		expect(js).toMatch(/options\.terminal \?\? new ProcessTerminal\(\)/);
	});
	it("declares terminal on InteractiveModeOptions", () => {
		const dts = fs.readFileSync(path.join(DIST_DIR, "interactive-mode.d.ts"), "utf8");
		expect(dts).toMatch(/terminal\?:/);
		expect(dts).toMatch(/@earendil-works\/pi-tui/);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/sdk-patch.test.ts`
Expected: FAIL — the unpatched dist constructs `new TUI(new ProcessTerminal(), ...)` with no `options.terminal`.

- [ ] **Step 3: Manually patch node_modules (both files)**

Edit `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`, line 246. Before:

```js
        this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
```

After:

```js
        this.ui = new TUI((options.terminal ?? new ProcessTerminal()), this.settingsManager.getShowHardwareCursor());
```

Edit `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.d.ts` — in `interface InteractiveModeOptions`, after the `verbose?: boolean;` line add:

```ts
    /** Custom terminal to render into. Defaults to the process terminal (stdin/stdout). */
    terminal?: import("@earendil-works/pi-tui").Terminal;
```

- [ ] **Step 4: Verify the patch test passes**

Run: `npx vitest run src/__tests__/sdk-patch.test.ts`
Expected: PASS (both `it` blocks).

- [ ] **Step 5: Generate the patch file + wire patch-package**

```bash
npx patch-package @earendil-works/pi-coding-agent
```

Expected: creates `patches/@earendil-works+pi-coding-agent+0.80.1.patch`. Open it and confirm it contains BOTH hunks (the `.js` constructor change and the `.d.ts` option). Then:

```bash
npm install --save-dev patch-package@^8.0.0
```

Add to `package.json` scripts:

```json
"postinstall": "patch-package"
```

- [ ] **Step 6: Verify idempotence + full test suite**

Run:
```bash
npm install           # runs postinstall → patch-package; must exit 0 (already-applied is fine)
npm test              # all suites pass, including sdk-patch
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json patches/ src/__tests__/sdk-patch.test.ts
git commit -m "feat: inject virtual terminal into pi InteractiveMode via SDK patch"
```

---

### Task 2: `WebviewTerminal` + TUI message protocol

A `Terminal`-interface implementation bridging the in-process TUI to the webview, plus the message protocol shared by both sides. Every renderer operation is mapped to ANSI escape sequences forwarded through `write()` so xterm.js parses them natively; `setTitle`/`setProgress` become structured messages.

**Files:**
- Create: `src/tui/protocol.ts`
- Create: `src/tui/webview-terminal.ts`
- Test: `src/__tests__/webview-terminal.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `type TuiHostMessage = { command: "tui:write"; data: string } | { command: "tui:title"; title: string } | { command: "tui:progress"; active: boolean }`
  - `type TuiWebviewMessage = { command: "tui:ready" } | { command: "tui:input"; data: string } | { command: "tui:resize"; cols: number; rows: number }`
  - `class WebviewTerminal implements TuiTerminal` — constructor `(send: (msg: TuiHostMessage) => void)`; methods `start(onInput, onResize)`, `stop()`, `drainInput()`, `write(data)`, getters `columns`/`rows`, getter `kittyProtocolActive` (always `false`), `moveBy(lines)`, `hideCursor()`, `showCursor()`, `clearLine()`, `clearFromCursor()`, `clearScreen()`, `setTitle(title)`, `setProgress(active)`, plus host-facing `handleInput(data)`, `handleResize(cols, rows)`, `handleReady()` (flushes buffered writes).
  - `interface TuiTerminal` — the structural mirror of pi's `Terminal` interface (16 members above), documented with the pi-tui contract.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/webview-terminal.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { WebviewTerminal } from "../tui/webview-terminal";

function makeTerminal() {
	const send = vi.fn();
	const term = new WebviewTerminal(send);
	return { term, send };
}

describe("WebviewTerminal", () => {
	it("forwards write() as tui:write", () => {
		const { term, send } = makeTerminal();
		term.write("\x1b[31mhi");
		expect(send).toHaveBeenCalledWith({ command: "tui:write", data: "\x1b[31mhi" });
	});

	it("buffers writes until ready, then flushes in order", () => {
		const { term, send } = makeTerminal();
		term.write("a");
		term.write("b");
		expect(send).not.toHaveBeenCalled();
		term.handleReady();
		expect(send).toHaveBeenNthCalledWith(1, { command: "tui:write", data: "a" });
		expect(send).toHaveBeenNthCalledWith(2, { command: "tui:write", data: "b" });
		term.write("c");
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("maps cursor/clear ops to ANSI via write", () => {
		const { term, send } = makeTerminal();
		term.handleReady();
		send.mockClear();
		term.hideCursor();
		term.showCursor();
		term.clearLine();
		term.clearFromCursor();
		term.clearScreen();
		term.moveBy(2);
		term.moveBy(-3);
		expect(send).toHaveBeenNthCalledWith(1, { command: "tui:write", data: "\x1b[?25l" });
		expect(send).toHaveBeenNthCalledWith(2, { command: "tui:write", data: "\x1b[?25h" });
		expect(send).toHaveBeenNthCalledWith(3, { command: "tui:write", data: "\x1b[K" });
		expect(send).toHaveBeenNthCalledWith(4, { command: "tui:write", data: "\x1b[0J" });
		expect(send).toHaveBeenNthCalledWith(5, { command: "tui:write", data: "\x1b[2J\x1b[H" });
		expect(send).toHaveBeenNthCalledWith(6, { command: "tui:write", data: "\x1b[2B" });
		expect(send).toHaveBeenNthCalledWith(7, { command: "tui:write", data: "\x1b[3A" });
	});

	it("sends title and progress as structured messages", () => {
		const { term, send } = makeTerminal();
		term.setTitle("pi - hello - repo");
		term.setProgress(true);
		expect(send).toHaveBeenNthCalledWith(1, { command: "tui:title", title: "pi - hello - repo" });
		expect(send).toHaveBeenNthCalledWith(2, { command: "tui:progress", active: true });
	});

	it("routes input and resize to handlers; resize updates columns/rows", () => {
		const { term } = makeTerminal();
		const onInput = vi.fn();
		const onResize = vi.fn();
		term.start(onInput, onResize);
		term.handleInput("\r");
		expect(onInput).toHaveBeenCalledWith("\r");
		term.handleResize(120, 40);
		expect(term.columns).toBe(120);
		expect(term.rows).toBe(40);
		expect(onResize).toHaveBeenCalledOnce();
		term.stop();
		term.handleInput("x");
		expect(onInput).toHaveBeenCalledTimes(1);
	});

	it("never advertises kitty protocol", () => {
		const { term } = makeTerminal();
		expect(term.kittyProtocolActive).toBe(false);
	});

	it("drainInput resolves immediately", async () => {
		const { term } = makeTerminal();
		await expect(term.drainInput()).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/webview-terminal.test.ts`
Expected: FAIL — module `../tui/webview-terminal` not found.

- [ ] **Step 3: Write the protocol types**

Create `src/tui/protocol.ts`:

```ts
/**
 * TUI bridge protocol between the extension host (pi InteractiveMode) and the
 * terminal webview (xterm.js). Host messages flow extension → webview; webview
 * messages flow webview → extension.
 */

/** Host → webview: raw ANSI output, tab title, busy state. */
export type TuiHostMessage =
	| { command: "tui:write"; data: string }
	| { command: "tui:title"; title: string }
	| { command: "tui:progress"; active: boolean };

/** Webview → host: xterm ready, keystrokes, size changes. */
export type TuiWebviewMessage =
	| { command: "tui:ready" }
	| { command: "tui:input"; data: string }
	| { command: "tui:resize"; cols: number; rows: number };
```

- [ ] **Step 4: Write `WebviewTerminal`**

Create `src/tui/webview-terminal.ts`:

```ts
import type { TuiHostMessage } from "./protocol";

/**
 * Structural mirror of pi's `Terminal` interface (from @earendil-works/pi-tui).
 * Kept local so the extension needs no direct dependency on the TUI package.
 * Members must stay in sync with pi-tui's `Terminal`:
 * start/stop/drainInput/write/columns/rows/kittyProtocolActive/moveBy/
 * hideCursor/showCursor/clearLine/clearFromCursor/clearScreen/setTitle/setProgress.
 */
export interface TuiTerminal {
	start(onInput: (data: string) => void, onResize: () => void): void;
	stop(): void;
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;
	write(data: string): void;
	readonly columns: number;
	readonly rows: number;
	readonly kittyProtocolActive: boolean;
	moveBy(lines: number): void;
	hideCursor(): void;
	showCursor(): void;
	clearLine(): void;
	clearFromCursor(): void;
	clearScreen(): void;
	setTitle(title: string): void;
	setProgress(active: boolean): void;
}

/**
 * Bridges pi's InteractiveMode terminal output to a webview xterm.js instance.
 *
 * Every renderer operation is translated to ANSI escape sequences and pushed
 * through `write()` (xterm parses ANSI natively), except `setTitle` and
 * `setProgress` which become structured host messages. Writes issued before
 * the webview signals `tui:ready` are buffered and flushed in order, because
 * VS Code drops postMessage calls to a webview that has not loaded yet.
 */
export class WebviewTerminal implements TuiTerminal {
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _columns = 80;
	private _rows = 24;
	private ready = false;
	private pending: string[] = [];

	constructor(private readonly send: (msg: TuiHostMessage) => void) {}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
		this.pending = [];
	}

	async drainInput(): Promise<void> {
		/* no real tty to drain */
	}

	write(data: string): void {
		if (!this.ready) {
			this.pending.push(data);
			return;
		}
		this.send({ command: "tui:write", data });
	}

	get columns(): number {
		return this._columns;
	}

	get rows(): number {
		return this._rows;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(lines: number): void {
		const n = Math.abs(lines);
		this.write(`\x1b[${n}${lines < 0 ? "A" : "B"}`);
	}

	hideCursor(): void {
		this.write("\x1b[?25l");
	}

	showCursor(): void {
		this.write("\x1b[?25h");
	}

	clearLine(): void {
		this.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.write("\x1b[0J");
	}

	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}

	setTitle(title: string): void {
		this.send({ command: "tui:title", title });
	}

	setProgress(active: boolean): void {
		this.send({ command: "tui:progress", active });
	}

	/** Called by the extension when the webview reports xterm readiness. */
	handleReady(): void {
		if (this.ready) return;
		this.ready = true;
		for (const data of this.pending) {
			this.send({ command: "tui:write", data });
		}
		this.pending = [];
	}

	/** Called by the extension on `tui:input` webview messages. */
	handleInput(data: string): void {
		this.inputHandler?.(data);
	}

	/** Called by the extension on `tui:resize` webview messages. */
	handleResize(cols: number, rows: number): void {
		if (cols > 0) this._columns = cols;
		if (rows > 0) this._rows = rows;
		this.resizeHandler?.();
	}
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/webview-terminal.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/tui/protocol.ts src/tui/webview-terminal.ts src/__tests__/webview-terminal.test.ts
git commit -m "feat: WebviewTerminal bridging InteractiveMode output to the webview"
```

---

### Task 3: Wipe the chat GUI; terminal webview host (xterm.js)

Deletes the React chat app and replaces the `index` Vite entry with a small vanilla xterm.js host. The settings app is untouched. `index.html` and the extension's `buildHtml` remain byte-identical in their asset references.

**Files:**
- Delete: `webview-ui/src/App.tsx`, `webview-ui/src/types.ts`
- Delete: `webview-ui/src/components/{ChatView,EditCard,EditReviewBar,ErrorBoundary,InputArea,MessageBubble,ModePicker,QuestionCarousel,ThinkingLevelPicker,TodoListWidget}.tsx`
- Delete: `webview-ui/src/hooks/{useStreaming,useVSCodeAPI}.ts`
- Rewrite: `webview-ui/src/main.tsx` (terminal bootstrap), `webview-ui/src/index.css` (terminal styles)
- Create: `webview-ui/src/terminal/terminal.ts`, `webview-ui/src/terminal/protocol.ts`
- Modify: `webview-ui/package.json` (deps), `webview-ui/package-lock.json` (via npm install)

**Interfaces:**
- Consumes: `TuiHostMessage`/`TuiWebviewMessage` shapes from Task 2 (duplicated in `webview-ui/src/terminal/protocol.ts` — webview side cannot import from `src/` extension code; keep in sync, documented).
- Produces: the `assets/index.js` bundle that posts `tui:ready`/`tui:input`/`tui:resize` and handles `tui:write`/`tui:title`/`tui:progress`.

- [ ] **Step 1: Delete the chat app files**

```bash
cd webview-ui/src
rm -rf components hooks
rm App.tsx types.ts
cd ../..
```

Do NOT delete `settings/`, `vite-env.d.ts`, `index.html`, `settings.html`.

- [ ] **Step 2: Add xterm dependencies**

```bash
npm --prefix webview-ui install @xterm/xterm@^5.5.0 @xterm/addon-fit@^0.10.0
```

- [ ] **Step 3: Write the webview-side protocol mirror**

Create `webview-ui/src/terminal/protocol.ts`:

```ts
/**
 * Webview-side mirror of src/tui/protocol.ts (the webview cannot import from
 * the extension's src/ tree). Keep both files in sync.
 */

/** Host → webview messages. */
export type TuiHostMessage =
	| { command: "tui:write"; data: string }
	| { command: "tui:title"; title: string }
	| { command: "tui:progress"; active: boolean };

/** Webview → host messages. */
export type TuiWebviewMessage =
	| { command: "tui:ready" }
	| { command: "tui:input"; data: string }
	| { command: "tui:resize"; cols: number; rows: number };
```

- [ ] **Step 4: Write the xterm host**

Create `webview-ui/src/terminal/terminal.ts`:

```ts
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TuiHostMessage, TuiWebviewMessage } from "./protocol";

const vscode = acquireVsCodeApi<unknown>();

function post(msg: TuiWebviewMessage): void {
	vscode.postMessage(msg);
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

const term = new Terminal({
	cursorBlink: true,
	fontFamily: 'Menlo, Monaco, "Courier New", monospace',
	fontSize: 13,
	scrollback: 10_000,
});

const fit = new FitAddon();
term.loadAddon(fit);
term.open(root);
try {
	fit.fit();
} catch {
	/* layout not ready yet */
}
term.focus();

term.onData((data) => post({ command: "tui:input", data }));

// Keep the terminal sized to the webview; report size so the TUI reflows.
function reportSize(): void {
	try {
		fit.fit();
	} catch {
		/* ignore transient layout errors */
	}
	post({ command: "tui:resize", cols: term.cols, rows: term.rows });
}
const observer = new ResizeObserver(reportSize);
observer.observe(root);
window.addEventListener("resize", reportSize);

window.addEventListener("message", (event: MessageEvent) => {
	const msg = (event.data ?? {}) as Partial<TuiHostMessage>;
	if (msg.command === "tui:write") {
		term.write(msg.data ?? "");
	} else if (msg.command === "tui:title") {
		document.title = msg.title ?? "";
	}
	// tui:progress is handled by the extension host (status bar / tab icon).
});

// Announce readiness and the initial size (the extension awaits this before
// starting the TUI, and buffers anything that arrived earlier).
post({ command: "tui:ready" });
reportSize();
```

- [ ] **Step 5: Rewrite the entry + styles**

Rewrite `webview-ui/src/main.tsx`:

```tsx
import "./terminal/terminal";
```

Rewrite `webview-ui/src/index.css`:

```css
html,
body,
#root {
	height: 100%;
	margin: 0;
	padding: 0;
	overflow: hidden;
	background: #1e1e1e;
}

#root .xterm {
	height: 100%;
	padding: 4px;
	box-sizing: border-box;
}
```

- [ ] **Step 6: Build + verify no chat remnants**

Run:
```bash
npm --prefix webview-ui run build
```
Expected: build succeeds; `webview-ui/dist/assets/index.js` + `index.css` + `settings.js` exist.

Then:
```bash
cd webview-ui/src && grep -rniE "chatview|inputarea|messagingbubble|editreviewbar|usestreaming|thinkinglevelpicker|modelselector" . || echo "clean"
```
Expected: either no matches or `echo "clean"` (settings/ files must not match).

- [ ] **Step 7: Commit**

```bash
git add -A webview-ui
git commit -m "feat: replace chat GUI with xterm.js terminal host in the editor webview"
```

---

### Task 4: Extension TUI lifecycle

Rewires the extension host: each custom-editor tab constructs an `AgentSessionRuntime` + `InteractiveMode` (patched SDK) bound to the tab's `WebviewTerminal`, and all chat-GUI plumbing (relay, replay, model lists, mode info, chat message handlers) is removed.

**Files:**
- Modify: `src/extension.ts` (major)
- Delete: `src/bridge/relay.ts`, `src/bridge/protocol.ts`

**Interfaces:**
- Consumes: `WebviewTerminal`/`TuiTerminal` (Task 2), `TuiHostMessage`/`TuiWebviewMessage` (Task 2), `createVscodeTools` + `ReviewManager` (existing), patched SDK (Task 1).
- Produces: `setupTuiPanel(context, panel, sessionManager, sessionId, sessionPath): Promise<PanelState>`; `PanelState` with `{ panel, terminal, runtime, tui, sessionManager, extensionUri, isBackendReady, isBusy, sessionId, sessionPath, disposables, review }`; `handleTuiMessage(message, state)`.

- [ ] **Step 1: Type imports + PanelState + globals**

In `src/extension.ts`:

Delete these three imports:

```ts
import { PiEventRelay } from "./bridge/relay";          // DELETE
import type { WebviewMessage } from "./bridge/protocol"; // DELETE
import type { AgentSession } from "@earendil-works/pi-coding-agent"; // DELETE
```

Add (in place of them):

```ts
import type {
	AgentSessionRuntime,
	InteractiveMode,
} from "@earendil-works/pi-coding-agent";
import { WebviewTerminal } from "./tui/webview-terminal";
import type { TuiWebviewMessage } from "./tui/protocol";
```

Note: `InteractiveMode` is used only in type position (`PanelState.tui`); runtime construction goes through the `pi` any-typed namespace (`new pi.InteractiveMode(...)`), matching the existing `getPi()` dynamic-import pattern.

Replace the `PanelState` interface:

```ts
interface PanelState {
	panel: vscode.WebviewPanel;
	terminal: WebviewTerminal;
	runtime: AgentSessionRuntime;
	tui: InteractiveMode;
	sessionManager: any; // SessionManager from PI SDK
	extensionUri: vscode.Uri;
	isBackendReady: boolean;
	isBusy: boolean;
	sessionId: string;
	sessionPath: string;
	disposables: vscode.Disposable[];
	review: ReviewManager;
}
```

- [ ] **Step 2: Settings `onConfigSaved` → no-op (models are TUI-native)**

In `activate()`, the `SettingsViewProvider` constructor callback currently loops panels calling `refreshPanelModels(st)`. Replace the callback body with:

```ts
new SettingsViewProvider(context.extensionUri, () => {
	// Settings hot-apply under the native TUI:
	//  - settings.json applies to NEW sessions (unchanged)
	//  - auth.json is read at request time (unchanged)
	//  - models.json is re-read by the TUI's own /model selector on demand,
	//    so no push refresh is needed here.
}),
```

- [ ] **Step 3: Rewrite panel setup (`setupChatPanel` → `setupTuiPanel`)**

In `src/extension.ts`, replace the entire `setupChatPanel` function with:

```ts
async function setupTuiPanel(
	context: vscode.ExtensionContext,
	panel: vscode.WebviewPanel,
	sessionManager: any,
	sessionId: string,
	sessionPath: string,
): Promise<PanelState> {
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [
			vscode.Uri.joinPath(context.extensionUri, "webview-ui", "dist"),
			vscode.Uri.joinPath(context.extensionUri, "media"),
		],
	};
	panel.webview.html = buildHtml(context.extensionUri, panel.webview);

	// Per-panel review manager: tools register proposals here; review events
	// drive editor decorations, the review status bar, and notifications
	// (the webview is a terminal now, so nothing is posted to it).
	let review: ReviewManager;
	review = new ReviewManager(
		{
			post: (msg) => {
				if (msg.command === "editProposed" || msg.command === "editUpdated") {
					const summary = msg.summary as { proposalId: string } | undefined;
					if (summary) {
						const proposal = review.getProposal(summary.proposalId);
						if (proposal) {
							if (
								proposal.status === "accepted" ||
								proposal.status === "rejected" ||
								proposal.status === "stale"
							) {
								reviewDecorations?.clearProposal(proposal.uri);
							} else {
								reviewDecorations?.setProposal(proposal);
							}
						}
					}
					updateReviewStatusBar();
				}
			},
			openFile: async (uriStr) => {
				try {
					const uri = vscode.Uri.parse(uriStr);
					const doc = await vscode.workspace.openTextDocument(uri);
					await vscode.window.showTextDocument(doc, {
						preview: false,
						preserveFocus: true,
					});
				} catch {
					/* ignore */
				}
			},
			promptFileReview: (summary) => {
				enqueueFileReviewPrompt(summary, state);
			},
			notify: (text) => {
				void vscode.window.showInformationMessage(text);
			},
		},
		{
			readContent: async (uriStr) => {
				const uri = vscode.Uri.parse(uriStr);
				const raw = await vscode.workspace.fs.readFile(uri);
				return new TextDecoder().decode(raw);
			},
			writeContent: async (uriStr, content) => {
				const uri = vscode.Uri.parse(uriStr);
				await vscode.workspace.fs.writeFile(
					uri,
					new TextEncoder().encode(content),
				);
			},
		},
	);

	const terminal = new WebviewTerminal((msg) => {
		try {
			panel.webview.postMessage(msg);
		} catch {
			/* panel gone */
		}
	});

	const state: PanelState = {
		panel,
		terminal,
		runtime: undefined as unknown as AgentSessionRuntime, // filled by startTuiBackend
		tui: undefined as unknown as InteractiveMode, // filled by startTuiBackend
		sessionManager,
		extensionUri: context.extensionUri,
		isBackendReady: false,
		isBusy: false,
		sessionId,
		sessionPath,
		disposables: [],
		review,
	};

	setPanelIcon(state, "idle");
	panels.set(sessionId, state);

	panel.onDidChangeViewState(
		() => {
			setPanelIcon(state, state.isBusy ? "busy" : "idle");
		},
		undefined,
		context.subscriptions,
	);

	const msgDisposable = panel.webview.onDidReceiveMessage(
		async (message: TuiWebviewMessage) => {
			await handleTuiMessage(message, state);
		},
		undefined,
		context.subscriptions,
	);
	state.disposables.push(msgDisposable);

	panel.onDidDispose(
		() => {
			cleanupPanel(sessionId);
		},
		undefined,
		context.subscriptions,
	);

	// Wait for xterm to be ready (bounded) before starting the TUI, so the
	// first frames are not lost; WebviewTerminal also buffers until ready.
	await Promise.race([
		new Promise<void>((resolve) => {
			terminalReadyWaiters.set(sessionId, resolve);
		}),
		new Promise((resolve) => setTimeout(resolve, 5000)),
	]);
	terminalReadyWaiters.delete(sessionId);

	startTuiBackend(state).catch((err) => {
		const msg = err instanceof Error ? err.message : String(err);
		setPanelIcon(state, "error");
		void vscode.window.showErrorMessage(`CodePi TUI backend error: ${msg}`);
		console.error("[CodePi] TUI backend error for panel", sessionId, ":", err);
	});

	return state;
}
```

- [ ] **Step 4: Ready waiter + `handleTuiMessage`**

Add the module-level waiter map next to `panels`:

```ts
// Resolvers fired when each tab's webview posts tui:ready.
const terminalReadyWaiters = new Map<string, () => void>();
```

Replace `handleWebviewMessage` entirely with:

```ts
async function handleTuiMessage(
	message: TuiWebviewMessage,
	state: PanelState,
): Promise<void> {
	if (message.command === "tui:ready") {
		terminalReadyWaiters.get(state.sessionId)?.();
		state.terminal.handleReady();
		return;
	}
	if (message.command === "tui:input") {
		state.terminal.handleInput(message.data);
		return;
	}
	if (message.command === "tui:resize") {
		state.terminal.handleResize(message.cols, message.rows);
		return;
	}
}
```

- [ ] **Step 5: `startTuiBackend` (replaces `startBackend`)**

Replace `startBackend` and delete `refreshPanelModels` with:

```ts
async function startTuiBackend(state: PanelState): Promise<void> {
	const pi = await getPi();
	const workspaceRoot = getWorkspaceRoot();
	const agentDir = getAgentDir();

	// Factory reused by the runtime for /new, /resume and /fork flows.
	const createRuntime: any = async (opts: any) => {
		const loader = new pi.DefaultResourceLoader({
			cwd: opts.cwd,
			agentDir: opts.agentDir,
			noExtensions: true,
		});
		await loader.reload();
		return pi.createAgentSession({
			resourceLoader: loader,
			cwd: opts.cwd,
			agentDir: opts.agentDir,
			noTools: "builtin",
			customTools: createVscodeTools(state.review),
			sessionManager: opts.sessionManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
	};

	const runtime = await pi.createAgentSessionRuntime(createRuntime, {
		cwd: workspaceRoot,
		agentDir,
		sessionManager: state.sessionManager,
	});
	state.runtime = runtime;

	// Set an initial tab title (the TUI's setTitle will refine it shortly).
	const entries = state.sessionManager.getEntries();
	const sessionName = state.sessionManager.getSessionName?.();
	const firstUserEntry = entries?.find(
		(e: any) => e.type === "message" && e.message?.role === "user",
	);
	const titleText =
		sessionName ||
		firstUserEntry?.message?.content?.[0]?.text ||
		"PI";
	setPanelTitle(
		state,
		titleText.length > 50 ? titleText.slice(0, 50) + "…" : titleText,
	);

	// Reconstruct todo state from the session (tool reads it on demand).
	try {
		reconstructFromEntries(entries ?? []);
	} catch (err) {
		console.error("[CodePi] Error reconstructing todos:", err);
	}

	state.tui = new pi.InteractiveMode(runtime, {
		terminal: state.terminal,
		verbose: true,
	});

	state.isBackendReady = true;
	state.isBusy = true;
	setPanelIcon(state, "busy");
	treeProvider?.refresh();

	// run() resolves when the TUI exits (e.g. /quit); errors surface here.
	void state.tui.run().catch((err: Error) => {
		console.error("[CodePi] TUI exited with error:", err);
		setPanelIcon(state, "error");
		void vscode.window.showErrorMessage(
			`CodePi TUI error: ${err.message || String(err)}`,
		);
	});
}
```

- [ ] **Step 6: `cleanupPanel` + `deactivate`**

Rewrite `cleanupPanel` to drop chat-GUI bits (relay detach, busy-close confirm) and dispose the runtime:

```ts
function cleanupPanel(sessionId: string): void {
	const state = panels.get(sessionId);
	if (!state) return;

	panels.delete(sessionId);

	// Stop the TUI and dispose the runtime (disposes the session).
	try {
		state.tui?.stop();
	} catch {
		/* ignore */
	}
	void state.runtime?.dispose().catch(() => {
		/* ignore */
	});

	// Clear editor decorations for this panel's pending proposals.
	for (const p of state.review.allProposals()) {
		reviewDecorations?.clearProposal(p.uri);
	}
	updateReviewStatusBar();

	for (const d of state.disposables) {
		try {
			d.dispose();
		} catch {
			/* ignore */
		}
	}
}
```

Rewrite `deactivate()`:

```ts
export function deactivate() {
	for (const [, state] of panels) {
		try {
			state.tui?.stop();
		} catch {
			/* ignore */
		}
		void state.runtime?.dispose().catch(() => {
			/* ignore */
		});
	}
	panels.clear();
}
```

- [ ] **Step 7: Remove dead chat plumbing**

Delete these from `src/extension.ts` (grep to confirm each identifier disappears from the file afterwards):
- `import { PiEventRelay } ...` and `import type { WebviewMessage } ...` (done in Step 1)
- `import { setWriteMode, resolveQuestion } from "./tools/index"` — keep only what remains used (`createVscodeTools`, `getTodoList`? check: `getTodoList` was used only for the removed `todoUpdate` post → remove; `clearTodoList` used in `createNewSessionPanel` → keep; `reconstructFromEntries` used in `startTuiBackend` → keep; `setTodoList` was used in the removed `todoChange` handler → remove)
- `const relay = new PiEventRelay();` and all `state.relay.*` references
- `refreshPanelModels` (deleted in Step 5)
- `buildReplayEvents` (the whole function) and its `ReplayEvent` import
- The `mode`, `session`, `_allSdkTools` fields and the old `startBackend` body
- The old `handleWebviewMessage` branches: `abort`, `answerQuestion`, `todoChange`, `acceptHunk`/`rejectHunk`/`acceptFile`/`rejectFile`/`acceptAllEdits`/`rejectAllEdits`/`openDiff`, `prompt`, `steer`, `followUp`, `setModel`, `setMode`, `setThinkingLevel`, `newSession` (Step 4 replaced the whole function)
- `resolveQuestion` import (removed with `answerQuestion`)

Then delete the bridge files:

```bash
rm src/bridge/relay.ts src/bridge/protocol.ts
```

Verify: `grep -rn "bridge/\|PiEventRelay\|WebviewMessage\|buildReplayEvents\|refreshPanelModels\|relay\b" src/extension.ts` → no matches.

- [ ] **Step 8: Palette command for model switching (V3)**

pi 0.80.1's TUI exposes model switching through its own keybinding and `/model` command; no programmatic hook is available in the installed SDK, so the palette command is a thin pointer to the native path. Register this exact code in `activate()` (with the other commands):

```ts
context.subscriptions.push(
	vscode.commands.registerCommand("codepi.setModel", () => {
		vscode.window.showInformationMessage(
			"Switch models inside the pi TUI with /model (or the model keybinding).",
		);
	}),
);
```

- [ ] **Step 9: Build + lint + unit tests**

Run:
```bash
npm run build          # webview + extension both build
npm run lint           # exactly the 3 pre-existing src/tools/* errors
npm test               # all suites pass (sdk-patch + webview-terminal + existing)
```

- [ ] **Step 10: Commit**

```bash
git add -A src
git commit -m "feat: run native pi TUI per session tab (InteractiveMode + WebviewTerminal)"
```

---

### Task 5: Tool + integration adjustments, multi-instance validation

Makes the remaining glue TUI-safe: `ask_user` gets a native VSCode UI (the chat webview that resolved its questions is gone), and the multi-tab TUI coexistence risk (V1) is validated with a documented mitigation.

**Files:**
- Rewrite: `src/tools/ask-user-question.ts`
- Modify: `src/tools/index.ts` (exports)
- Modify: `src/extension.ts` (import cleanup if `resolveQuestion`/`rejectQuestion` referenced)

**Interfaces:**
- Consumes: existing `Question`/`QuestionAnswer` shapes (redefine locally).
- Produces: `askUserQuestionTool: VscodeTool` whose `execute` resolves answers itself via `vscode.window.showQuickPick`/`showInputBox`; no webview round-trip.

- [ ] **Step 1: Rewrite the ask_user tool to a self-contained native UI**

Replace the contents of `src/tools/ask-user-question.ts` with:

```ts
import * as vscode from "vscode";
import type { VscodeTool } from "./index";

// ── Types ────────────────────────────────────────────────────

export interface QuestionOption {
	label: string;
	description?: string;
	detail?: string;
}

export interface Question {
	question: string;
	options?: QuestionOption[];
	multiSelect?: boolean;
	default?: string;
}

export type QuestionAnswer = string | string[] | undefined;

interface AskQuestionsParams {
	questions: Question[];
}

// ── Tool ─────────────────────────────────────────────────────

/**
 * ask_user — asks the user one or more questions using native VS Code UI
 * (QuickPick for options, input box for free text). Self-contained: the answer
 * is resolved here, so it works under the native TUI where no chat webview
 * exists to round-trip answers.
 */
export const askUserQuestionTool: VscodeTool = {
	name: "ask_user_question",
	label: "Ask User",
	description:
		"Ask the user one or more questions. For each question, provide a list of options when possible; the user picks one (or several when multiSelect is true). Free-text questions are fine too.",
	parameters: {
		type: "object",
		properties: {
			questions: {
				type: "array",
				description: "One or more questions to ask sequentially.",
				items: {
					type: "object",
					properties: {
						question: { type: "string" },
						options: {
							type: "array",
							items: {
								type: "object",
								properties: {
									label: { type: "string" },
									description: { type: "string" },
									detail: { type: "string" },
								},
								required: ["label"],
							},
						},
						multiSelect: { type: "boolean" },
						default: { type: "string" },
					},
					required: ["question"],
				},
			},
		},
		required: ["questions"],
	},
	async execute(_toolCallId, params) {
		const { questions } = params as AskQuestionsParams;
		const answers: Record<string, QuestionAnswer> = {};
		for (const q of questions ?? []) {
			if (q.options && q.options.length > 0) {
				const picked = await vscode.window.showQuickPick(q.options, {
					title: q.question,
					placeHolder: q.question,
					canPickMany: q.multiSelect === true,
					ignoreFocusOut: false,
				});
				answers[q.question] = picked
					? q.multiSelect
						? picked.map((p) => p.label)
						: (picked as QuestionOption).label
					: undefined;
			} else {
				const text = await vscode.window.showInputBox({
					title: q.question,
					prompt: q.question,
					value: q.default ?? "",
					ignoreFocusOut: false,
				});
				answers[q.question] = text;
			}
		}
		return {
			content: [
				{
					type: "text" as const,
					text:
						Object.keys(answers).length === 0
							? "The user dismissed the questions without answering."
							: JSON.stringify(answers, null, 2),
				},
			],
			details: { answers },
		};
	},
};
```

- [ ] **Step 2: Update `src/tools/index.ts` exports**

Remove the old re-exports (`resolveQuestion`, `rejectQuestion`, `getPendingQuestions`, and the old `Question`/`QuestionOption`/`QuestionAnswer`/`AskQuestionsParams` type re-exports) and keep the tool export:

```ts
export { askUserQuestionTool } from "./ask-user-question";
export type {
	Question,
	QuestionOption,
	QuestionAnswer,
	AskQuestionsParams,
} from "./ask-user-question";
```

- [ ] **Step 3: Clean extension.ts imports**

`src/extension.ts` currently imports `resolveQuestion` from `./tools/index` — remove it (Task 4 removed the `answerQuestion` handler). Run `npm run lint` and fix any dangling references (the 3 pre-existing `src/tools/*` errors must remain the only ones).

- [ ] **Step 4: Unit test the tool's answer mapping**

Create `src/__tests__/ask-user-tool.test.ts` (mocking `vscode.window.showQuickPick`):

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
	window: {
		showQuickPick: vi.fn(),
		showInputBox: vi.fn(),
	},
}));

import * as vscode from "vscode";
import { askUserQuestionTool } from "../tools/ask-user-question";

const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;
const showInputBox = vscode.window.showInputBox as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
	showQuickPick.mockReset();
	showInputBox.mockReset();
});

describe("askUserQuestionTool", () => {
	it("maps single-pick choices to labels", async () => {
		showQuickPick.mockResolvedValue({ label: "Option B" });
		const res = await askUserQuestionTool.execute("t1", {
			questions: [{ question: "Pick one", options: [{ label: "Option A" }, { label: "Option B" }] }],
		});
		const text = res.content[0].text as string;
		expect(text).toContain('"Pick one": "Option B"');
	});

	it("maps multi-select choices to label arrays", async () => {
		showQuickPick.mockResolvedValue([{ label: "A" }, { label: "C" }]);
		const res = await askUserQuestionTool.execute("t2", {
			questions: [{ question: "Pick many", options: [{ label: "A" }, { label: "B" }, { label: "C" }], multiSelect: true }],
		});
		const text = res.content[0].text as string;
		expect(text).toContain('"Pick many": [');
		expect(text).toContain('"A"');
		expect(text).toContain('"C"');
	});

	it("uses the input box for free-text questions", async () => {
		showInputBox.mockResolvedValue("hello");
		const res = await askUserQuestionTool.execute("t3", {
			questions: [{ question: "Say something", default: "" }],
		});
		expect(res.content[0].text as string).toContain('"Say something": "hello"');
	});

	it("reports dismissal", async () => {
		showQuickPick.mockResolvedValue(undefined);
		const res = await askUserQuestionTool.execute("t4", {
			questions: [{ question: "Pick one", options: [{ label: "A" }] }],
		});
		expect(res.content[0].text as string).toContain("dismissed");
	});
});
```

- [ ] **Step 5: Run tests + lint**

Run:
```bash
npx vitest run src/__tests__/ask-user-tool.test.ts   # 4 tests pass
npm test                                              # all suites green
npm run lint                                          # exactly 3 pre-existing errors
```

- [ ] **Step 6: Multi-instance validation (V1) + commit**

Documented evidence step (pending-manual, recorded for the F5 checklist): open 2+ TUI tabs; both render and accept input; `/model` works in each. If keybindings cross-talk appears (both tabs reacting to one keystroke), the mitigation is: on `panel.onDidChangeViewState`, re-focus the xterm in the active webview via a `tui:focus` message and re-assert the icon — note this in the ledger.

Commit:
```bash
git add src/tools/ask-user-question.ts src/tools/index.ts src/extension.ts src/__tests__/ask-user-tool.test.ts
git commit -m "feat: native ask_user UI (QuickPick/InputBox) for TUI sessions"
```

---

### Task 6: Full verification pass + docs

**Files:**
- Modify: `docs/superpowers/specs/2026-08-01-tui-in-webview-design.md` (status)
- Modify: `.superpowers/sdd/progress.md` (ledger)
- No code changes unless verification finds defects.

- [ ] **Step 1: Full build / lint / test regression**

Run:
```bash
npm run build && npm run lint && npm test
```
Expected: build OK; lint exactly 3 pre-existing `src/tools/*` errors; all vitest suites pass (sdk-patch, webview-terminal, ask-user-tool, pi-settings-schema, pi-store).

- [ ] **Step 2: Packaging sanity**

Run: `python3 -c "print('check assets')"` then verify manually:
- `webview-ui/dist/assets/index.js`, `settings.js`, `index.css` exist after build
- `dist/extension.js` exists
- `.vscodeignore` still excludes `src`, `webview-ui/src`, `node_modules` (i.e. none of our new `src/tui/*` files ship, which is correct — they are compiled into `dist/extension.js`)

- [ ] **Step 3: Grep audit — no chat-GUI remnants**

Run:
```bash
grep -rn "PiEventRelay\|buildReplayEvents\|refreshPanelModels\|replayEvents\|modeInfo\|toolsInfo\|modelList\|backendReady\|thinkingDelta\|segmentStart" src/ webview-ui/src/ || echo "clean"
```
Expected: `clean`.

- [ ] **Step 4: Update the spec status + ledger**

In `docs/superpowers/specs/2026-08-01-tui-in-webview-design.md`, change the status line to:

```markdown
**Status:** Implemented 2026-08-01 (see `docs/superpowers/plans/2026-08-01-tui-in-webview.md`)
```

Append to `.superpowers/sdd/progress.md` a short completion entry listing tasks 1–6, the validation findings (V1–V5), and the pending-manual F5 checklist below.

- [ ] **Step 5: Record the manual F5 checklist (pending-manual)**

Append to `.superpowers/sdd/progress.md`:

```markdown
## Pending-manual F5 checklist (TUI-in-webview)
1. `codepi.newSession` → tab opens with the pi TUI (message list, input box, footer).
2. Typing a message produces an agent response rendered in the TUI (text, thinking, tool calls).
3. /commands work: /help, /model, /new, /resume, /quit.
4. Resizing the editor reflows the TUI.
5. Tab title = session name (from TUI setTitle); white pi logo stays in the tab handle.
6. Sidebar: single click previews, double-click persists; opening a session shows its history in the TUI.
7. Agent edit/write → editor decorations + CodeLens + bottom-right accept/reject prompt + status bar count work (file overlays kept).
8. Settings tab: form save applies to new sessions; API-key add masks and writes auth.json (0o600); JSON editor validation; Import pi configuration… button.
9. Two TUI tabs open at once both work (V1 keybindings check).
10. Window reload reopens TUI tabs bound to the same sessions.
11. ask_user tool shows a VSCode QuickPick.
12. ~/.pi untouched; storage lives under globalStorageUri/agent.
13. Copy inside the TUI (e.g. ctrl-c selection): expected to work if xterm handles OSC 52; otherwise a known limitation (no-op).
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-08-01-tui-in-webview-design.md
git commit -m "docs: mark TUI-in-webview spec as implemented"
```

---

## Self-Review (run at end)

1. **Spec coverage:** wipe (T3, T4) · terminal bridge (T1 patch, T2 terminal, T3 xterm) · lifecycle (T4) · integration (T4 settings no-op, T5 ask_user) · validation V1 (T5), V2 (T4/T6 F5), V3 (T4 stub command), V4 (T4 Step 2), V5 (T1 pinned patch) · acceptance criteria map to T6 checklist.
2. **Placeholder scan:** all code blocks complete; the two "stub" blocks in T4 Step 8 are intentional final code, not placeholders.
3. **Type consistency:** `TuiHostMessage`/`TuiWebviewMessage` identical in `src/tui/protocol.ts` and `webview-ui/src/terminal/protocol.ts`; `WebviewTerminal.handleReady/handleInput/handleResize` names match T2 tests and T4 Step 4 usage; `PanelState` fields match T4 Steps 1/3/5/6.
