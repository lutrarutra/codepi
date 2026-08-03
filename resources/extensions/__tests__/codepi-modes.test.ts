import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import codepiModesFactory, {
	DEFAULT_ASK_ALLOWED_TOOLS,
	READ_ONLY_TOOL_BASELINE,
	getAskModeAllowlist,
	readAskAllowedTools,
} from "../codepi-modes";

// ── Hermetic settings ────────────────────────────────────────

let settingsDir: string;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	settingsDir = mkdtempSync(join(tmpdir(), "codepi-modes-test-"));
	process.env.PI_CODING_AGENT_DIR = settingsDir;
});

afterEach(() => {
	rmSync(settingsDir, { recursive: true, force: true });
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

/** Write codepi.modes.ask.allowedTools into the hermetic settings.json. */
function writeAskAllowedTools(tools: string[]): void {
	const path = join(settingsDir, "settings.json");
	mkdirSync(settingsDir, { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({ codepi: { modes: { ask: { allowedTools: tools } } } }),
	);
}

// ── Mock helpers ─────────────────────────────────────────────

type Handler = (event: any, ctx: any) => unknown;
type CommandHandler = (args: string, ctx: any) => Promise<void>;
type ToolCallResult = { block?: boolean; reason?: string } | undefined;
type PromptResult = { systemPrompt?: string; message?: unknown } | undefined;

const MODE_ENTRY_TYPE = "codepi-modes:mode";

/** Tools present in a default session (before any mode restriction). */
const DEFAULT_TOOLS = [
	"bash",
	"read",
	"grep",
	"find",
	"ls",
	"edit",
	"write",
	"todo",
	"ask_user_question",
];

function createMockPi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: CommandHandler }>();
	let activeTools = [...DEFAULT_TOOLS];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];

	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (tools: string[]) => {
			activeTools = [...tools];
		},
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ customType, data });
		},
		sendMessage: vi.fn(),
	};

	return { api, handlers, commands, entries, statuses, getActiveTools: () => activeTools, setActiveTools: (t: string[]) => (activeTools = [...t]) };
}

function createBranchEntry(customType: string, data: unknown) {
	return { type: "custom", customType, data, id: Math.random().toString(36), branch: [] };
}

function createCtx(overrides: Record<string, unknown> = {}) {
	const confirm = vi.fn().mockResolvedValue(true);
	const notify = vi.fn();
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const ctx = {
		sessionManager: {
			getBranch: () => (overrides.branch as unknown[]) ?? [],
		},
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				statuses.push({ key, text });
			},
			notify,
			confirm,
		},
		hasUI: true,
		waitForIdle: async () => {},
	};
	return { ctx: { ...ctx, ...overrides } as any, notify, confirm, statuses };
}

/** Load the extension against a fresh mock pi. */
function load() {
	const mock = createMockPi();
	codepiModesFactory(mock.api as any);
	return mock;
}

/** Invoke the session_start handler (replays persisted mode + applies tools). */
async function startSession(mock: ReturnType<typeof load>, branch: unknown[] = []) {
	const handler = mock.handlers.get("session_start")?.[0];
	expect(handler).toBeDefined();
	const { ctx, notify, confirm, statuses } = createCtx({ branch });
	await handler!({ type: "session_start", reason: "startup" }, ctx);
	return { ctx, notify, confirm, statuses };
}

/** Invoke a registered command's handler. */
async function runCommand(
	mock: ReturnType<typeof load>,
	name: string,
	opts: { branch?: unknown[]; confirmResult?: boolean } = {},
) {
	const command = mock.commands.get(name);
	expect(command, `command /${name} not registered`).toBeDefined();
	const notify = vi.fn();
	const confirm = vi.fn().mockResolvedValue(opts.confirmResult ?? true);
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const ctx = {
		sessionManager: { getBranch: () => opts.branch ?? [] },
		ui: {
			setStatus: (key: string, text: string | undefined) =>
				statuses.push({ key, text }),
			notify,
			confirm,
		},
		hasUI: true,
		waitForIdle: async () => {},
	} as any;
	await command!.handler("", ctx);
	return { ctx, notify, confirm, statuses };
}

