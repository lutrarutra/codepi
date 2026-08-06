import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import codepiBashFactory, {
	DIALOG_OPTIONS,
	formatBashBadge,
	mapDialogChoice,
	readModeFromBranch,
	type BashMode,
} from "../codepi-bash";
import {
	getBashBridge,
	setBashBridge,
} from "../bash-bridge";

// ── Helpers ──────────────────────────────────────────────────

const TEST_SESSION = "codepi-bash-test-session";
const MODE_ENTRY_TYPE = "codepi-bash:mode";
const STATUS_KEY = "codepi-bash";

beforeEach(() => {
	setBashBridge(TEST_SESSION, undefined);
});
afterEach(() => {
	setBashBridge(TEST_SESSION, undefined);
});

type Handler = (event: any, ctx: any) => unknown;
type CommandHandler = (args: string, ctx: any) => Promise<void>;

function createCtx(overrides: Record<string, unknown> = {}) {
	const select = vi.fn().mockResolvedValue(DIALOG_OPTIONS[0]);
	const input = vi.fn().mockResolvedValue("ls -la");
	const notify = vi.fn();
	const setStatus = vi.fn();
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const ctx = {
		cwd: "/tmp",
		hasUI: true,
		waitForIdle: async () => {},
		sessionManager: {
			getSessionId: () => TEST_SESSION,
			getBranch: () => (overrides.branch as unknown[]) ?? [],
		},
		ui: {
			select,
			input,
			notify,
			setStatus: (key: string, text: string | undefined) => {
				statuses.push({ key, text });
				setStatus(key, text);
			},
		},
	};
	return {
		ctx: { ...ctx, ...overrides } as any,
		select,
		input,
		notify,
		statuses,
	};
}

function createMockPi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: CommandHandler }>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const tools: unknown[] = [];
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options);
		},
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ customType, data });
		},
		registerTool: (tool: unknown) => {
			tools.push(tool);
		},
	};
	return { api, handlers, commands, entries, tools };
}

function createBranchEntry(customType: string, data: unknown) {
	return { type: "custom", customType, data, id: Math.random().toString(36) };
}

function load() {
	const mock = createMockPi();
	codepiBashFactory(mock.api as any);
	return mock;
}

async function startSession(
	mock: ReturnType<typeof load>,
	branch: unknown[] = [],
) {
	const handler = mock.handlers.get("session_start")?.[0];
	expect(handler).toBeDefined();
	const { ctx, statuses } = createCtx({ branch });
	await handler!({ type: "session_start", reason: "startup" }, ctx);
	return { ctx, statuses };
}

async function runCommand(
	mock: ReturnType<typeof load>,
	name: string,
	branch: unknown[] = [],
) {
	const command = mock.commands.get(name);
	expect(command, `command /${name} not registered`).toBeDefined();
	const { ctx, notify, statuses } = createCtx({ branch });
	await command!.handler("", ctx);
	return { ctx, notify, statuses };
}

// ── Pure helpers ─────────────────────────────────────────────

describe("codepi-bash: formatBashBadge", () => {
	it("renders terminal icon + mode label (ask/allow/disabled)", () => {
		expect(formatBashBadge("ask")).toBe("\u{EBCA} ask");
		expect(formatBashBadge("auto")).toBe("\u{EBCA} allow");
		expect(formatBashBadge("disabled")).toBe("\u{EBCA} disabled");
	});
});

describe("codepi-bash: readModeFromBranch", () => {
	it("defaults to ask", () => {
		expect(readModeFromBranch([])).toBe("ask");
	});

	it("replays a persisted mode and uses the latest entry", () => {
		expect(
			readModeFromBranch([
				createBranchEntry(MODE_ENTRY_TYPE, { mode: "auto" }),
			]),
		).toBe("auto");
		expect(
			readModeFromBranch([
				createBranchEntry(MODE_ENTRY_TYPE, { mode: "auto" }),
				createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" }),
			]),
		).toBe("ask");
	});

	it("replays a persisted disabled mode", () => {
		expect(
			readModeFromBranch([
				createBranchEntry(MODE_ENTRY_TYPE, { mode: "disabled" }),
			]),
		).toBe("disabled");
	});

	it("ignores malformed entries and unrelated types", () => {
		expect(
			readModeFromBranch([
				createBranchEntry(MODE_ENTRY_TYPE, { mode: "banana" }),
				createBranchEntry("other", { mode: "auto" }),
				{ type: "message", message: { role: "user" } },
			]),
		).toBe("ask");
	});
});

