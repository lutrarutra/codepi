# CodePi Settings GUI + Storage Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move CodePi's pi config out of `~/.pi` into VSCode's per-extension storage (`context.globalStorageUri`) and add a schema-driven settings GUI (plus JSON editor) as a tab in the existing PI sidebar.

**Architecture:** `activate()` sets `process.env.PI_CODING_AGENT_DIR = <globalStorageUri>/agent` before any SDK use, so pi's own code (SettingsManager, AuthStorage, ModelRegistry, SessionManager) reads/writes everything under that directory. A first-run prompt optionally imports the legacy `~/.pi/agent` config. The sidebar gets a second webview view (`codepi.settings`) toggled with the existing tree view via a `codepi.sidebarTab` context key and view `when` clauses. The settings webview renders a schema-driven form + JSON editor; the extension validates and writes the files (auth.json through pi's locked `AuthStorage`).

**Tech Stack:** TypeScript, VSCode extension API (WebviewViewProvider, globalStorageUri), pi SDK `@earendil-works/pi-coding-agent` 0.80.1 (dynamic imports only — it's ESM, extension bundle is CJS), React 18 + Vite 5 (second webview entry), vitest for unit tests, node:fs for atomic file writes.

## Global Constraints

- `PI_CODING_AGENT_DIR` env var is the single redirection mechanism; set in `activate()` before the first SDK call. Session dirs, settings, auth, models all follow it.
- All SDK imports in the extension MUST be dynamic (`await import(...)`) — the extension is a CJS esbuild bundle, the SDK is ESM-only.
- `auth.json` writes go through pi's `AuthStorage` (locked) or keep mode `0o600`; never wholesale-replace auth.json (preserve OAuth entries from chat `/login`).
- Existing API keys must never be sent to the webview as plaintext — send only presence (`hasKey`).
- The settings webview is a second Vite entry (`settings.html` → `assets/settings.js`); the chat entry keeps emitting `assets/index.js` so the existing `buildHtml` in `src/extension.ts:1262` keeps working.
- Root tsconfig has `"rootDir": "src"` → shared code goes in `src/shared/`; unit tests go in `src/__tests__/` (esbuild never imports them, so they don't get bundled).
- The 3 pre-existing lint errors in `src/tools/` must not be touched.
- `codepi.piPath` configuration stays as-is.

---

### Task 1: Shared settings schema + validator (+ vitest scaffolding)

**Files:**
- Create: `src/shared/pi-settings-schema.ts`
- Create: `src/__tests__/pi-settings-schema.test.ts`
- Modify: `package.json` (scripts.test, devDependencies.vitest)
- Create: `vitest.config.ts`

**Interfaces:**
- Produces: `SchemaField`, `SchemaSection`, `FIELD_TYPES`, `SETTINGS_SCHEMA: SchemaSection[]`, `validateSettings(value: unknown): string[]` — consumed by Task 5 (webview form renderer) and Task 4 (extension save path).

- [ ] **Step 1: Add vitest devDependency and test script**

Run: `cd /home/lutrarutra/dev/codepi && npm install --save-dev vitest@^3.0.0`

Then edit `package.json` scripts to add:
```jsonc
"test": "vitest run",
```
(`npm run lint` typechecks `src/**` including `src/__tests__/` — the tests use explicit `import { describe, it, expect } from "vitest"`, so no tsconfig changes are needed; `node:fs`/`node:path`/`node:os` resolve via the already-present `@types/node` dependency.)

Create `vitest.config.ts` at repo root:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/__tests__/**/*.test.ts"],
		environment: "node",
	},
});
```

- [ ] **Step 2: Write the failing test**

Create `src/__tests__/pi-settings-schema.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SETTINGS_SCHEMA, validateSettings } from "../shared/pi-settings-schema";