async function emitToolCall(
	mock: ReturnType<typeof load>,
	toolName: string,
	opts: { branch?: unknown[] } = {},
) {
	const handler = mock.handlers.get("tool_call")?.[0];
	expect(handler).toBeDefined();
	const { ctx, notify } = createCtx({ branch: opts.branch ?? [] });
	const result = (await handler!(
		{ type: "tool_call", toolName, toolCallId: "t1", input: {} },
		ctx,
	)) as ToolCallResult;
	return { result, notify };
}

async function emitBeforeAgentStart(
	mock: ReturnType<typeof load>,
	opts: { branch?: unknown[] } = {},
) {
	const handler = mock.handlers.get("before_agent_start")?.[0];
	expect(handler).toBeDefined();
	const { ctx } = createCtx({ branch: opts.branch ?? [] });
	const basePrompt = "BASE SYSTEM PROMPT";
	const result = (await handler!(
		{
			type: "before_agent_start",
			prompt: "hello",
			images: undefined,
			systemPrompt: basePrompt,
			systemPromptOptions: {},
		},
		ctx,
	)) as PromptResult;
	return { result, basePrompt };
}

// ── Tests ────────────────────────────────────────────────────

describe("codepi-modes: registration", () => {
	it("registers the three mode commands and session/agent event handlers", () => {
		const mock = load();
		for (const name of ["codepi-ask", "codepi-plan", "codepi-implement"]) {
			expect(mock.commands.has(name), `/${name}`).toBe(true);
		}
		for (const event of [
			"session_start",
			"tool_call",
			"before_agent_start",
		]) {
			expect(mock.handlers.has(event), event).toBe(true);
		}
	});
});

describe("codepi-modes: mode recovery on session_start", () => {
	it("defaults to implement for a new session with no mode entries", async () => {
		const mock = load();
		const { statuses } = await startSession(mock, []);
		expect(statuses).toContainEqual({ key: "codepi-modes", text: "IMPLEMENT" });
		// No tool restriction applied in implement mode.
		expect(mock.getActiveTools()).toEqual(DEFAULT_TOOLS);
	});

	it("replays a persisted ask mode and heals stripped tools", async () => {
		const mock = load();
		await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" }),
		]);
		// Ask mode does NOT remove edit/write: they stay registered and the
		// tool_call backstop blocks them with a clear reason instead (a removed
		// tool produces a confusing "Tool edit not found" error).
		expect(mock.getActiveTools()).toContain("edit");
		expect(mock.getActiveTools()).toContain("write");
		expect(mock.getActiveTools()).toContain("read");
	});

	it("heals a session that stripped edit/write under the old behavior", async () => {
		const mock = load();
		mock.setActiveTools(
			DEFAULT_TOOLS.filter((t) => t !== "edit" && t !== "write"),
		);
		await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" }),
		]);
		expect(mock.getActiveTools()).toContain("edit");
		expect(mock.getActiveTools()).toContain("write");
	});

	it("replays a persisted plan mode without restricting tools", async () => {
		const mock = load();
		await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "plan" }),
		]);
		expect(mock.getActiveTools()).toEqual(DEFAULT_TOOLS);
	});

	it("uses the latest mode entry when multiple are present", async () => {
		const mock = load();
		await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" }),
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "plan" }),
		]);
		expect(mock.getActiveTools()).toEqual(DEFAULT_TOOLS);
		const { statuses } = await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" }),
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "implement" }),
		]);
		expect(statuses).toContainEqual({ key: "codepi-modes", text: "IMPLEMENT" });
	});

	it("ignores malformed mode entries and keeps the previous mode", async () => {
		const mock = load();
		await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "banana" }),
			createBranchEntry(MODE_ENTRY_TYPE, { mode: 42 }),
		]);
		expect(mock.getActiveTools()).toEqual(DEFAULT_TOOLS);
	});
});

