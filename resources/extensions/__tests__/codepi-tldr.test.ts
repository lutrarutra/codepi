import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import codepiTldrFactory, {
	readTldrModeOverride,
	readTldrModeSetting,
} from "../codepi-tldr";

const MODE_ENTRY_TYPE = "codepi-tldr:mode";

type Handler = (event: any, ctx: any) => unknown;
type CommandHandler = (args: string, ctx: any) => Promise<void>;

function createMockPi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: CommandHandler }>();
	const entries: Array<{ customType: string; data: unknown }> = [];
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
	};
	return { api, handlers, commands, entries };
}

function createBranchEntry(customType: string, data: unknown) {
	return { type: "custom", customType, data, id: Math.random().toString(36) };
}

function createCtx(
	branch: unknown[],
	uiOverrides: Record<string, unknown> = {},
) {
	return {
		ui: {
			setCompactMode: vi.fn(),
			isCompactMode: vi.fn(() => undefined),
			setWorkingVisible: vi.fn(),
			notify: vi.fn(),
			...uiOverrides,
		},
		sessionManager: { getBranch: () => branch },
	};
}

let settingsDir: string;

beforeEach(() => {
	settingsDir = mkdtempSync(join(tmpdir(), "codepi-compact-"));
	process.env.PI_CODING_AGENT_DIR = settingsDir;
});

afterEach(() => {
	rmSync(settingsDir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("readTldrModeOverride", () => {
	it("returns undefined with no entries", () => {
		expect(readTldrModeOverride([])).toBeUndefined();
	});

	it("reads the enabled flag from a matching custom entry", () => {
		const branch = [createBranchEntry(MODE_ENTRY_TYPE, { enabled: false })];
		expect(readTldrModeOverride(branch)).toBe(false);
	});

	it("lets the latest entry win", () => {
		const branch = [
			createBranchEntry(MODE_ENTRY_TYPE, { enabled: false }),
			createBranchEntry(MODE_ENTRY_TYPE, { enabled: true }),
		];
		expect(readTldrModeOverride(branch)).toBe(true);
	});

	it("ignores malformed data and unrelated entries", () => {
		const branch = [
			createBranchEntry("other:type", { enabled: false }),
			createBranchEntry(MODE_ENTRY_TYPE, { enabled: "yes" }),
			createBranchEntry(MODE_ENTRY_TYPE, { nope: 1 }),
		];
		expect(readTldrModeOverride(branch)).toBeUndefined();
	});
});

describe("readTldrModeSetting", () => {
	it("returns undefined when settings.json is missing", () => {
		expect(readTldrModeSetting(settingsDir)).toBeUndefined();
	});

	it("reads codepi.tldrMode when present", () => {
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ codepi: { tldrMode: false } }),
		);
		expect(readTldrModeSetting(settingsDir)).toBe(false);
	});

	it("returns undefined for malformed settings", () => {
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ codepi: { tldrMode: "true" } }),
		);
		expect(readTldrModeSetting(settingsDir)).toBeUndefined();
	});
});

describe("codepi-compact extension", () => {
	function load() {
		const mock = createMockPi();
		codepiTldrFactory(mock.api as any);
		const sessionStart = mock.handlers.get("session_start")?.[0];
		const agentStart = mock.handlers.get("agent_start")?.[0];
		const toggle = mock.commands.get("codepi-toggle-tldr")?.handler;
		expect(sessionStart).toBeDefined();
		expect(agentStart).toBeDefined();
		expect(toggle).toBeDefined();
		return {
			mock,
			sessionStart: sessionStart!,
			agentStart: agentStart!,
			toggle: toggle!,
		};
	}

	it("registers /codepi-toggle-tldr", () => {
		const { mock } = load();
		expect(mock.commands.has("codepi-toggle-tldr")).toBe(true);
	});

	it("applies the default (enabled) when nothing is configured", async () => {
		const { sessionStart } = load();
		const ctx = createCtx([]);
		await sessionStart({}, ctx);
		expect(ctx.ui.setCompactMode).toHaveBeenCalledWith(true);
	});

	it("applies the settings.json value when no session override exists", async () => {
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ codepi: { tldrMode: false } }),
		);
		const { sessionStart } = load();
		const ctx = createCtx([]);
		await sessionStart({}, ctx);
		expect(ctx.ui.setCompactMode).toHaveBeenCalledWith(false);
	});

	it("session override beats the settings default", async () => {
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ codepi: { tldrMode: false } }),
		);
		const { sessionStart } = load();
		const branch = [createBranchEntry(MODE_ENTRY_TYPE, { enabled: true })];
		const ctx = createCtx(branch);
		await sessionStart({}, ctx);
		expect(ctx.ui.setCompactMode).toHaveBeenCalledWith(true);
	});

	it("toggling flips state, persists an entry, and notifies", async () => {
		const { mock, toggle } = load();
		const ctx = createCtx([]);
		ctx.ui.isCompactMode = vi.fn(() => true);
		await toggle("", ctx);
		expect(ctx.ui.setCompactMode).toHaveBeenCalledWith(false);
		expect(mock.entries.at(-1)).toEqual({
			customType: MODE_ENTRY_TYPE,
			data: expect.objectContaining({ enabled: false }),
		});
		expect(ctx.ui.notify).toHaveBeenCalled();
	});

	it("persists per-session toggles so a reload applies them", async () => {
		const { mock, toggle, sessionStart } = load();
		const ctx = createCtx([]);
		ctx.ui.isCompactMode = vi.fn(() => true);
		await toggle("", ctx);
		const entry = mock.entries.at(-1)!.data as { enabled: boolean };
		// Simulate a reload: new ctx over the branch that now contains the entry.
		const reloadCtx = createCtx([createBranchEntry(MODE_ENTRY_TYPE, entry)]);
		await sessionStart({}, reloadCtx);
		expect(reloadCtx.ui.setCompactMode).toHaveBeenCalledWith(false);
	});
});