describe("codepi-bash: mapDialogChoice", () => {
	it("maps the four options and Esc", () => {
		expect(mapDialogChoice(DIALOG_OPTIONS[0])).toBe("approve");
		expect(mapDialogChoice(DIALOG_OPTIONS[1])).toBe("deny");
		expect(mapDialogChoice(DIALOG_OPTIONS[2])).toBe("revise");
		expect(mapDialogChoice(DIALOG_OPTIONS[3])).toBe("auto");
		expect(mapDialogChoice(undefined)).toBe("cancel");
		expect(mapDialogChoice("something else")).toBe("cancel");
	});
});

// ── Factory registration ─────────────────────────────────────

describe("codepi-bash: registration", () => {
	it("registers the mode commands and session handlers, but no tool", () => {
		const mock = load();
		for (const name of [
			"codepi-bash-ask",
			"codepi-bash-allow",
			"codepi-bash-disable",
		]) {
			expect(mock.commands.has(name), `/${name}`).toBe(true);
		}
		expect(mock.handlers.has("session_start")).toBe(true);
		expect(mock.handlers.has("session_shutdown")).toBe(true);
		// The bash tool itself lives in the extension host (baseToolsOverride);
		// this extension is the safety switch only.
		expect(mock.tools).toHaveLength(0);
	});
});

// ── session_start: mode recovery + bridge registration ──────

describe("codepi-bash: session_start", () => {
	it("defaults a new session to ask, pushes the footer status, and registers the bridge", async () => {
		const mock = load();
		const { statuses } = await startSession(mock, []);
		expect(statuses).toContainEqual({ key: STATUS_KEY, text: "ask" });
		const bridge = getBashBridge(TEST_SESSION);
		expect(bridge).toBeDefined();
		expect(bridge!.getMode()).toBe("ask");
	});

	it("replays a persisted auto mode through the bridge", async () => {
		const mock = load();
		const { statuses } = await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "auto" }),
		]);
		expect(statuses).toContainEqual({ key: STATUS_KEY, text: "auto" });
		expect(getBashBridge(TEST_SESSION)!.getMode()).toBe("auto");
	});

	it("replays a persisted disabled mode", async () => {
		const mock = load();
		const { statuses } = await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "disabled" }),
		]);
		expect(statuses).toContainEqual({ key: STATUS_KEY, text: "disabled" });
		expect(getBashBridge(TEST_SESSION)!.getMode()).toBe("disabled");
	});
});

// ── session_shutdown: bridge cleanup ─────────────────────────

describe("codepi-bash: session_shutdown", () => {
	it("drops the bridge so stale approvals can never be reached", async () => {
		const mock = load();
		await startSession(mock, []);
		expect(getBashBridge(TEST_SESSION)).toBeDefined();
		const handler = mock.handlers.get("session_shutdown")?.[0];
		expect(handler).toBeDefined();
		const { ctx } = createCtx();
		await handler!({ type: "session_shutdown", reason: "close" }, ctx);
		expect(getBashBridge(TEST_SESSION)).toBeUndefined();
	});
});

// ── Approval dialog (bridge requestApproval) ─────────────────