describe("codepi-modes: tool restrictions", () => {
	it("keeps edit/write registered when switching to ask (blocked via tool_call)", async () => {
		const mock = load();
		await startSession(mock, []);
		await runCommand(mock, "codepi-ask");
		expect(mock.getActiveTools()).toEqual(DEFAULT_TOOLS);
	});

	it("restores edit/write when recovering a non-ask mode after tools were stripped", async () => {
		const mock = load();
		// Simulate stripped tools (e.g. a prior ask-mode restriction that
		// another extension removed, or tool state from a previous session).
		mock.setActiveTools(
			DEFAULT_TOOLS.filter((t) => t !== "edit" && t !== "write"),
		);
		await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "plan" }),
		]);
		// Order-insensitive: restored tools append at the end.
		expect([...mock.getActiveTools()].sort()).toEqual([...DEFAULT_TOOLS].sort());
	});

	it("does not touch tools when switching implement → plan", async () => {
		const mock = load();
		await startSession(mock, []);
		await runCommand(mock, "codepi-plan");
		expect(mock.getActiveTools()).toEqual(DEFAULT_TOOLS);
	});
});

describe("codepi-modes: mode transitions", () => {
	it("allows implement → ask", async () => {
		const mock = load();
		await startSession(mock, []);
		const { statuses, notify } = await runCommand(mock, "codepi-ask");
		expect(statuses).toContainEqual({ key: "codepi-modes", text: "ASK" });
		expect(notify).toHaveBeenCalledWith(
			"Switched to Ask mode (read-only).",
			"info",
		);
	});

	it("allows implement → plan", async () => {
		const mock = load();
		await startSession(mock, []);
		const { statuses } = await runCommand(mock, "codepi-plan");
		expect(statuses).toContainEqual({ key: "codepi-modes", text: "PLAN" });
	});

	it("allows ask → plan (manual user upgrade)", async () => {
		const mock = load();
		await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" }),
		]);
		const { statuses, notify } = await runCommand(mock, "codepi-plan");
		expect(statuses.at(-1)).toEqual({ key: "codepi-modes", text: "PLAN" });
		expect(notify).toHaveBeenCalledWith(
			"Switched to Plan mode (planning only).",
			"info",
		);
	});

	it("allows ask → implement (manual user upgrade)", async () => {
		const mock = load();
		await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" }),
		]);
		const { statuses } = await runCommand(mock, "codepi-implement");
		expect(statuses.at(-1)).toEqual({ key: "codepi-modes", text: "IMPLEMENT" });
	});

	it("allows plan → ask (manual user choice)", async () => {
		const mock = load();
		await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "plan" }),
		]);
		const { statuses } = await runCommand(mock, "codepi-ask");
		expect(statuses.at(-1)).toEqual({ key: "codepi-modes", text: "ASK" });
	});

	it("plan → implement requires user confirmation", async () => {
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "plan" })]);
		const { confirm } = await runCommand(mock, "codepi-implement");
		expect(confirm).toHaveBeenCalled();
	});

	it("stays in plan when the user declines the confirmation", async () => {
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "plan" })]);
		const { statuses, notify } = await runCommand(mock, "codepi-implement", {
			confirmResult: false,
		});
		expect(statuses).toHaveLength(0);
		expect(notify).toHaveBeenCalledWith("Stayed in Plan mode.", "info");
	});

	it("switches to implement when the user confirms", async () => {
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "plan" })]);
		const { statuses } = await runCommand(mock, "codepi-implement", {
			confirmResult: true,
		});
		expect(statuses.at(-1)).toEqual({ key: "codepi-modes", text: "IMPLEMENT" });
	});

	it("no-ops when already in the target mode", async () => {
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" })]);
		const { notify } = await runCommand(mock, "codepi-ask");
		expect(notify).toHaveBeenCalledWith(
			"Already in Ask mode (read-only).",
			"info",
		);
	});
});