describe("validateSettings", () => {
	it("accepts an empty object", () => {
		expect(validateSettings({})).toEqual([]);
	});

	it("accepts a full valid settings object", () => {
		const valid = {
			defaultProvider: "openai",
			defaultModel: "gpt-4o",
			defaultThinkingLevel: "high",
			steeringMode: "one-at-a-time",
			hideThinkingBlock: true,
			quietStartup: true,
			defaultProjectTrust: "ask",
			shellCommandPrefix: "set -e",
			editorPaddingX: 8,
			autocompleteMaxVisible: 5,
			compaction: { enabled: true, reserveTokens: 16000 },
			retry: { enabled: true, maxRetries: 3 },
			enabledModels: ["openai/gpt-4o", "anthropic/claude"],
			skills: ["/home/me/skills"],
		};
		expect(validateSettings(valid)).toEqual([]);
	});

	it("rejects wrong types with field paths", () => {
		const bad = {
			hideThinkingBlock: "yes",
			editorPaddingX: "eight",
			compaction: { enabled: "true" },
			defaultThinkingLevel: "insane",
		};
		const errors = validateSettings(bad);
		expect(errors.some((e) => e.startsWith("hideThinkingBlock"))).toBe(true);
		expect(errors.some((e) => e.startsWith("editorPaddingX"))).toBe(true);
		expect(errors.some((e) => e.startsWith("compaction.enabled"))).toBe(true);
		expect(errors.some((e) => e.startsWith("defaultThinkingLevel"))).toBe(true);
	});

	it("covers every key of pi's Settings interface", () => {
		const keys = SETTINGS_SCHEMA.flatMap((s) => s.fields.map((f) => f.key));
		const expected = [
			"lastChangelogVersion", "defaultProvider", "defaultModel", "defaultThinkingLevel",
			"transport", "steeringMode", "followUpMode", "theme", "compaction",
			"branchSummary", "retry", "hideThinkingBlock", "shellPath", "quietStartup",
			"defaultProjectTrust", "shellCommandPrefix", "npmCommand", "collapseChangelog",
			"enableInstallTelemetry", "enableAnalytics", "trackingId", "packages",
			"extensions", "skills", "prompts", "themes", "enableSkillCommands",
			"terminal", "images", "enabledModels", "doubleEscapeAction",
			"treeFilterMode", "thinkingBudgets", "editorPaddingX",
			"autocompleteMaxVisible", "showHardwareCursor", "markdown", "warnings",
			"sessionDir", "httpProxy", "httpIdleTimeoutMs", "websocketConnectTimeoutMs",
		];
		for (const k of expected) {
			expect(keys).toContain(k);
		}
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /home/lutrarutra/dev/codepi && npm test`
Expected: FAIL — module `../shared/pi-settings-schema` not found.

- [ ] **Step 4: Write the schema module**

Create `src/shared/pi-settings-schema.ts`:
```ts
/**
 * Declarative schema mirroring pi's Settings interface
 * (@earendil-works/pi-coding-agent, dist/core/settings-manager.d.ts).
 * Shared by the extension (validation on save) and the settings webview
 * (form rendering). Keep field keys identical to the Settings interface.
 */

export type FieldType =
	| "string"
	| "number"
	| "boolean"
	| "enum"
	| "string[]"
	| "object";

export interface SchemaField {
	key: string;
	label: string;
	type: FieldType;
	/** For type "enum": allowed values. */
	options?: string[];
	help?: string;
}

export interface SchemaSection {
	id: string;
	title: string;
	fields: SchemaField[];
}

const f = (
	key: string,
	label: string,
	type: FieldType,
	options?: string[],
	help?: string,
): SchemaField => ({ key, label, type, options, help });

export const SETTINGS_SCHEMA: SchemaSection[] = [
	{
		id: "general",
		title: "General",
		fields: [
			f("defaultProvider", "Default provider", "string", undefined, "Provider name used when no model is specified"),
			f("defaultModel", "Default model", "string", undefined, "Model id used when none is selected"),
			f("defaultThinkingLevel", "Default thinking level", "enum", ["off", "minimal", "low", "medium", "high", "xhigh"]),
			f("transport", "Transport", "string", undefined, "Provider transport (auto/stdio/socket/http)"),
			f("theme", "Theme", "string"),
			f("defaultProjectTrust", "Default project trust", "enum", ["ask", "always", "never"]),
			f("doubleEscapeAction", "Double-escape action", "enum", ["fork", "tree", "none"]),
			f("treeFilterMode", "Tree filter mode", "enum", ["default", "no-tools", "user-only", "labeled-only", "all"]),
			f("quietStartup", "Quiet startup", "boolean"),
			f("collapseChangelog", "Collapse changelog", "boolean"),
			f("enableSkillCommands", "Enable skill commands", "boolean"),
			f("hideThinkingBlock", "Hide thinking block", "boolean"),
			f("showHardwareCursor", "Show hardware cursor", "boolean"),
		],
	},
	{
		id: "behavior",
		title: "Behavior",
		fields: [
			f("steeringMode", "Steering mode", "enum", ["all", "one-at-a-time"]),
			f("followUpMode", "Follow-up mode", "enum", ["all", "one-at-a-time"]),
			f("shellPath", "Shell path", "string"),
			f("shellCommandPrefix", "Shell command prefix", "string", undefined, "e.g. shopt -s expand_aliases"),
			f("npmCommand", "npm command", "string[]", undefined, "argv-style, e.g. [\"mise\",\"exec\",\"node@20\",\"--\",\"npm\"]"),
			f("sessionDir", "Session directory", "string", undefined, "Custom session storage directory"),
			f("httpProxy", "HTTP proxy URL", "string"),
			f("httpIdleTimeoutMs", "HTTP idle timeout (ms)", "number", undefined, "0 disables"),
			f("websocketConnectTimeoutMs", "WebSocket connect timeout (ms)", "number", undefined, "0 disables"),
			f("editorPaddingX", "Editor horizontal padding", "number"),
			f("autocompleteMaxVisible", "Autocomplete max visible", "number"),
			f("lastChangelogVersion", "Last changelog version", "string"),
			f("trackingId", "Tracking id", "string"),
			f("enableInstallTelemetry", "Enable install telemetry", "boolean"),
			f("enableAnalytics", "Enable analytics", "boolean"),
		],
	},
	{
		id: "compaction",
		title: "Compaction",
		fields: [
			f("compaction", "Compaction", "object", undefined, 'JSON: {"enabled":true,"reserveTokens":16000,"keepRecentTokens":20000}'),
		],
	},
	{
		id: "retry",
		title: "Retry",
		fields: [
			f("retry", "Retry", "object", undefined, 'JSON: {"enabled":true,"maxRetries":3,"baseDelayMs":1000,"provider":{"timeoutMs":60000}}'),
			f("branchSummary", "Branch summary", "object", undefined, 'JSON: {"reserveTokens":2048,"skipPrompt":false}'),
		],
	},
	{
		id: "resources",
		title: "Resources",
		fields: [
			f("packages", "Packages", "string[]", undefined, "npm/git package sources"),
			f("extensions", "Extensions", "string[]", undefined, "local extension paths"),
			f("skills", "Skills", "string[]", undefined, "local skill paths"),
			f("prompts", "Prompts", "string[]", undefined, "local prompt template paths"),
			f("themes", "Themes", "string[]", undefined, "local theme paths"),
			f("enabledModels", "Enabled models", "string[]", undefined, "model patterns for cycling (provider/model)"),
		],
	},
	{
		id: "terminal",
		title: "Terminal / Images",
		fields: [
			f("terminal", "Terminal", "object", undefined, 'JSON: {"showImages":true,"imageWidthCells":80,"clearOnShrink":false}'),
			f("images", "Images", "object", undefined, 'JSON: {"autoResize":true,"blockImages":false}'),
			f("thinkingBudgets", "Thinking budgets", "object", undefined, 'JSON: {"minimal":1000,"low":2000,"medium":4000,"high":8000}'),
			f("markdown", "Markdown", "object", undefined, 'JSON: {"codeBlockIndent":"  "}'),
			f("warnings", "Warnings", "object", undefined, 'JSON: {"anthropicExtraUsage":false}'),
		],
	},
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkField(path: string, field: SchemaField, value: unknown, errors: string[]): void {
	switch (field.type) {
		case "string":
			if (value !== undefined && typeof value !== "string") errors.push(`${path}: expected string`);
			break;
		case "number":
			if (value !== undefined && typeof value !== "number") errors.push(`${path}: expected number`);
			break;
		case "boolean":
			if (value !== undefined && typeof value !== "boolean") errors.push(`${path}: expected boolean`);
			break;
		case "enum":
			if (value !== undefined && !field.options?.includes(String(value))) {
				errors.push(`${path}: must be one of ${field.options?.join(", ")}`);
			}
			break;
		case "string[]":
			if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== "string"))) {
				errors.push(`${path}: expected array of strings`);
			}
			break;
		case "object":
			if (value !== undefined && !isPlainObject(value)) errors.push(`${path}: expected object`);
			else if (isPlainObject(value)) {
				for (const [k, v] of Object.entries(value)) {
					if (v !== undefined && !["string", "number", "boolean"].includes(typeof v) && !Array.isArray(v) && !isPlainObject(v)) {
						errors.push(`${path}.${k}: unsupported value`);
					}
				}
			}
			break;
	}
}

/** Returns field-path error strings; empty array when the value is valid. */
export function validateSettings(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (!isPlainObject(value)) return ["settings: expected object"];
	const errors: string[] = [];
	for (const section of SETTINGS_SCHEMA) {
		for (const field of section.fields) {
			const v = (value as Record<string, unknown>)[field.key];
			checkField(field.key, field, v, errors);
		}
	}
	return errors;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/lutrarutra/dev/codepi && npm test`
Expected: PASS (4 tests).

- [ ] **Step 6: Verify lint is unaffected**

Run: `cd /home/lutrarutra/dev/codepi && npm run lint`
Expected: exactly the 3 pre-existing errors in `src/tools/`.

- [ ] **Step 7: Commit**

```bash
cd /home/lutrarutra/dev/codepi
git add src/shared/pi-settings-schema.ts src/__tests__/pi-settings-schema.test.ts vitest.config.ts package.json package-lock.json
git commit -m "feat: shared pi settings schema + validator, vitest setup"
```

---

### Task 2: pi-store — pure filesystem core

**Files:**
- Create: `src/pi-store.ts`
- Create: `src/__tests__/pi-store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (consumed by Tasks 3, 4, 7):
  - `getAgentDir(): string` — `process.env.PI_CODING_AGENT_DIR` or `join(homedir(), ".pi", "agent")`
  - `setAgentDir(dir: string): void`
  - `getSettingsPath(): string`, `getAuthPath(): string`, `getModelsPath(): string`
  - `readJsonFile<T>(p: string): T | undefined` — undefined if missing; throws Error on parse failure
  - `writeJsonFileAtomic(p: string, value: unknown): void` — mkdir parent, tmp file + rename
  - `detectLegacyConfig(legacyAgentDir: string): { settings: boolean; auth: boolean; models: boolean } | undefined` — undefined when none of the three files exist
  - `importLegacyConfig(legacyAgentDir: string, targetAgentDir: string, opts: { includeSessions: boolean }): { imported: string[] }` — copies files; auth.json kept 0o600; sessions copied recursively when requested

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/pi-store.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	detectLegacyConfig,
	getAgentDir,
	importLegacyConfig,
	readJsonFile,
	setAgentDir,
	writeJsonFileAtomic,
} from "../pi-store";

let dir: string;
beforeEach(() => {
	dir = join(tmpdir(), `codepi-pistore-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("agent dir", () => {
	it("reads the env override", () => {
		process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
		expect(getAgentDir()).toBe(join(dir, "agent"));
	});
	it("setAgentDir writes the env override", () => {
		setAgentDir(join(dir, "a2"));
		expect(process.env.PI_CODING_AGENT_DIR).toBe(join(dir, "a2"));
	});
});

describe("readJsonFile / writeJsonFileAtomic", () => {
	it("returns undefined for missing files", () => {
		expect(readJsonFile(join(dir, "nope.json"))).toBeUndefined();
	});
	it("round-trips JSON", () => {
		const p = join(dir, "settings.json");
		writeJsonFileAtomic(p, { a: 1, b: [true] });
		expect(readJsonFile(p)).toEqual({ a: 1, b: [true] });
	});
	it("throws on malformed JSON", () => {
		const p = join(dir, "bad.json");
		writeFileSync(p, "{oops");
		expect(() => readJsonFile(p)).toThrow();
	});
	it("writes atomically (no tmp leftovers)", () => {
		const p = join(dir, "x.json");
		writeJsonFileAtomic(p, { v: 2 });
		const leftovers = readFileSync(p, "utf8");
		expect(leftovers).toContain('"v"');
		expect(
			existsSync(p + ".tmp") || existsSync(p + ".tmp.json") || readdirTmp(),
		).toBe(false);
	});
});

describe("detectLegacyConfig", () => {
	it("undefined when empty", () => {
		expect(detectLegacyConfig(dir)).toBeUndefined();
	});
	it("detects each file", () => {
		writeFileSync(join(dir, "settings.json"), "{}");
		expect(detectLegacyConfig(dir)).toEqual({ settings: true, auth: false, models: false });
	});
});

describe("importLegacyConfig", () => {
	it("copies config files and keeps auth 0o600", () => {
		const legacy = join(dir, "legacy");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"theme":"dark"}');
		writeFileSync(join(legacy, "auth.json"), '{"openai":{"type":"api_key","key":"sk-x"}}', { mode: 0o600 });
		const target = join(dir, "target");
		mkdirSync(target, { recursive: true });
		const res = importLegacyConfig(legacy, target, { includeSessions: false });
		expect(res.imported).toContain("settings.json");
		expect(res.imported).toContain("auth.json");
		expect(JSON.parse(readFileSync(join(target, "settings.json"), "utf8"))).toEqual({ theme: "dark" });
		const mode = (await import("node:fs")).statSync(join(target, "auth.json")).mode;
		expect(mode & 0o777).toBe(0o600);
	});
	it("copies sessions when requested", () => {
		const legacy = join(dir, "legacy");
		const sessions = join(legacy, "sessions", "proj");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "abc.json"), "{}");
		const target = join(dir, "target");
		mkdirSync(target, { recursive: true });
		importLegacyConfig(legacy, target, { includeSessions: true });
		expect(existsSync(join(target, "sessions", "proj", "abc.json"))).toBe(true);
	});
	it("skips sessions when not requested", () => {
		const legacy = join(dir, "legacy");
		mkdirSync(join(legacy, "sessions", "proj"), { recursive: true });
		writeFileSync(join(legacy, "sessions", "proj", "abc.json"), "{}");
		const target = join(dir, "target");
		mkdirSync(target, { recursive: true });
		importLegacyConfig(legacy, target, { includeSessions: false });
		expect(existsSync(join(target, "sessions"))).toBe(false);
	});
});

function readdirTmp(): boolean {
	const entries = (await import("node:fs")).readdirSync(dir);
	return entries.some((e) => e.includes(".tmp"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/lutrarutra/dev/codepi && npm test`
Expected: FAIL — `../pi-store` module not found.

- [ ] **Step 3: Write `src/pi-store.ts`**

```ts
/**
 * Pure filesystem core for CodePi's own pi config store.
 * NO vscode imports — unit-testable. The agent directory is redirected via
 * process.env.PI_CODING_AGENT_DIR (pi's own getAgentDir() reads it at call
 * time), so everything pi reads/writes lands in the extension's storage.
 */
import { homedir } from "node:os";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function setAgentDir(dir: string): void {
	process.env.PI_CODING_AGENT_DIR = dir;
}

export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Read a JSON file; undefined when missing; throws Error on parse failure. */
export function readJsonFile<T>(p: string): T | undefined {
	if (!existsSync(p)) return undefined;
	const raw = readFileSync(p, "utf8");
	try {
		return JSON.parse(raw) as T;
	} catch (err) {
		throw new Error(`Failed to parse ${p}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** Atomic write: tmp file in the same directory + rename. Creates parents. */
export function writeJsonFileAtomic(p: string, value: unknown): void {
	const dir = dirname(p);
	mkdirSync(dir, { recursive: true });
	const tmp = `${p}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
	renameSync(tmp, p);
}

export interface LegacyConfigDetected {
	settings: boolean;
	auth: boolean;
	models: boolean;
}

/** Detect existing config in a legacy agent dir (e.g. ~/.pi/agent). */
export function detectLegacyConfig(legacyAgentDir: string): LegacyConfigDetected | undefined {
	const found: LegacyConfigDetected = {
		settings: existsSync(join(legacyAgentDir, "settings.json")),
		auth: existsSync(join(legacyAgentDir, "auth.json")),
		models: existsSync(join(legacyAgentDir, "models.json")),
	};
	return found.settings || found.auth || found.models ? found : undefined;
}

export interface ImportResult {
	imported: string[];
}

/** Copy legacy config (and optionally sessions) into the target agent dir. */
export function importLegacyConfig(
	legacyAgentDir: string,
	targetAgentDir: string,
	opts: { includeSessions: boolean },
): ImportResult {
	mkdirSync(targetAgentDir, { recursive: true });
	const imported: string[] = [];
	for (const file of ["settings.json", "auth.json", "models.json"]) {
		const src = join(legacyAgentDir, file);
		if (!existsSync(src)) continue;
		const dest = join(targetAgentDir, file);
		cpSync(src, dest, { force: true });
		if (file === "auth.json") {
			// Keep pi's credential file permission: owner rw only.
			try {
				chmodSync(dest, 0o600);
			} catch {
				/* non-POSIX — ignore */
			}
		}
		imported.push(file);
	}
	if (opts.includeSessions) {
		const srcSessions = join(legacyAgentDir, "sessions");
		if (existsSync(srcSessions) && statSync(srcSessions).isDirectory()) {
			cpSync(srcSessions, join(targetAgentDir, "sessions"), {
				recursive: true,
				force: true,
			});
			imported.push("sessions/");
		}
	}
	return { imported };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/lutrarutra/dev/codepi && npm test`
Expected: PASS (11 tests across both suites).

- [ ] **Step 5: Commit**

```bash
cd /home/lutrarutra/dev/codepi
git add src/pi-store.ts src/__tests__/pi-store.test.ts
git commit -m "feat: pure fs core for pi config store (agent dir redirect, atomic writes, legacy import)"
```

---

### Task 3: Activation redirect, first-run import, dead-code removal

**Files:**
- Modify: `src/extension.ts` — activate() top (env redirect + mkdir + import prompt), remove unused `agentDir` const (line ~41), register import command
- Modify: `src/views/session-tree.ts` — remove unused `agentDir` field (lines ~85–90) and the now-unused `path` import if no longer referenced
- Modify: `package.json` — add `codepi.importPiConfig` command (see Task 4 for the other commands; adding it here with the others is fine — do the full package.json contributes edit in Task 4, here only the command registration lives in code)

**Interfaces:**
- Consumes: `src/pi-store.ts` (`setAgentDir`, `detectLegacyConfig`, `importLegacyConfig`, `getSettingsPath`, `getAuthPath`, `getModelsPath`), `getPi()` (existing).
- Produces: `agentDir` env redirected before any SDK use; `codepi.importPiConfig` command; the first-run prompt flow.

- [ ] **Step 1: Redirect agent dir at the top of `activate()`**

In `src/extension.ts`, at the very top of `activate(context)` (before `treeProvider = new SessionTreeProvider();`), insert:
```ts
	// Point pi's config/session storage at VSCode's dedicated extension
	// storage (globalStorageUri) instead of ~/.pi. Must run before any SDK
	// call — pi reads PI_CODING_AGENT_DIR at call time.
	const agentDir = path.join(context.globalStorageUri.fsPath, "agent");
	setAgentDir(agentDir);
	fs.mkdirSync(agentDir, { recursive: true });
```
Add imports to the top of `src/extension.ts`:
```ts
import * as fs from "node:fs";
import {
	detectLegacyConfig,
	importLegacyConfig,
	setAgentDir,
} from "./pi-store";
```
And DELETE the now-shadowed/duplicated module-level constant:
```ts
const agentDir = path.join(os.homedir(), ".pi", "agent");
```
(the `os` import is still used by `getWorkspaceRoot()` — keep it).

- [ ] **Step 2: First-run import prompt in `activate()`**

After the tree provider registration block in `activate()`, add:
```ts
	// First-run migration: offer to import an existing ~/.pi/agent config.
	const legacyDir = path.join(os.homedir(), ".pi", "agent");
	const legacy = detectLegacyConfig(legacyDir);
	const importAsked = context.globalState.get<boolean>("codepi.importPrompted", false);
	if (legacy && !importAsked) {
		await context.globalState.update("codepi.importPrompted", true);
		const choice = await vscode.window.showInformationMessage(
			"Found existing pi configuration at ~/.pi/agent. Import it into CodePi's own storage?",
			{ modal: false },
			"Import (config + sessions)",
			"Import config only",
			"Start fresh",
		);
		if (choice?.startsWith("Import")) {
			try {
				const res = importLegacyConfig(legacyDir, agentDir, {
					includeSessions: choice === "Import (config + sessions)",
				});
				const list = res.imported.join(", ");
				vscode.window.showInformationMessage(
					`Imported into CodePi storage: ${list || "nothing new"}.`,
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					`Failed to import pi config: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}
```

- [ ] **Step 3: Register the import command**

In `activate()`, inside the existing `context.subscriptions.push(...)` list of `registerCommand` calls (near the other commands, e.g. after `codepi.refreshSessions`), add:
```ts
		vscode.commands.registerCommand("codepi.importPiConfig", async () => {
			const choice = await vscode.window.showQuickPick(
				[
					{ label: "Import config + sessions", detail: "Copy settings.json, auth.json, models.json and the sessions/ folder" },
					{ label: "Import config only", detail: "Copy settings.json, auth.json, models.json" },
				],
				{ placeHolder: "Import pi configuration from ~/.pi/agent" },
			);
			if (!choice) return;
			try {
				const res = importLegacyConfig(legacyDir, agentDir, {
					includeSessions: choice.label.startsWith("Import config +"),
				});
				vscode.window.showInformationMessage(
					`Imported into CodePi storage: ${res.imported.join(", ") || "nothing new"}.`,
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					`Failed to import pi config: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
```

- [ ] **Step 4: Remove dead agentDir from the tree provider**

In `src/views/session-tree.ts`:
- Remove the field declaration `private agentDir: string;` (line ~85)
- Remove `this.agentDir = path.join(os.homedir(), ".pi", "agent");` (line ~89) from the constructor
- Remove the `path` import (`import * as path from "node:path";`) if `path` is no longer referenced anywhere in the file (check with `grep -n "path\." src/views/session-tree.ts`).

- [ ] **Step 5: Build + lint + test**

Run: `cd /home/lutrarutra/dev/codepi && npm run build && npm run lint && npm test`
Expected: build OK; lint = exactly the 3 pre-existing `src/tools/` errors; tests PASS.

- [ ] **Step 6: Manual verification (extension host)**

F5 the extension host. With an existing `~/.pi/agent` on the server, opening VSCode should show the import prompt once. Choose "Start fresh". Then confirm `~/.config/Code/User/globalStorage/lutrarutra.codepi/agent/` exists (the exact path shows in the Remote-SSH server's user dir) and that a new session's file lands under `…/agent/sessions/` (create a session and check the sessions tree + the folder).

- [ ] **Step 7: Commit**

```bash
cd /home/lutrarutra/dev/codepi
git add src/extension.ts src/views/session-tree.ts
git commit -m "feat: redirect pi config to globalStorage, first-run import prompt"
```

---

### Task 4: Settings sidebar — contributions, tab commands, view provider + protocol

**Files:**
- Create: `src/shared/settings-protocol.ts`
- Create: `src/settings-view.ts`
- Modify: `package.json` — `contributes.views`, `contributes.commands`, `contributes.menus`
- Modify: `src/extension.ts` — register the settings view provider, tab-toggle commands, `setContext` default

**Interfaces:**
- Consumes: `src/pi-store.ts` (read/write), `src/shared/pi-settings-schema.ts` (`validateSettings`), SDK dynamic import (AuthStorage, ModelRegistry, Settings types).
- Produces (consumed by Tasks 5–6 webview): the protocol types below; `settings:data` payload shape; `settings:saveSettings` / `settings:saveAuth` / `settings:saveModels` / `settings:saveJson` handling; `settings:openSessions` handling.

**Protocol** (`src/shared/settings-protocol.ts`, imported by the webview too — no vscode imports):
```ts
import type { Settings } from "@earendil-works/pi-coding-agent";

/** Webview → extension */
export type SettingsMessage =
	| { command: "settings:get" }
	| { command: "settings:saveSettings"; settings: Settings }
	| { command: "settings:saveAuth"; provider: string; key?: string; remove?: boolean }
	| { command: "settings:saveModels"; models: unknown }
	| { command: "settings:saveJson"; file: "settings" | "models"; text: string }
	| { command: "settings:importConfig" }
	| { command: "settings:openSessions" };

export interface AuthEntry {
	provider: string;
	type: "api_key" | "oauth";
	hasKey: boolean;
}

/** Extension → webview */
export type SettingsReply =
	| {
			command: "settings:data";
			settings: Settings;
			auth: AuthEntry[];
			models: unknown;
			modelsError?: string;
			catalog: Array<{ provider: string; modelId: string }>;
	  }
	| { command: "settings:saved"; ok: true; file?: string }
	| { command: "settings:error"; message: string; file?: string }
	| { command: "settings:importResult"; imported: string[]; message: string };
```
(Note: `import type { Settings } from "@earendil-works/pi-coding-agent"` in a type-only position is fine for the CJS bundle — it's erased at compile time. If tsc complains about importing the ESM SDK type in the webview tsconfig, change the import in the webview copy to a local `export interface SettingsRecord { [k: string]: unknown }` — see Task 5 step 1.)

- [ ] **Step 1: package.json contributions**

Edit `contributes.views["codepi-sessions"]` to:
```jsonc
"views": {
  "codepi-sessions": [
    {
      "id": "codepi.sessionsList",
      "name": "Sessions",
      "when": "codepi.sidebarTab == sessions"
    },
    {
      "id": "codepi.settings",
      "name": "Settings",
      "type": "webview",
      "when": "codepi.sidebarTab == settings"
    }
  ]
}
```
Add to `contributes.commands`:
```jsonc
{ "command": "codepi.openSettingsTab", "title": "Open CodePi Settings" },
{ "command": "codepi.openSessionsTab", "title": "Open CodePi Sessions" },
{ "command": "codepi.importPiConfig", "title": "CodePi: Import pi Configuration…" }
```
Add to `contributes.menus` a `view/title` entry (the existing `view/title` array gets a new item):
```jsonc
{
  "command": "codepi.openSettingsTab",
  "when": "view == codepi.sessionsList",
  "icon": "$(gear)"
}
```

- [ ] **Step 2: Create `src/settings-view.ts`**

```ts
import * as vscode from "vscode";
import { getAgentDir, readJsonFile, writeJsonFileAtomic, getSettingsPath, getModelsPath, getAuthPath, importLegacyConfig } from "./pi-store";
import { validateSettings } from "./shared/pi-settings-schema";
import type { AuthEntry, SettingsMessage, SettingsReply } from "./shared/settings-protocol";
import * as path from "node:path";
import * as os from "node:os";
import type { Settings } from "@earendil-works/pi-coding-agent";

let sdkPromise: Promise<typeof import("@earendil-works/pi-coding-agent")> | undefined;
function getSdk(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
	if (!sdkPromise) {
		sdkPromise = import("@earendil-works/pi-coding-agent");
	}
	return sdkPromise;
}

export class SettingsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = "codepi.settings";

	private view: vscode.WebviewView | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly onConfigSaved: () => void,
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "webview-ui", "dist")],
		};
		webviewView.webview.html = buildSettingsHtml(this.extensionUri, webviewView.webview);

		webviewView.webview.onDidReceiveMessage((msg: SettingsMessage) => {
			void this.handleMessage(msg);
		});
	}

	private async handleMessage(msg: SettingsMessage): Promise<void> {
		try {
			switch (msg.command) {
				case "settings:get":
					await this.sendData();
					break;
				case "settings:saveSettings":
					await this.saveSettings(msg.settings);
					break;
				case "settings:saveAuth":
					await this.saveAuth(msg.provider, msg.key, msg.remove === true);
					break;
				case "settings:saveModels":
					await this.saveModels(msg.models);
					break;
				case "settings:saveJson":
					await this.saveJson(msg.file, msg.text);
					break;
				case "settings:importConfig": {
					const choice = await vscode.window.showQuickPick(
						[
							{ label: "Import config + sessions", detail: "Copy settings.json, auth.json, models.json and the sessions/ folder" },
							{ label: "Import config only", detail: "Copy settings.json, auth.json, models.json" },
						],
						{ placeHolder: "Import pi configuration from ~/.pi/agent" },
					);
					if (!choice) return;
					const legacyDir = path.join(os.homedir(), ".pi", "agent");
					const res = importLegacyConfig(legacyDir, getAgentDir(), {
						includeSessions: choice.label.startsWith("Import config +"),
					});
					this.post({ command: "settings:importResult", imported: res.imported, message: res.imported.join(", ") || "nothing new" });
					this.onConfigSaved();
					break;
				}
				case "settings:openSessions":
					await vscode.commands.executeCommand("codepi.openSessionsTab");
					break;
			}
		} catch (err) {
			this.post({
				command: "settings:error",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private post(msg: SettingsReply): void {
		this.view?.webview.postMessage(msg);
	}

	private async saveModels(models: unknown): Promise<void> {
		const modelsPath = getModelsPath();
		// Keep the previous content so a pi-validation failure can roll back.
		const previous = readJsonFile<unknown>(modelsPath);
		writeJsonFileAtomic(modelsPath, models);
		const sdk = await getSdk();
		const registry = sdk.ModelRegistry.create(sdk.AuthStorage.create(getAuthPath()), modelsPath);
		registry.refresh();
		const err = registry.getError();
		if (err) {
			if (previous !== undefined) {
				try {
					writeJsonFileAtomic(modelsPath, previous);
				} catch {
					/* best effort rollback */
				}
			}
			this.post({ command: "settings:error", message: err, file: "models.json" });
			return;
		}
		this.post({ command: "settings:saved", ok: true, file: "models.json" });
		this.onConfigSaved();
	}

	private async saveJson(file: "settings" | "models", text: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			this.post({
				command: "settings:error",
				message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
				file,
			});
			return;
		}
		if (file === "settings") {
			const errors = validateSettings(parsed);
			if (errors.length > 0) {
				this.post({ command: "settings:error", message: errors.join("\n"), file });
				return;
			}
			writeJsonFileAtomic(getSettingsPath(), parsed);
			this.post({ command: "settings:saved", ok: true, file });
		} else {
			// models.json — validated by pi's own loader; saveModels posts the result.
			await this.saveModels(parsed);
		}
	}

	private async sendData(): Promise<void> {
		const sdk = await getSdk();
		const auth = sdk.AuthStorage.create(getAuthPath());
		const registry = sdk.ModelRegistry.create(auth, getModelsPath());
		registry.refresh();
		const modelsError = registry.getError();
		const models = readJsonFile<unknown>(getModelsPath());
		const settings = readJsonFile<Settings>(getSettingsPath()) ?? {};
		const catalog: Array<{ provider: string; modelId: string }> = registry
			.getAll()
			.map((m: any) => ({ provider: String(m.provider ?? ""), modelId: String(m.id ?? "") }))
			.filter((m) => m.provider && m.modelId);
		const authEntries: AuthEntry[] = [];
		for (const provider of auth.list()) {
			const cred = auth.get(provider);
			authEntries.push({
				provider,
				type: cred?.type === "oauth" ? "oauth" : "api_key",
				hasKey: !!cred && cred.type === "api_key" && !!cred.key,
			});
		}
		this.post({ command: "settings:data", settings, auth: authEntries, models, modelsError, catalog });
	}

	private async saveSettings(settings: Settings): Promise<void> {
		const errors = validateSettings(settings);
		if (errors.length > 0) {
			this.post({ command: "settings:error", message: errors.join("\n"), file: "settings.json" });
			return;
		}
		writeJsonFileAtomic(getSettingsPath(), settings);
		this.post({ command: "settings:saved", ok: true, file: "settings.json" });
		this.onConfigSaved();
	}

	private async saveAuth(provider: string, key: string | undefined, remove: boolean): Promise<void> {
		if (!provider) {
			this.post({ command: "settings:error", message: "Provider name required", file: "auth.json" });
			return;
		}
		const sdk = await getSdk();
		const auth = sdk.AuthStorage.create(getAuthPath());
		if (remove) {
			auth.remove(provider);
		} else {
			if (!key) {
				this.post({ command: "settings:error", message: `API key for ${provider} is empty`, file: "auth.json" });
				return;
			}
			auth.set(provider, { type: "api_key", key });
		}
		this.post({ command: "settings:saved", ok: true, file: "auth.json" });
		this.onConfigSaved();
	}


}

function buildSettingsHtml(extensionUri: vscode.Uri, webview: vscode.Webview): string {
	const distUri = vscode.Uri.joinPath(extensionUri, "webview-ui", "dist");
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "settings.js"));
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "index.css"));
	const nonce = getNonce();
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" crossorigin href="${styleUri}" />
  <title>PI Settings</title>
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
Note: the `settings:saveModels` rollback is best-effort (pi surfaces `modelsError` in the GUI via the next `settings:get`); if a stricter rollback is wanted, keep a previous-content variable — Task 6's GUI reloads data on error anyway.

- [ ] **Step 3: Register provider + tab commands in `src/extension.ts`**

Add to `activate()` (near the tree provider registration):
Context: `refreshPanelModels` does not exist until Task 7 — register the callback as an empty stub here so the build passes, and Task 7 step 2 replaces it.

```ts
	// Settings sidebar tab (toggled with the Sessions tree via codepi.sidebarTab)
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			SettingsViewProvider.viewType,
			new SettingsViewProvider(context.extensionUri, () => {
				// Real implementation lands in Task 7 (refreshPanelModels).
			}),
			{ webviewOptions: { retainContextWhenHidden: true } },
		),
	);
	vscode.commands.registerCommand("codepi.openSettingsTab", () =>
		vscode.commands.executeCommand("setContext", "codepi.sidebarTab", "settings"),
	);
	vscode.commands.registerCommand("codepi.openSessionsTab", () =>
		vscode.commands.executeCommand("setContext", "codepi.sidebarTab", "sessions"),
	);
	await vscode.commands.executeCommand("setContext", "codepi.sidebarTab", "sessions");
```
Add the import at the top of `src/extension.ts`:
```ts
import { SettingsViewProvider } from "./settings-view";
```
(`refreshPanelModels` is created in Task 7 — until then, to keep this task compiling, register the callback as an empty stub `() => {}` and replace it in Task 7. The plan's Task 7 step 2 swaps in the real call.)

- [ ] **Step 4: Build + lint**

Run: `cd /home/lutrarutra/dev/codepi && npm run build && npm run lint`
Expected: build OK; lint = only the 3 pre-existing errors. If `import type { Settings } from "@earendil-works/pi-coding-agent"` in `settings-protocol.ts` triggers a tsc error under the extension tsconfig (ESM types in a CJS project), change it to `export interface SettingsRecord { [key: string]: unknown }` and use that type everywhere in the protocol instead.

- [ ] **Step 5: Manual verification**

F5. The PI activity-bar icon should still show Sessions. Click the gear in the Sessions view title → the view should switch to an (empty, unstyled) Settings webview; the tab strip and form arrive in Tasks 5–6. Clicking around must not break the sessions tree.

- [ ] **Step 6: Commit**

```bash
cd /home/lutrarutra/dev/codepi
git add package.json src/extension.ts src/settings-view.ts src/shared/settings-protocol.ts
git commit -m "feat: settings sidebar view provider, tab commands, view when-clauses"
```

---

### Task 5: Settings webview app — entry, shell, schema form

**Files:**
- Create: `webview-ui/settings.html`
- Create: `webview-ui/src/settings/main.tsx`
- Create: `webview-ui/src/settings/App.tsx`
- Create: `webview-ui/src/settings/components/FormSection.tsx`
- Create: `webview-ui/src/settings/settings.css`
- Modify: `webview-ui/vite.config.ts` (multi-entry)
- Modify: `webview-ui/src/settings/types.ts` (local mirror of the protocol — see note in Task 4 protocol)

**Interfaces:**
- Consumes: `settings:get`/`settings:data`, `settings:saveSettings`, `settings:openSessions` (Task 4), `SETTINGS_SCHEMA` + `validateSettings` (Task 1, imported from `../../src/shared/pi-settings-schema`).
- Produces: the rendered Form tab with General/Advanced sections and a working save flow; the JSON tab shell (functional editor added in Task 6); the `[Sessions] [Settings]` tab strip.

- [ ] **Step 1: Local protocol types in the webview**

Create `webview-ui/src/settings/types.ts`:
```ts
/** Local mirror of src/shared/settings-protocol.ts (avoids importing the
 *  ESM-only SDK type into the webview tsconfig). */

export interface SettingsRecord {
	[key: string]: unknown;
}

export interface AuthEntry {
	provider: string;
	type: "api_key" | "oauth";
	hasKey: boolean;
}

export interface CatalogEntry {
	provider: string;
	modelId: string;
}

export type SettingsMessage =
	| { command: "settings:get" }
	| { command: "settings:saveSettings"; settings: SettingsRecord }
	| { command: "settings:saveAuth"; provider: string; key?: string; remove?: boolean }
	| { command: "settings:saveModels"; models: unknown }
	| { command: "settings:saveJson"; file: "settings" | "models"; text: string }
	| { command: "settings:importConfig" }
	| { command: "settings:openSessions" };

export type SettingsReply =
	| {
			command: "settings:data";
			settings: SettingsRecord;
			auth: AuthEntry[];
			models: unknown;
			modelsError?: string;
			catalog: CatalogEntry[];
	  }
	| { command: "settings:saved"; ok: true; file?: string }
	| { command: "settings:error"; message: string; file?: string }
	| { command: "settings:importResult"; imported: string[]; message: string };
```

- [ ] **Step 2: Multi-entry Vite config**

Replace `webview-ui/vite.config.ts` with:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	build: {
		outDir: "dist",
		rollupOptions: {
			input: {
				index: "index.html",
				settings: "settings.html",
			},
			output: {
				entryFileNames: "assets/[name].js",
				chunkFileNames: "assets/[name].js",
				assetFileNames: "assets/index.css",
			},
		},
	},
});
```
The chat entry keeps emitting `assets/index.js` (input key `index`); the settings entry emits `assets/settings.js` — matches `buildHtml` and `buildSettingsHtml`.

- [ ] **Step 3: Create `webview-ui/settings.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CodePi Settings</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/settings/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create `webview-ui/src/settings/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { SettingsApp } from "./App";
import "./settings.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<SettingsApp />
	</React.StrictMode>,
);
```

- [ ] **Step 5: Create the schema form renderer `webview-ui/src/settings/components/FormSection.tsx`**

```tsx
import React from "react";
import type { SchemaField } from "../../../../src/shared/pi-settings-schema";
import type { SettingsRecord } from "../types";

interface Props {
	title: string;
	fields: SchemaField[];
	settings: SettingsRecord;
	onChange: (key: string, value: unknown) => void;
}

function stringify(v: unknown): string {
	return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v, null, 2);
}

/** Renders one schema field into a control. */
export function FormSection({ title, fields, settings, onChange }: Props): JSX.Element {
	return (
		<section className="settings-section">
			<h3 className="settings-section-title">{title}</h3>
			{fields.map((field) => (
				<FieldRow key={field.key} field={field} settings={settings} onChange={onChange} />
			))}
		</section>
	);
}

function FieldRow({ field, settings, onChange }: { field: SchemaField; settings: SettingsRecord; onChange: (k: string, v: unknown) => void }): JSX.Element {
	const value = settings[field.key];
	return (
		<div className="settings-row">
			<label className="settings-label" htmlFor={`f-${field.key}`} title={field.help ?? ""}>
				{field.label}
			</label>
			<div className="settings-control">
				{field.type === "boolean" ? (
					<input
						id={`f-${field.key}`}
						type="checkbox"
						checked={value === true}
						onChange={(e) => onChange(field.key, e.target.checked || undefined)}
					/>
				) : field.type === "enum" ? (
					<select
						id={`f-${field.key}`}
						value={typeof value === "string" ? value : ""}
						onChange={(e) => onChange(field.key, e.target.value || undefined)}
					>
						<option value="">(default)</option>
						{(field.options ?? []).map((o) => (
							<option key={o} value={o}>{o}</option>
						))}
					</select>
				) : field.type === "string[]" ? (
					<input
						id={`f-${field.key}`}
						value={Array.isArray(value) ? value.join(", ") : ""}
						placeholder="comma-separated"
						onChange={(e) =>
							onChange(
								field.key,
								e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
							)
						}
					/>
				) : field.type === "object" ? (
					<textarea
						id={`f-${field.key}`}
						rows={3}
						value={stringify(value)}
						placeholder="{}"
						onChange={(e) => {
							const t = e.target.value.trim();
							if (!t) return onChange(field.key, undefined);
							try {
								onChange(field.key, JSON.parse(t));
							} catch {
								/* keep last valid value; validation will surface on save */
							}
						}}
					/>
				) : field.type === "number" ? (
					<input
						id={`f-${field.key}`}
						type="number"
						value={typeof value === "number" ? value : ""}
						onChange={(e) => {
							const n = e.target.value === "" ? undefined : Number(e.target.value);
							onChange(field.key, n);
						}}
					/>
				) : (
					<input
						id={`f-${field.key}`}
						type="text"
						value={typeof value === "string" ? value : ""}
						onChange={(e) => onChange(field.key, e.target.value || undefined)}
					/>
				)}
				{field.help ? <p className="settings-help">{field.help}</p> : null}
			</div>
		</div>
	);
}
```

- [ ] **Step 6: Create the app shell `webview-ui/src/settings/App.tsx`**

```tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { SETTINGS_SCHEMA, validateSettings } from "../../../src/shared/pi-settings-schema";
import { FormSection } from "./components/FormSection";
import type { SettingsMessage, SettingsRecord, SettingsReply } from "./types";

const vscode = acquireVsCodeApi();

const TAB_STRIP = [
	{ id: "sessions", label: "Sessions", active: false },
	{ id: "settings", label: "Settings", active: true },
];

export function SettingsApp(): JSX.Element {
	const [settings, setSettings] = useState<SettingsRecord | null>(null);
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState<string>("");
	const [tab, setTab] = useState<"form" | "json">("form");
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		const onMsg = (e: MessageEvent<SettingsReply>) => {
			const msg = e.data;
			switch (msg.command) {
				case "settings:data":
					setSettings(msg.settings ?? {});
					setLoaded(true);
					setStatus("");
					break;
				case "settings:saved":
					setDirty(false);
					setStatus(`Saved ${msg.file ?? ""}`.trim());
					break;
				case "settings:error":
					setStatus(`Error: ${msg.message}`);
					break;
				case "settings:importResult":
					setStatus(`Imported: ${msg.message || "nothing new"}`);
					setLoaded(true);
					break;
			}
		};
		window.addEventListener("message", onMsg);
		post({ command: "settings:get" });
		return () => window.removeEventListener("message", onMsg);
	}, []);

	const post = useCallback((m: SettingsMessage) => vscode.postMessage(m), []);

	const onChange = useCallback((key: string, value: unknown) => {
		setSettings((prev) => {
			if (!prev) return prev;
			const next = { ...prev, [key]: value };
			return next;
		});
		setDirty(true);
	}, []);

	const save = useCallback(() => {
		if (!settings) return;
		const errors = validateSettings(settings);
		if (errors.length > 0) {
			setStatus(`Validation: ${errors.join("; ")}`);
			return;
		}
		post({ command: "settings:saveSettings", settings });
	}, [settings, post]);

	const generalSection = useMemo(
		() => SETTINGS_SCHEMA.find((s) => s.id === "general"),
		[],
	);
	const advancedSections = useMemo(
		() => SETTINGS_SCHEMA.filter((s) => s.id !== "general"),
		[],
	);

	if (!loaded) {
		return (
			<div className="settings-page">
				<div className="settings-loading">Loading settings…</div>
			</div>
		);
	}

	return (
		<div className="settings-page">
			<div className="settings-tabstrip">
				{TAB_STRIP.map((t) => (
					<button
						key={t.id}
						className={`settings-tab ${t.active ? "settings-tab-active" : ""}`}
						onClick={() => t.id === "sessions" && post({ command: "settings:openSessions" })}
					>
						{t.label}
					</button>
				))}
			</div>
			<div className="settings-inner-tabs">
				<button
					className={`settings-inner-tab ${tab === "form" ? "settings-inner-tab-active" : ""}`}
					onClick={() => setTab("form")}
				>
					Form
				</button>
				<button
					className={`settings-inner-tab ${tab === "json" ? "settings-inner-tab-active" : ""}`}
					onClick={() => setTab("json")}
				>
					JSON editor
				</button>
			</div>
			{tab === "form" ? (
				<div className="settings-form">
					{generalSection && (
						<FormSection
							title={generalSection.title}
							fields={generalSection.fields}
							settings={settings}
							onChange={onChange}
						/>
					)}
					{advancedSections.map((s) => (
						<FormSection
							key={s.id}
							title={s.title}
							fields={s.fields}
							settings={settings}
							onChange={onChange}
						/>
					))}
					<div className="settings-actions">
						<button className="settings-save" onClick={save} disabled={!dirty}>
							Save settings
						</button>
						<span className="settings-status">{status}</span>
					</div>
					<p className="settings-note">
						Saved settings apply to new sessions. API keys apply to the next message.
					</p>
				</div>
			) : (
				<JsonEditorShell
					key="json"
					settings={settings}
					post={post}
					status={status}
					setStatus={setStatus}
					onDirty={() => setDirty(true)}
				/>
			)}
		</div>
	);
}

// Minimal JSON editor shell (full editor in Task 6).
function JsonEditorShell(props: {
	settings: SettingsRecord | null;
	post: (m: SettingsMessage) => void;
	status: string;
	setStatus: (s: string) => void;
	onDirty: () => void;
}): JSX.Element {
	const [file, setFile] = useState<"settings" | "models">("settings");
	const [text, setText] = useState("");
	const [modelsText, setModelsText] = useState("");
	useEffect(() => {
		setText(JSON.stringify(props.settings ?? {}, null, 2));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	return (
		<div className="settings-json">
			<select value={file} onChange={(e) => setFile(e.target.value as "settings" | "models")}>
				<option value="settings">settings.json</option>
				<option value="models">models.json</option>
			</select>
			<textarea
				className="settings-json-text"
				rows={16}
				value={file === "settings" ? text : modelsText}
				onChange={(e) => {
					props.onDirty();
					if (file === "settings") setText(e.target.value);
					else setModelsText(e.target.value);
				}}
			/>
			<button
				className="settings-save"
				onClick={() => {
					props.post({
						command: "settings:saveJson",
						file,
						text: file === "settings" ? text : modelsText,
					});
				}}
			>
				Validate &amp; Save
			</button>
			<span className="settings-status">{props.status}</span>
		</div>
	);
}
```

- [ ] **Step 7: Create `webview-ui/src/settings/settings.css`**

```css
.settings-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  font-size: 13px;
}

.settings-tabstrip {
  display: flex;
  border-bottom: 1px solid var(--vscode-editorWidget-border, #333);
  flex-shrink: 0;
}

.settings-tab {
  background: transparent;
  border: none;
  color: var(--vscode-foreground, #ccc);
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
}

.settings-tab-active {
  border-bottom: 2px solid var(--vscode-focusBorder, #007fd4);
  font-weight: 600;
}

.settings-inner-tabs {
  display: flex;
  padding: 4px 0 0;
  border-bottom: 1px solid var(--vscode-editorWidget-border, #333);
  flex-shrink: 0;
}

.settings-inner-tab {
  background: transparent;
  border: none;
  color: var(--vscode-foreground, #ccc);
  padding: 4px 12px;
  cursor: pointer;
}

.settings-inner-tab-active {
  font-weight: 600;
  border-bottom: 2px solid var(--vscode-focusBorder, #007fd4);
}

.settings-form {
  flex: 1;
  overflow-y: auto;
  padding: 8px 14px 24px;
}

.settings-section {
  margin-bottom: 18px;
  border: 1px solid var(--vscode-editorWidget-border, #333);
  border-radius: 4px;
  padding: 8px 12px;
}

.settings-section-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}

.settings-row {
  display: flex;
  flex-direction: column;
  margin-bottom: 8px;
}

.settings-label {
  font-size: 12px;
  margin-bottom: 2px;
  opacity: 0.9;
}

.settings-control input[type="text"],
.settings-control input[type="number"],
.settings-control select,
.settings-control textarea {
  width: 100%;
  box-sizing: border-box;
  background: var(--vscode-input-background, #1e1e1e);
  color: var(--vscode-input-foreground, #ddd);
  border: 1px solid var(--vscode-input-border, #444);
  padding: 3px 6px;
}

.settings-help {
  font-size: 11px;
  opacity: 0.6;
  margin: 2px 0 0;
}

.settings-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.settings-save {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none;
  padding: 5px 14px;
  cursor: pointer;
  border-radius: 3px;
}

.settings-save:disabled {
  opacity: 0.5;
  cursor: default;
}

.settings-status {
  font-size: 12px;
  opacity: 0.85;
}

.settings-note {
  font-size: 11px;
  opacity: 0.6;
  margin-top: 8px;
}

.settings-json {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 14px 24px;
  overflow: hidden;
}

.settings-json-text {
  flex: 1;
  min-height: 120px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  background: var(--vscode-input-background, #1e1e1e);
  color: var(--vscode-input-foreground, #ddd);
  border: 1px solid var(--vscode-input-border, #444);
}

.settings-loading {
  padding: 16px;
  opacity: 0.6;
}
```

- [ ] **Step 8: Build both webviews**

Run: `cd /home/lutrarutra/dev/codepi && npm run build:webview`
Expected: `dist/assets/index.js` AND `dist/assets/settings.js` both emitted.

- [ ] **Step 9: Manual verification**

F5 → gear → Settings tab. Expect: tab strip `[Sessions][Settings]`, Form/JSON inner tabs, General + Advanced sections render from the schema, editing a field enables "Save settings", saving writes `settings.json` in `globalStorage/…/agent/settings.json` (check the file), status shows "Saved settings.json". Clicking "Sessions" in the strip switches back to the tree.

- [ ] **Step 10: Commit**

```bash
cd /home/lutrarutra/dev/codepi
git add webview-ui/settings.html webview-ui/vite.config.ts webview-ui/src/settings
git commit -m "feat: settings webview shell + schema-driven form with save flow"
```

---

### Task 6: API keys, custom models, JSON editor

**Files:**
- Create: `webview-ui/src/settings/components/AuthKeys.tsx`
- Create: `webview-ui/src/settings/components/ModelsEditor.tsx`
- Modify: `webview-ui/src/settings/App.tsx` — render AuthKeys + ModelsEditor in the form, replace the JSON shell with the full editor; keep `modelsText` synced from `settings:data`
- Modify: `webview-ui/src/settings/types.ts` — nothing (protocol already covers auth/models)

**Interfaces:**
- Consumes: `settings:data` (auth: AuthEntry[], models, modelsError, catalog), `settings:saveAuth`, `settings:saveModels`, `settings:saveJson`, `settings:importConfig`.
- Produces: form sections "Provider API keys" and "Custom models"; a working JSON editor tab with line-level errors.

- [ ] **Step 1: Write `AuthKeys.tsx`**

```tsx
import React, { useMemo, useState } from "react";
import type { AuthEntry, CatalogEntry, SettingsMessage } from "../types";

interface Props {
	auth: AuthEntry[];
	catalog: CatalogEntry[];
	post: (m: SettingsMessage) => void;
}

export function AuthKeys({ auth, catalog, post }: Props): JSX.Element {
	const [provider, setProvider] = useState("");
	const [keyValue, setKeyValue] = useState("");
	const [editing, setEditing] = useState<Record<string, string>>({});

	const availableProviders = useMemo(() => {
		const configured = new Set(auth.map((a) => a.provider));
		return catalog
			.map((c) => c.provider)
			.filter((p, i, arr) => arr.indexOf(p) === i && !configured.has(p))
			.sort();
	}, [auth, catalog]);

	const saveKey = (prov: string) => {
		const k = (editing[prov] ?? "").trim();
		if (!k) return;
		post({ command: "settings:saveAuth", provider: prov, key: k });
		setEditing((prev) => ({ ...prev, [prov]: "" }));
	};

	return (
		<section className="settings-section">
			<h3 className="settings-section-title">Provider API keys</h3>
			{auth.length === 0 && <p className="settings-help">No stored credentials yet.</p>}
			{auth.map((entry) => (
				<div className="settings-row" key={entry.provider}>
					<label className="settings-label">
						{entry.provider}{" "}
						{entry.type === "oauth" ? "(OAuth — managed by pi login)" : ""}
					</label>
					<div className="settings-control">
						{entry.type === "api_key" ? (
							<>
								<input
									type="password"
									placeholder={entry.hasKey ? "•••••• (unchanged)" : "API key"}
									value={editing[entry.provider] ?? ""}
									onChange={(e) =>
										setEditing((prev) => ({ ...prev, [entry.provider]: e.target.value }))
									}
								/>
								<div className="settings-actions">
									<button
										className="settings-save"
										disabled={!(editing[entry.provider] ?? "").trim()}
										onClick={() => saveKey(entry.provider)}
									>
										Save key
									</button>
									<button
										className="settings-save"
										onClick={() =>
											post({ command: "settings:saveAuth", provider: entry.provider, remove: true })
										}
									>
										Remove
									</button>
								</div>
							</>
						) : (
							<p className="settings-help">Logged in via OAuth; tokens are not shown.</p>
						)}
					</div>
				</div>
			))}
			{availableProviders.length > 0 && (
				<div className="settings-row">
					<label className="settings-label">Add provider</label>
					<div className="settings-control">
						<select value={provider} onChange={(e) => setProvider(e.target.value)}>
							<option value="">Select…</option>
							{availableProviders.map((p) => (
								<option key={p} value={p}>{p}</option>
							))}
						</select>
						<input
							type="password"
							placeholder="API key"
							value={keyValue}
							onChange={(e) => setKeyValue(e.target.value)}
						/>
						<button
							className="settings-save"
							disabled={!provider || !keyValue.trim()}
							onClick={() => {
								post({ command: "settings:saveAuth", provider, key: keyValue.trim() });
								setKeyValue("");
								setProvider("");
							}}
						>
							Add
						</button>
					</div>
				</div>
			)}
		</section>
	);
}
```

- [ ] **Step 2: Write `ModelsEditor.tsx`**

```tsx
import React, { useMemo, useState } from "react";
import type { SettingsMessage } from "../types";

interface ProviderConfig {
	models?: unknown[];
	[key: string]: unknown;
}
interface ModelsFile {
	providers?: Record<string, ProviderConfig>;
}

interface Props {
	models: unknown;
	modelsError?: string;
	post: (m: SettingsMessage) => void;
	openInJson: (provider: string) => void;
}

export function ModelsEditor({ models, modelsError, post, openInJson }: Props): JSX.Element {
	const [newProvider, setNewProvider] = useState("");
	const file = useMemo<ModelsFile>(() => {
		const m = models as ModelsFile | null;
		return m && typeof m === "object" ? m : {};
	}, [models]);
	const providers = Object.entries(file.providers ?? {});

	const update = (next: ModelsFile) => post({ command: "settings:saveModels", models: next });

	return (
		<section className="settings-section">
			<h3 className="settings-section-title">Custom models</h3>
			{modelsError && <p className="settings-help" style={{ color: "#d29922" }}>models.json error: {modelsError}</p>}
			{providers.length === 0 && <p className="settings-help">No custom models yet — add a provider below.</p>}
			{providers.map(([name, cfg]) => (
				<div className="settings-row" key={name}>
					<label className="settings-label">{name} ({Array.isArray(cfg.models) ? cfg.models.length : 0} models)</label>
					<div className="settings-control">
						<button className="settings-save" onClick={() => openInJson(name)}>Edit JSON</button>
						<button
							className="settings-save"
							onClick={() => {
								const next = { ...file, providers: { ...file.providers } };
								delete next.providers![name];
								update(next);
							}}
						>
							Remove provider
						</button>
					</div>
				</div>
			))}
			<div className="settings-row">
				<label className="settings-label">Add provider</label>
				<div className="settings-control">
					<input
						type="text"
						placeholder="provider id (e.g. mycorp)"
						value={newProvider}
						onChange={(e) => setNewProvider(e.target.value)}
					/>
					<button
						className="settings-save"
						disabled={!newProvider.trim()}
						onClick={() => {
							const next = {
								...file,
								providers: {
									...(file.providers ?? {}),
									[newProvider.trim()]: { models: [] },
								},
							};
							update(next);
							setNewProvider("");
						}}
					>
						Add provider
					</button>
				</div>
			</div>
			<p className="settings-help">
				Provider configs (models, baseUrl, headers, modelOverrides…) are edited as JSON —
				pi validates models.json on load and its errors are shown above.
			</p>
		</section>
	);
}
```

- [ ] **Step 3: Full JSON editor + wire sections into `App.tsx`**

Replace the entire content of `webview-ui/src/settings/App.tsx` with the complete app below (state for `auth`/`models`/`modelsError`/`catalog`/`jsonPrefill`, the keys + models sections in the form, and the full JSON editor with prefill support):

```tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { SETTINGS_SCHEMA, validateSettings } from "../../../src/shared/pi-settings-schema";
import { FormSection } from "./components/FormSection";
import { AuthKeys } from "./components/AuthKeys";
import { ModelsEditor } from "./components/ModelsEditor";
import type { AuthEntry, SettingsMessage, SettingsRecord, SettingsReply } from "./types";

const vscode = acquireVsCodeApi();

const TAB_STRIP = [
	{ id: "sessions", label: "Sessions", active: false },
	{ id: "settings", label: "Settings", active: true },
];

export function SettingsApp(): JSX.Element {
	const [settings, setSettings] = useState<SettingsRecord | null>(null);
	const [auth, setAuth] = useState<AuthEntry[]>([]);
	const [models, setModels] = useState<unknown>({ providers: {} });
	const [modelsError, setModelsError] = useState<string | undefined>(undefined);
	const [catalog, setCatalog] = useState<Array<{ provider: string; modelId: string }>>([]);
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState<string>("");
	const [tab, setTab] = useState<"form" | "json">("form");
	const [loaded, setLoaded] = useState(false);
	const [jsonPrefill, setJsonPrefill] = useState<string | undefined>(undefined);

	const post = useCallback((m: SettingsMessage) => vscode.postMessage(m), []);

	useEffect(() => {
		const onMsg = (e: MessageEvent<SettingsReply>) => {
			const msg = e.data;
			switch (msg.command) {
				case "settings:data":
					setSettings(msg.settings ?? {});
					setAuth(msg.auth ?? []);
					setModels(msg.models ?? { providers: {} });
					setModelsError(msg.modelsError);
					setCatalog(msg.catalog ?? []);
					setLoaded(true);
					setStatus("");
					break;
				case "settings:saved":
					setDirty(false);
					setStatus(`Saved ${msg.file ?? ""}`.trim());
					break;
				case "settings:error":
					setStatus(`Error: ${msg.message}`);
					break;
				case "settings:importResult":
					setStatus(`Imported: ${msg.message || "nothing new"}`);
					setLoaded(true);
					post({ command: "settings:get" });
					break;
			}
		};
		window.addEventListener("message", onMsg);
		post({ command: "settings:get" });
		return () => window.removeEventListener("message", onMsg);
	}, [post]);

	const onChange = useCallback((key: string, value: unknown) => {
		setSettings((prev) => {
			if (!prev) return prev;
			return { ...prev, [key]: value };
		});
		setDirty(true);
	}, []);

	const save = useCallback(() => {
		if (!settings) return;
		const errors = validateSettings(settings);
		if (errors.length > 0) {
			setStatus(`Validation: ${errors.join("; ")}`);
			return;
		}
		post({ command: "settings:saveSettings", settings });
	}, [settings, post]);

	const generalSection = useMemo(
		() => SETTINGS_SCHEMA.find((s) => s.id === "general"),
		[],
	);
	const advancedSections = useMemo(
		() => SETTINGS_SCHEMA.filter((s) => s.id !== "general"),
		[],
	);

	if (!loaded) {
		return (
			<div className="settings-page">
				<div className="settings-loading">Loading settings…</div>
			</div>
		);
	}

	return (
		<div className="settings-page">
			<div className="settings-tabstrip">
				{TAB_STRIP.map((t) => (
					<button
						key={t.id}
						className={`settings-tab ${t.active ? "settings-tab-active" : ""}`}
						onClick={() => t.id === "sessions" && post({ command: "settings:openSessions" })}
					>
						{t.label}
					</button>
				))}
			</div>
			<div className="settings-inner-tabs">
				<button
					className={`settings-inner-tab ${tab === "form" ? "settings-inner-tab-active" : ""}`}
					onClick={() => setTab("form")}
				>
					Form
				</button>
				<button
					className={`settings-inner-tab ${tab === "json" ? "settings-inner-tab-active" : ""}`}
					onClick={() => setTab("json")}
				>
					JSON editor
				</button>
			</div>
			{tab === "form" ? (
				<div className="settings-form">
					{generalSection && (
						<FormSection
							title={generalSection.title}
							fields={generalSection.fields}
							settings={settings}
							onChange={onChange}
						/>
					)}
					<AuthKeys auth={auth} catalog={catalog} post={post} />
					<ModelsEditor
						models={models}
						modelsError={modelsError}
						post={post}
						openInJson={(provider) => {
							setJsonPrefill(provider);
							setTab("json");
						}}
					/>
					{advancedSections.map((s) => (
						<FormSection
							key={s.id}
							title={s.title}
							fields={s.fields}
							settings={settings}
							onChange={onChange}
						/>
					))}
					<div className="settings-actions">
						<button className="settings-save" onClick={save} disabled={!dirty}>
							Save settings
						</button>
						<button
							className="settings-save"
							onClick={() => {
								post({ command: "settings:get" });
								setDirty(false);
							}}
						>
							Reload
						</button>
						<span className="settings-status">{status}</span>
					</div>
					<p className="settings-note">
						Saved settings apply to new sessions. API keys apply to the next message.
					</p>
				</div>
			) : (
				<JsonEditor
					settings={settings}
					models={models}
					prefillProvider={jsonPrefill}
					post={post}
					status={status}
					setStatus={setStatus}
					onDirty={() => setDirty(true)}
				/>
			)}
		</div>
	);
}

function JsonEditor(props: {
	settings: SettingsRecord | null;
	models: unknown;
	prefillProvider?: string;
	post: (m: SettingsMessage) => void;
	status: string;
	setStatus: (s: string) => void;
	onDirty: () => void;
}): JSX.Element {
	const [file, setFile] = useState<"settings" | "models">("settings");
	const [text, setText] = useState("");
	const [modelsText, setModelsText] = useState("");
	const [error, setError] = useState("");

	useEffect(() => {
		setText(JSON.stringify(props.settings ?? {}, null, 2));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.settings]);
	useEffect(() => {
		if (props.prefillProvider) {
			const m = props.models as { providers?: Record<string, unknown> } | null;
			const cfg = m?.providers?.[props.prefillProvider];
			setModelsText(
				JSON.stringify(
					{ providers: { [props.prefillProvider]: cfg ?? { models: [] } } },
					null,
					2,
				),
			);
			setFile("models");
			props.setStatus(`Editing ${props.prefillProvider} in models.json`);
		} else if (props.prefillProvider === undefined) {
			setModelsText(JSON.stringify(props.models ?? { providers: {} }, null, 2));
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.models, props.prefillProvider]);

	const current = file === "settings" ? text : modelsText;
	const setCurrent = (v: string) => {
		props.onDirty();
		if (file === "settings") setText(v);
		else setModelsText(v);
		setError("");
	};

	return (
		<div className="settings-json">
			<div className="settings-inner-tabs">
				<select value={file} onChange={(e) => setFile(e.target.value as "settings" | "models")}>
					<option value="settings">settings.json</option>
					<option value="models">models.json</option>
				</select>
			</div>
			<textarea
				className="settings-json-text"
				value={current}
				spellCheck={false}
				onChange={(e) => setCurrent(e.target.value)}
			/>
			{error && (
				<p className="settings-help" style={{ color: "#d29922", whiteSpace: "pre-wrap" }}>{error}</p>
			)}
			<div className="settings-actions">
				<button
					className="settings-save"
					onClick={() => {
						try {
							JSON.parse(current);
						} catch (err) {
							setError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
							return;
						}
						props.post({ command: "settings:saveJson", file, text: current });
					}}
				>
					Validate &amp; Save
				</button>
				<span className="settings-status">{props.status}</span>
			</div>
		</div>
	);
}
```

- [ ] **Step 4: Build + verify**

Run: `cd /home/lutrarutra/dev/codepi && npm run build:webview && npm run lint`
Expected: build OK (both entries), lint = 3 pre-existing errors only. Watch for unused-import lint from removing `JsonEditorShell` — delete it fully.

- [ ] **Step 5: Manual verification**

F5 → gear → Settings. Add an API key for a provider (e.g. openrouter) → file `…/agent/auth.json` contains `{ "openrouter": { "type": "api_key", "key": "…" } }` with mode 0o600; the row shows "•••••• (unchanged)" and the key text is NOT in the webview DOM. Remove works. Add a custom provider in the models section → `models.json` gains `{ "providers": { "mycorp": { "models": [] } } }`; entering invalid JSON in the editor shows the parse error and doesn't write. `[Sessions]` in the tab strip returns to the tree.

- [ ] **Step 6: Commit**

```bash
cd /home/lutrarutra/dev/codepi
git add webview-ui/src/settings
git commit -m "feat: api keys editor, custom models editor, JSON editor with validation"
```

---

### Task 7: Hot-apply to open chat panels

**Files:**
- Modify: `src/extension.ts` — extract `refreshPanelModels(state)` from the inline model-list code in `startBackend`; wire it as the `onConfigSaved` callback (replace the Task 4 stub); repost `modelInfo` when the current model is no longer in the list.

**Interfaces:**
- Consumes: `PanelState`, `panels` map, the existing model-list building code in `startBackend` (~lines 845–870).
- Produces: `refreshPanelModels(state: PanelState): void` — rebuilds the model list from the session's registry (calling `registry.refresh()` first so models.json changes apply), posts `modelList`, and if the current model disappeared, posts an updated `modelInfo` + an informational `error` message.

- [ ] **Step 1: Extract the model-list builder**

In `src/extension.ts`, cut the block in `startBackend` that builds `models` (from `const models: Array<{ provider: string; modelId: string }> = [];` through the `state.panel.webview.postMessage({ command: "modelList", models });` call) and replace it with:
```ts
	refreshPanelModels(state);
```
Then add this function (place it near `startBackend`):
```ts
/** Rebuild and repost the model list to a chat panel, re-reading models.json
 *  from disk so custom-model and API-key changes hot-apply. */
function refreshPanelModels(state: PanelState): void {
	try {
		const registry: any = (state.session as any).modelRegistry;
		if (!registry) return;
		try {
			registry.refresh?.();
		} catch {
			/* refresh optional on some versions */
		}
		const all: any[] = registry.getAll?.() ?? registry.getAvailable?.() ?? [];
		const models: Array<{ provider: string; modelId: string }> = [];
		for (const m of all) {
			const prov = String(m.provider ?? "");
			const mid = String(m.id ?? "");
			if (prov && mid) models.push({ provider: prov, modelId: mid });
		}
		if (state.session?.model) {
			const curProv = String((state.session.model as any).provider ?? "");
			const curId = String((state.session.model as any).id ?? "");
			if (!models.some((m) => m.provider === curProv && m.modelId === curId)) {
				models.unshift({ provider: curProv, modelId: curId });
			}
		}
		state.panel.webview.postMessage({ command: "modelList", models });
	} catch (err) {
		console.error("[CodePi] refreshPanelModels error:", err);
	}
}
```

- [ ] **Step 2: Use it as the onConfigSaved callback**

Replace the Task 4 stub registration:
```ts
new SettingsViewProvider(context.extensionUri, () => {
	for (const [, st] of panels) {
		refreshPanelModels(st);
	}
}),
```
(That is exactly what was written in Task 4 step 3 — with `refreshPanelModels` now real, the same loop posts fresh `modelList`s to every open chat panel after an auth/models/settings save.)

- [ ] **Step 3: Build + lint + test**

Run: `cd /home/lutrarutra/dev/codepi && npm run build && npm run lint && npm test`
Expected: build OK; lint = 3 pre-existing errors; tests PASS.

- [ ] **Step 4: Manual verification**

Open a chat session, then in Settings change an API key. Back in chat, the model selector should still work; sending a message after a key change should use the new key (verify via a provider that previously errored "No API key for provider").

- [ ] **Step 5: Commit**

```bash
cd /home/lutrarutra/dev/codepi
git add src/extension.ts
git commit -m "feat: hot-apply config changes to open chat panels"
```

---

### Task 8: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full build, lint, tests**

Run: `cd /home/lutrarutra/dev/codepi && npm run build && npm run lint && npm test`
Expected: build OK; lint = exactly the 3 pre-existing `src/tools/` errors; `npm test` green.

- [ ] **Step 2: Verify packaged contents**

Run: `cd /home/lutrarutra/dev/codepi && npx vsce ls 2>/dev/null | grep -E "webview-ui/dist/assets/(index|settings)\.js|media/codepi-logo\.woff|dist/extension\.js" || echo "vsce not available — skip"`
Expected: all four paths listed (ensures the second webview bundle is packaged).

- [ ] **Step 3: Manual end-to-end checklist (F5)**

1. Fresh extension storage: import prompt appears once when `~/.pi/agent` has config; choosing "Start fresh" never re-prompts.
2. New chat session file lands in `globalStorage/…/agent/sessions/`.
3. Sessions tree lists sessions from the new location (create + reopen).
4. Gear in Sessions title → Settings webview with `[Sessions] [Settings]` strip; both directions work.
5. Form: edit General + Advanced fields, Save → `settings.json` written; validation errors inline on bad input.
6. Keys: add/remove a provider key; `auth.json` 0o600; key masked in the UI.
7. Models: add provider, edit JSON, invalid JSON blocked with line info.
8. JSON editor tab: parse + schema validation errors shown, no write on error.
9. Hot-apply: model list in an open chat panel refreshes after a models.json save.
10. pi CLI untouched: `~/.pi/agent/settings.json` unchanged by any extension action.

- [ ] **Step 4: Update the design doc's status**

Edit `docs/superpowers/specs/2026-07-31-settings-gui-design.md`, add at the top under the heading:
```markdown
> **Status:** Implemented 2026-07-31. See `docs/superpowers/plans/2026-07-31-settings-gui.md`.
```
and commit:
```bash
cd /home/lutrarutra/dev/codepi
git add docs/superpowers/specs/2026-07-31-settings-gui-design.md
git commit -m "docs: mark settings GUI spec as implemented"
```

---

## Self-Review Notes

- **Deviation from spec (documented):** the models section uses per-provider JSON editing (list + structured add/remove provider) instead of form fields for every model property — pi's models.json is a deep typebox schema and a partial form would mislead; the JSON editor validates against pi's own loader and surfaces its errors.
- **Deviation from spec (documented):** env-var-name credential entry was dropped — pi 0.80.1 stores only key values in `auth.json` (`ApiKeyCredential.key`); env-based keys come from process env/models.json and are out of GUI scope.
- **Hot-apply (pinned):** settings.json → new sessions (GUI notes it); auth.json → next message (pi resolves at request time); models.json → open panels refresh their model list via `registry.refresh()`.