describe("codepi-bash: approval dialog", () => {
	async function approve(
		selectValue: string | undefined,
		inputValue?: string,
	) {
		const mock = load();
		// The bridge captures the session_start ctx — use the SAME ctx whose
		// ui mocks we control for the dialog assertions.
		const { ctx, select, input, statuses } = createCtx();
		select.mockResolvedValue(selectValue);
		input.mockResolvedValue(inputValue as string);
		const handler = mock.handlers.get("session_start")?.[0];
		expect(handler).toBeDefined();
		await handler!({ type: "session_start", reason: "startup" }, ctx);
		const bridge = getBashBridge(TEST_SESSION)!;
		const result = await bridge.requestApproval("npm test", "/tmp", undefined);
		return { result, ctx, select, input, mock, statuses };
	}

	it("shows a 4-option select with the command and cwd; YES approves", async () => {
		const { result, select } = await approve(DIALOG_OPTIONS[0]);
		const [title, options] = select.mock.calls[0];
		expect(title).toContain("npm test");
		expect(title).toContain("cwd: /tmp");
		expect(options).toEqual([...DIALOG_OPTIONS]);
		expect(result).toEqual({ decision: "approve" });
	});

	it("denies on No", async () => {
		const { result } = await approve(DIALOG_OPTIONS[1]);
		expect(result).toEqual({ decision: "deny" });
	});

	it("denies on Esc (undefined)", async () => {
		const { result } = await approve(undefined);
		expect(result).toEqual({ decision: "deny" });
	});

	it("opens the input editor for Revise and returns the edited command", async () => {
		const { result, input } = await approve(DIALOG_OPTIONS[2], "ls -la");
		expect(input).toHaveBeenCalledWith(
			"Revise bash command",
			"npm test",
			expect.any(Object),
		);
		expect(result).toEqual({ decision: "revise", command: "ls -la" });
	});

	it("denies when the revise input is cancelled or empty", async () => {
		for (const answer of [undefined, "   "]) {
			const { result } = await approve(DIALOG_OPTIONS[2], answer as string);
			expect(result).toEqual({ decision: "deny" });
		}
	});

	it("approve & auto-approve all approves AND flips the switch to auto", async () => {
		const mock = load();
		const { ctx, select, statuses } = createCtx();
		select.mockResolvedValue(DIALOG_OPTIONS[3]);
		const handler = mock.handlers.get("session_start")?.[0];
		await handler!({ type: "session_start", reason: "startup" }, ctx);
		const bridge = getBashBridge(TEST_SESSION)!;
		const result = await bridge.requestApproval("git status", "/tmp", undefined);
		expect(result).toEqual({ decision: "approve" });
		expect(bridge.getMode()).toBe("auto");
		expect(statuses).toContainEqual({ key: STATUS_KEY, text: "auto" });
		expect(mock.entries).toContainEqual(
			expect.objectContaining({
				customType: MODE_ENTRY_TYPE,
				data: expect.objectContaining({ mode: "auto" }),
			}),
		);
	});
});

// ── Commands (safety switch) ─────────────────────────────────

describe("codepi-bash: commands", () => {
	it("switches to ask/auto, persists an entry, and updates the footer", async () => {
		const mock = load();
		await startSession(mock, []); // default ask

		const askRun = await runCommand(mock, "codepi-bash-ask", []);
		expect(askRun.notify).toHaveBeenCalledWith(
			expect.stringContaining("already in ask"),
			"info",
		);

		const autoRun = await runCommand(mock, "codepi-bash-allow", []);
		expect(autoRun.statuses).toContainEqual({ key: STATUS_KEY, text: "auto" });
		expect(mock.entries).toContainEqual(
			expect.objectContaining({
				customType: MODE_ENTRY_TYPE,
				data: expect.objectContaining({ mode: "auto" }),
			}),
		);
		expect(autoRun.notify).toHaveBeenCalledWith(
			expect.stringContaining("auto-approve"),
		);
		expect(getBashBridge(TEST_SESSION)!.getMode()).toBe("auto");

		const disabledRun = await runCommand(mock, "codepi-bash-disable", []);
		expect(disabledRun.statuses).toContainEqual({
			key: STATUS_KEY,
			text: "disabled",
		});
		expect(mock.entries).toContainEqual(
			expect.objectContaining({
				customType: MODE_ENTRY_TYPE,
				data: expect.objectContaining({ mode: "disabled" }),
			}),
		);
		expect(disabledRun.notify).toHaveBeenCalledWith(
			expect.stringContaining("disabled"),
		);

		// Re-running while already disabled is a no-op info notification.
		const againRun = await runCommand(mock, "codepi-bash-disable", []);
		expect(againRun.notify).toHaveBeenCalledWith(
			expect.stringContaining("already in disabled"),
			"info",
		);
	});

	it("switches the in-memory mode before session_start (bridge appears later)", async () => {
		const mock = load();
		const run = await runCommand(mock, "codepi-bash-disable", []);
		// No session_start yet: the command still toggles the in-memory mode
		// (the bridge appears at session_start with the recovered state).
		expect(run.statuses).toContainEqual({
			key: STATUS_KEY,
			text: "disabled",
		});
		expect(getBashBridge(TEST_SESSION)).toBeUndefined();
	});
});