describe("codepi-modes: mode-change notice to the agent", () => {
	it("notifies the agent when switching ask → implement (tools now enabled)", async () => {
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" })]);
		await runCommand(mock, "codepi-implement");
		expect(mock.api.sendMessage).toHaveBeenCalledTimes(1);
		const [message, options] = mock.api.sendMessage.mock.calls[0];
		expect(message.customType).toBe("codepi-modes:changed");
		expect(message.content).toContain("IMPLEMENT");
		expect(message.content).toContain("edit` and `write` tools are enabled");
		expect(message.content).toContain("no longer apply");
		expect(options).toEqual({ deliverAs: "nextTurn" });
	});

	it("notifies the agent when switching implement → ask (tools now blocked)", async () => {
		const mock = load();
		await startSession(mock, []);
		await runCommand(mock, "codepi-ask");
		expect(mock.api.sendMessage).toHaveBeenCalledTimes(1);
		const [message] = mock.api.sendMessage.mock.calls[0];
		expect(message.content).toContain("ASK (READ-ONLY)");
		expect(message.content).toContain("third-party extension tools");
		expect(message.content).toContain("BLOCKED");
	});

	it("notifies the agent on plan switches", async () => {
		const mock = load();
		await startSession(mock, []);
		await runCommand(mock, "codepi-plan");
		const [message] = mock.api.sendMessage.mock.calls[0];
		expect(message.content).toContain("PLAN (PLANNING ONLY)");
	});

	it("does not notify on a no-op transition", async () => {
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" })]);
		await runCommand(mock, "codepi-ask");
		expect(mock.api.sendMessage).not.toHaveBeenCalled();
	});

	it("does not notify on session_start (fresh session, instructions handle it)", async () => {
		const mock = load();
		await startSession(mock, []);
		expect(mock.api.sendMessage).not.toHaveBeenCalled();
	});
});

describe("codepi-modes: tool_call blocking in ask mode", () => {
	it("blocks edit with a reason in ask mode", async () => {
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" })]);
		const { result, notify } = await emitToolCall(mock, "edit");
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("Ask (read-only)"),
		});
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Ask mode is read-only"),
			"warning",
		);
	});

	it("blocks write in ask mode", async () => {
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" })]);
		const { result } = await emitToolCall(mock, "write");
		expect(result?.block).toBe(true);
	});

	it("allows read-only tools but blocks bash in ask mode", async () => {
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" })]);
		for (const tool of [
			...READ_ONLY_TOOL_BASELINE,
		]) {
			const { result } = await emitToolCall(mock, tool);
			expect(result, tool).toBeUndefined();
		}
		const { result } = await emitToolCall(mock, "bash");
		expect(result?.block, "bash should be blocked").toBe(true);
	});

	it("blocks third-party extension tools in ask mode", async () => {
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" })]);
		for (const tool of ["subagent", "subagent_wait", "intercom", "todo"]) {
			const { result, notify } = await emitToolCall(mock, tool);
			expect(result?.block, tool).toBe(true);
			expect(result?.reason, tool).toContain("not a read-only tool");
			expect(notify, tool).toHaveBeenCalledWith(
				expect.stringContaining("codepi.modes.ask.allowedTools"),
				"warning",
			);
		}
	});

	it("allows tools whitelisted in codepi.modes.ask.allowedTools", async () => {
		writeAskAllowedTools(["web_search", "fetch_content"]);
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" })]);
		const allowed = await emitToolCall(mock, "web_search");
		expect(allowed.result).toBeUndefined();
		const allowed2 = await emitToolCall(mock, "fetch_content");
		expect(allowed2.result).toBeUndefined();
		// Non-whitelisted extension tools stay blocked.
		const blocked = await emitToolCall(mock, "web_crawl");
		expect(blocked.result?.block).toBe(true);
	});

	it("does not block edit/write in implement mode", async () => {
		const mock = load();
		await startSession(mock, []);
		for (const tool of ["edit", "write"]) {
			const { result } = await emitToolCall(mock, tool);
			expect(result, tool).toBeUndefined();
		}
	});

	it("does not block edit/write in plan mode", async () => {
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "plan" })]);
		for (const tool of ["edit", "write"]) {
			const { result } = await emitToolCall(mock, tool);
			expect(result, tool).toBeUndefined();
		}
	});

	it("does not block extension tools in plan/implement modes", async () => {
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "plan" })]);
		for (const tool of ["subagent", "todo", "bash"]) {
			const { result } = await emitToolCall(mock, tool);
			expect(result, tool).toBeUndefined();
		}
	});
});

describe("codepi-modes: system prompt injection", () => {
	it("injects ask instructions and preserves the base prompt", async () => {
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" })]);
		const { result, basePrompt } = await emitBeforeAgentStart(mock);
		expect(result.systemPrompt.startsWith(basePrompt)).toBe(true);
		expect(result.systemPrompt).toContain("## MODE: ASK (READ-ONLY)");
		expect(result.systemPrompt).toContain("cannot modify or create files");
	});

	it("injects plan instructions for plan mode", async () => {
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "plan" })]);
		const { result } = await emitBeforeAgentStart(mock);
		expect(result.systemPrompt).toContain("## MODE: PLAN (PLANNING ONLY)");
		expect(result.systemPrompt).toContain("ask_user_question");
		expect(result.systemPrompt).toContain("/codepi-implement");
	});

	it("returns nothing in implement mode (default pi behavior)", async () => {
		const mock = load();
		await startSession(mock, []);
		const { result } = await emitBeforeAgentStart(mock);
		expect(result).toBeUndefined();
	});
});