describe("working-loader gating in TL;DR mode", () => {
	function load() {
		const mock = createMockPi();
		codepiTldrFactory(mock.api as any);
		const sessionStart = mock.handlers.get("session_start")?.[0];
		const agentStart = mock.handlers.get("agent_start")?.[0];
		const agentEnd = mock.handlers.get("agent_end")?.[0];
		const toggle = mock.commands.get("codepi-toggle-tldr")?.handler;
		expect(sessionStart).toBeDefined();
		expect(agentStart).toBeDefined();
		expect(agentEnd).toBeDefined();
		expect(toggle).toBeDefined();
		return {
			sessionStart: sessionStart!,
			agentStart: agentStart!,
			agentEnd: agentEnd!,
			toggle: toggle!,
		};
	}

	it("hides pi's working loader when TL;DR is on at session start", async () => {
		const { sessionStart } = load();
		const ctx = createCtx([]); // nothing configured → default enabled
		await sessionStart({}, ctx);
		expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(false);
	});

	it("shows pi's working loader when TL;DR is off at session start", async () => {
		writeFileSync(
			join(settingsDir, "settings.json"),
			JSON.stringify({ codepi: { tldrMode: false } }),
		);
		const { sessionStart } = load();
		const ctx = createCtx([]);
		await sessionStart({}, ctx);
		expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(true);
	});

	it("re-asserts loader visibility on agent_start", async () => {
		const { agentStart } = load();
		const ctx = createCtx([]);
		await agentStart({}, ctx);
		expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(false);
	});

	it("toggle to ON between turns hides the loader", async () => {
		const { toggle } = load();
		const ctx = createCtx([]);
		ctx.ui.isCompactMode = vi.fn(() => false);
		await toggle("", ctx);
		expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(false);
	});

	it("toggle to ON during an active turn keeps the loader spinning", async () => {
		const { agentStart, toggle } = load();
		const ctx = createCtx([]);
		await agentStart({}, ctx);
		ctx.ui.isCompactMode = vi.fn(() => false);
		await toggle("", ctx);
		// pi has no compact summary row for the in-flight turn, so the loader
		// is the only spinner available — it must keep spinning.
		expect(ctx.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
	});

	it("agent_end re-asserts the hidden loader after a mid-turn toggle", async () => {
		const { agentStart, agentEnd, toggle } = load();
		const ctx = createCtx([]);
		await agentStart({}, ctx);
		ctx.ui.isCompactMode = vi.fn(() => false);
		await toggle("", ctx);
		expect(ctx.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
		await agentEnd({}, ctx);
		expect(ctx.ui.setWorkingVisible).toHaveBeenLastCalledWith(false);
	});

	it("toggle to OFF during an active turn shows the loader", async () => {
		const { agentStart, toggle } = load();
		const ctx = createCtx([]);
		await agentStart({}, ctx);
		ctx.ui.isCompactMode = vi.fn(() => true);
		await toggle("", ctx);
		expect(ctx.ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
	});

	it("toggle to OFF restores the loader mid-session", async () => {
		const { toggle } = load();
		const ctx = createCtx([]);
		ctx.ui.isCompactMode = vi.fn(() => true);
		await toggle("", ctx);
		expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(true);
	});
});