describe("codepi-modes: persistence and footer status", () => {
	it("appends a mode entry on every mode switch", async () => {
		const mock = load();
		await startSession(mock, []);
		await runCommand(mock, "codepi-plan");
		await runCommand(mock, "codepi-implement", { confirmResult: true });
		const modeEntries = mock.entries.filter(
			(e) => e.customType === MODE_ENTRY_TYPE,
		);
		expect(modeEntries.map((e) => (e.data as { mode: string }).mode)).toEqual([
			"plan",
			"implement",
		]);
	});

	it("does not append an entry for a no-op transition", async () => {
		const mock = load();
		await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" }),
		]);
		await runCommand(mock, "codepi-ask"); // already in ask → no-op
		const modeEntries = mock.entries.filter(
			(e) => e.customType === MODE_ENTRY_TYPE,
		);
		expect(modeEntries).toHaveLength(0);
	});

	it("pushes the badge to the footer status on session_start", async () => {
		const mock = load();
		const { statuses } = await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "plan" }),
		]);
		expect(statuses).toContainEqual({ key: "codepi-modes", text: "PLAN" });
	});
});

describe("codepi-modes: ask allowlist settings", () => {
	it("default allowlist includes SDK read-only set + host tools + read-only web tools", () => {
		expect(READ_ONLY_TOOL_BASELINE).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"list_dir",
			"find_files",
			"get_diagnostics",
			"ask_user_question",
			"web_search",
			"fetch_content",
		]);
		expect(DEFAULT_ASK_ALLOWED_TOOLS).toEqual(READ_ONLY_TOOL_BASELINE);
	});

	it("falls back to the hardcoded defaults when the settings block is missing", () => {
		const allowlist = getAskModeAllowlist(undefined);
		expect(allowlist.has("read")).toBe(true);
		expect(allowlist.has("web_search")).toBe(true);
		expect(allowlist.has("bash")).toBe(false);
		expect(allowlist.has("edit")).toBe(false);
		expect(allowlist.has("subagent")).toBe(false);
	});

	it("uses the settings list as the source of truth when present", () => {
		const allowlist = getAskModeAllowlist(["web_search"]);
		expect(allowlist.has("web_search")).toBe(true);
		expect(allowlist.has("read")).toBe(false);
		expect(allowlist.has("bash")).toBe(false);
	});

	it("respects an explicitly empty settings list", () => {
		expect(getAskModeAllowlist([]).size).toBe(0);
	});

	it("reads the whitelist from settings.json", () => {
		writeAskAllowedTools(["web_search", "web_search"]);
		expect(readAskAllowedTools(settingsDir)).toEqual(["web_search"]);
	});

	it("returns undefined for missing or malformed settings", () => {
		expect(readAskAllowedTools(settingsDir)).toBeUndefined();
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ codepi: { modes: { ask: { allowedTools: "nope" } } } }),
		);
		expect(readAskAllowedTools(settingsDir)).toBeUndefined();
		writeFileSync(join(settingsDir, "settings.json"), "{oops");
		expect(readAskAllowedTools(settingsDir)).toBeUndefined();
	});

	it("ignores non-string and blank whitelist entries", () => {
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({
				codepi: {
					modes: { ask: { allowedTools: [42, "  ", "web_search"] } },
				},
			}),
		);
		expect(readAskAllowedTools(settingsDir)).toEqual(["web_search"]);
	});

	it("blocks unknown extension tools even with no settings (defaults apply)", async () => {
		const mock = load();
		await startSession(mock, [createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" })]);
		// web_search is in the default allowlist.
		const allowed = await emitToolCall(mock, "web_search");
		expect(allowed.result).toBeUndefined();
		// Unknown extension tools stay blocked.
		const blocked = await emitToolCall(mock, "mystery_ext_tool");
		expect(blocked.result?.block).toBe(true);
	});
});
