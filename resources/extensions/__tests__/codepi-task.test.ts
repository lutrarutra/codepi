import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import codepiTaskFactory, {
	DEFAULT_TASK_TIMEOUT_SECONDS,
	applyEditToDef,
	buildPermissionInstructions,
	buildTaskDef,
	buildTasksPromptSection,
	commandString,
	effectiveTimeout,
	formatTaskList,
	hasAfterImplementTasks,
	normalizeEditFields,
	normalizeWhen,
	parseTimeout,
	readAgentMode,
	readTaskReminderSettings,
	readTasksFile,
	runGateError,
	shouldNudge,
	summarizeTask,
	tasksPathForCwd,
	validateTaskName,
	writeTasksFile,
	type TaskDef,
	type TaskStore,
} from "../codepi-task";

// ── Hermetic task dirs ───────────────────────────────────────

let taskDir: string;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	taskDir = mkdtempSync(join(tmpdir(), "codepi-task-test-"));
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(
		join(tmpdir(), "codepi-task-agent-"),
	);
});

afterEach(() => {
	rmSync(taskDir, { recursive: true, force: true });
	rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

function tasksPath(): string {
	return join(taskDir, ".pi", "tasks.json");
}

function writeTasks(content: unknown): void {
	mkdirSync(join(taskDir, ".pi"), { recursive: true });
	writeFileSync(tasksPath(), JSON.stringify(content, null, 2));
}

// ── Mock helpers ─────────────────────────────────────────────

type Handler = (event: any, ctx: any) => unknown;

function createMockPi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const messages: Array<{ message: unknown; options?: unknown }> = [];
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, options: any) {
			commands.set(name, options);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		sendMessage: (message: unknown, options?: unknown) => {
			messages.push({ message, options });
		},
	};
	return { api, handlers, commands, tools, messages };
}

function branchEntry(customType: string, data: unknown) {
	return { type: "custom", customType, data };
}

const bashMode = (mode: string) => branchEntry("codepi-bash:mode", { mode });
const agentMode = (mode: string) => branchEntry("codepi-modes:mode", { mode });

function toolCtx(branch: unknown[] = []) {
	const notify = vi.fn();
	const ctx = {
		cwd: taskDir,
		sessionManager: { getBranch: () => branch },
		ui: { notify, select: vi.fn(), input: vi.fn(), confirm: vi.fn() },
		hasUI: true,
	};
	return { ctx: ctx as any, notify };
}

/** Load the factory against a fresh mock pi. */
function load() {
	const mock = createMockPi();
	codepiTaskFactory(mock.api as any);
	return mock;
}

async function runTool(
	mock: ReturnType<typeof load>,
	name: string,
	params: Record<string, unknown>,
	branch: unknown[] = [],
) {
	const tool = mock.tools.get(name);
	expect(tool, `tool ${name} registered`).toBeDefined();
	const { ctx, notify } = toolCtx(branch);
	try {
		const result = await tool.execute("t1", params, undefined, undefined, ctx);
		return { result, notify, threw: false };
	} catch (err) {
		return { result: undefined, notify, threw: true, error: err as Error };
	}
}

// ── Name validation ──────────────────────────────────────────

describe("validateTaskName", () => {
	it("accepts npm-script-like names", () => {
		for (const name of ["build", "build_web", "a.b-c", "test1", "x"]) {
			expect(validateTaskName(name)).toBeNull();
		}
	});
	it("rejects invalid names", () => {
		expect(validateTaskName("")).not.toBeNull();
		expect(validateTaskName("has space")).not.toBeNull();
		expect(validateTaskName("-lead")).not.toBeNull();
		expect(validateTaskName(".lead")).not.toBeNull();
		expect(validateTaskName("Ünïcode")).not.toBeNull();
		expect(validateTaskName("a".repeat(65))).not.toBeNull();
		expect(validateTaskName(42)).not.toBeNull();
		expect(validateTaskName(undefined)).not.toBeNull();
	});
});

// ── Timeout / when / readOnly ────────────────────────────────

describe("parseTimeout / effectiveTimeout", () => {
	it("defaults to DEFAULT_TASK_TIMEOUT_SECONDS", () => {
		expect(parseTimeout(undefined).ok).toBe(true);
		expect(effectiveTimeout({ command: "x" })).toBe(
			DEFAULT_TASK_TIMEOUT_SECONDS,
		);
	});
	it("accepts positive numbers and rejects everything else", () => {
		expect(parseTimeout(30)).toEqual({ ok: true, seconds: 30 });
		for (const bad of [0, -1, NaN, Infinity, "30", null]) {
			expect("error" in parseTimeout(bad)).toBe(true);
		}
	});
	it("tolerates malformed stored timeouts", () => {
		expect(
			effectiveTimeout({ command: "x", timeout: "30" } as unknown as TaskDef),
		).toBe(DEFAULT_TASK_TIMEOUT_SECONDS);
	});
});

describe("normalizeWhen / readOnly", () => {
	it("normalizes when values with anytime fallback", () => {
		expect(normalizeWhen("before-implement")).toBe("before-implement");
		expect(normalizeWhen("after-implement")).toBe("after-implement");
		expect(normalizeWhen("anytime")).toBe("anytime");
		expect(normalizeWhen("never")).toBe("anytime");
		expect(normalizeWhen(undefined)).toBe("anytime");
	});
});

// ── Store read/write ─────────────────────────────────────────

describe("readTasksFile / writeTasksFile", () => {
	it("returns an empty store when the file is missing", () => {
		const store = readTasksFile(tasksPath());
		expect(store.tasks).toEqual({});
		expect(store.root).toEqual({});
	});
	it("round-trips tasks and preserves unknown top-level keys", () => {
		writeTasks({
			$schema: "./tasks.schema.json",
			tasks: {
				build: { command: "npm run build", when: "after-implement" },
			},
		});
		const store = readTasksFile(tasksPath());
		expect(store.root.$schema).toBe("./tasks.schema.json");
		expect(store.tasks.build.command).toBe("npm run build");
		writeTasksFile(tasksPath(), store.root);
		const again = JSON.parse(
			require("node:fs").readFileSync(tasksPath(), "utf8"),
		);
		expect(again.$schema).toBe("./tasks.schema.json");
	});
	it("throws on malformed JSON and wrong shapes", () => {
		mkdirSync(join(taskDir, ".pi"), { recursive: true });
		writeFileSync(tasksPath(), "{ nope");
		expect(() => readTasksFile(tasksPath())).toThrow(/Failed to parse/);
		writeTasks({ tasks: ["build"] });
		expect(() => readTasksFile(tasksPath())).toThrow(/"tasks" must be an object/);
		writeTasks({ tasks: { build: "npm run build" } });
		expect(() => readTasksFile(tasksPath())).toThrow(/must be an object/);
	});
});

// ── Store ops ────────────────────────────────────────────────

describe("buildTaskDef / applyEditToDef", () => {
	it("stores normalized fields and omits defaults", () => {
		const def = buildTaskDef("npm run build", {
			when: "after-implement",
			timeout: 300,
			readOnly: true,
			description: "  Compile  ",
		});
		expect(def).toEqual({
			command: "npm run build",
			when: "after-implement",
			timeout: 300,
			readOnly: true,
			description: "Compile",
		});
		const minimal = buildTaskDef("npm test", {});
		expect(minimal).toEqual({ command: "npm test" });
	});
	it("merges edits and clears via empty string", () => {
		const base: TaskDef = {
			command: "npm run build",
			when: "after-implement",
			description: "Compile",
			customField: "kept",
		};
		const edited = applyEditToDef(base, {
			command: "npm run build:prod",
			description: "",
			when: "anytime",
		});
		expect(edited.command).toBe("npm run build:prod");
		expect(edited.description).toBeUndefined();
		expect(edited.when).toBeUndefined();
		expect(edited.customField).toBe("kept"); // unknown fields preserved
	});
	it("rejects invalid edit fields", () => {
		for (const fields of [
			{ newName: "bad name" },
			{ cwd: "" },
			{ when: "never" },
			{ timeout: -1 },
			{ readOnly: "yes" },
			{ description: 5 },
		]) {
			expect("error" in normalizeEditFields(fields)).toBe(true);
		}
	});
});

// ── Formatting ───────────────────────────────────────────────

describe("formatTaskList / summarizeTask", () => {
	const store: TaskStore = {
		root: {},
		tasks: {
			test: { command: "npm test", when: "after-implement", readOnly: true },
			build: {
				command: ["npm run build", "npm run package"],
				cwd: "pkg",
				timeout: 300,
				description: "Compile",
			},
		},
	};
	it("sorts by name and renders details", () => {
		const text = formatTaskList(store);
		expect(text).toContain("build — anytime");
		expect(text).toContain("npm run build && npm run package");
		expect(text).toContain("cwd pkg");
		expect(text).toContain("timeout 300s");
		expect(text).toContain("test — after-implement");
		expect(text).toContain("readOnly");
	});
	it("filters by when and single name", () => {
		expect(formatTaskList(store, { when: "after-implement" })).toContain(
			"test —",
		);
		expect(formatTaskList(store, { when: "after-implement" })).not.toContain(
			"build —",
		);
		expect(formatTaskList(store, { name: "build" })).toContain("Compile");
		expect(formatTaskList(store, { name: "nope" })).toContain("not found");
		expect(formatTaskList({ root: {}, tasks: {} })).toContain("No tasks");
	});
});

// ── Permission questions ─────────────────────────────────────

describe("buildPermissionInstructions", () => {
	it("states what the task does and points to .pi/tasks.json", () => {
		const def: TaskDef = { command: "npm run build", when: "after-implement" };
		const text = buildPermissionInstructions(
			"create",
			"build",
			summarizeTask("build", def),
		);
		expect(text).toContain("build");
		expect(text).toContain('runs "npm run build"');
		expect(text).toContain("after-implement");
		expect(text).toContain(".pi/tasks.json");
		expect(text).toContain("ask_user_question");
		expect(text).toContain("confirmed: true");
		expect(text).toContain("Yes, create it");
	});
});

// ── Prompt section + nudge ───────────────────────────────────

describe("buildTasksPromptSection / shouldNudge", () => {
	it("builds a section when tasks exist and undefined otherwise", () => {
		expect(
			buildTasksPromptSection({ root: {}, tasks: {} }),
		).toBeUndefined();
		const section = buildTasksPromptSection({
			root: {},
			tasks: {
				build: { command: "npm run build", when: "after-implement" },
			},
		});
		expect(section).toContain("## Project tasks (.pi/tasks.json)");
		expect(section).toContain("build (after-implement): npm run build");
		expect(section).toContain("after-implement");
	});
	it("shouldNudge truth table", () => {
		const base = {
			mutated: true,
			ranTask: false,
			hasAfterImplement: true,
			enabled: true,
		};
		expect(shouldNudge(base)).toBe(true);
		expect(shouldNudge({ ...base, mutated: false })).toBe(false);
		expect(shouldNudge({ ...base, ranTask: true })).toBe(false);
		expect(shouldNudge({ ...base, hasAfterImplement: false })).toBe(false);
		expect(shouldNudge({ ...base, enabled: false })).toBe(false);
	});
	it("hasAfterImplementTasks detects after-implement tasks", () => {
		expect(
			hasAfterImplementTasks({
				root: {},
				tasks: { test: { command: "npm test", when: "after-implement" } },
			}),
		).toBe(true);
		expect(
			hasAfterImplementTasks({
				root: {},
				tasks: { build: { command: "npm run build" } },
			}),
		).toBe(false);
	});
});

// ── Settings ─────────────────────────────────────────────────

describe("readTaskReminderSettings / readAgentMode / runGateError", () => {
	it("reads codepi.tasks.* defensively with defaults on", () => {
		expect(readTaskReminderSettings({})).toEqual({
			injectPrompt: true,
			remindAfterImplement: true,
		});
		expect(readTaskReminderSettings(null)).toEqual({
			injectPrompt: true,
			remindAfterImplement: true,
		});
		expect(
			readTaskReminderSettings({
				codepi: { tasks: { injectPrompt: false, remindAfterImplement: false } },
			}),
		).toEqual({ injectPrompt: false, remindAfterImplement: false });
		expect(
			readTaskReminderSettings({ codepi: { tasks: { injectPrompt: "yes" } } }),
		).toEqual({ injectPrompt: true, remindAfterImplement: true });
	});
	it("replays the latest agent mode", () => {
		expect(
			readAgentMode([agentMode("ask"), agentMode("implement")]),
		).toBe("implement");
		expect(readAgentMode([bashMode("auto")])).toBe("implement");
		expect(readAgentMode([])).toBe("implement");
	});
	it("runGateError blocks disabled bash and non-readOnly ask-mode tasks", () => {
		expect(
			runGateError({ bashMode: "disabled", agentMode: "implement", taskReadOnly: false, name: "build" }),
		).toContain("bash tool is disabled");
		expect(
			runGateError({ bashMode: "ask", agentMode: "ask", taskReadOnly: false, name: "build" }),
		).toContain("readOnly");
		expect(
			runGateError({ bashMode: "ask", agentMode: "ask", taskReadOnly: true, name: "test" }),
		).toBeUndefined();
		expect(
			runGateError({ bashMode: "auto", agentMode: "implement", taskReadOnly: false, name: "build" }),
		).toBeUndefined();
	});
});

// ── Factory: registration + tools end-to-end ────────────────

describe("codepi-task factory", () => {
	it("registers 5 tools, 5 commands, and reminder events", () => {
		const mock = load();
		expect([...mock.tools.keys()].sort()).toEqual([
			"codepi-task-create",
			"codepi-task-delete",
			"codepi-task-edit",
			"codepi-task-list",
			"codepi-task-run",
		]);
		expect([...mock.commands.keys()].sort()).toEqual([
			"codepi-task-create",
			"codepi-task-delete",
			"codepi-task-edit",
			"codepi-task-list",
			"codepi-task-run",
		]);
		for (const event of [
			"before_agent_start",
			"agent_start",
			"tool_result",
			"agent_end",
		]) {
			expect(mock.handlers.get(event)?.length).toBe(1);
		}
	});

	it("create: unconfirmed call asks and does not write", async () => {
		const mock = load();
		const { result, threw } = await runTool(mock, "codepi-task-create", {
			name: "build",
			command: "npm run build",
			when: "after-implement",
		});
		expect(threw).toBe(false);
		expect(result.details.needsConfirmation).toBe(true);
		const text = result.content[0].text as string;
		expect(text).toContain("ask_user_question");
		expect(text).toContain(".pi/tasks.json");
		expect(text).toContain("confirmed: true");
		// Nothing written.
		const store = readTasksFile(tasksPath());
		expect(store.tasks).toEqual({});
	});

	it("create: confirmed call writes the task file", async () => {
		const mock = load();
		const { result } = await runTool(mock, "codepi-task-create", {
			name: "build",
			command: ["npm run build", "npm run package"],
			when: "after-implement",
			readOnly: false,
			timeout: 300,
			description: "Compile",
			confirmed: true,
		});
		expect(result.content[0].text).toContain('Created task "build"');
		const store = readTasksFile(tasksPath());
		expect(store.tasks.build).toEqual({
			command: "npm run build && npm run package",
			when: "after-implement",
			timeout: 300,
			description: "Compile",
		});
	});

	it("create: duplicate name errors", async () => {
		writeTasks({ tasks: { build: { command: "npm run build" } } });
		const mock = load();
		const { threw, error } = await runTool(mock, "codepi-task-create", {
			name: "build",
			command: "npm run build",
			confirmed: true,
		});
		expect(threw).toBe(true);
		expect(error!.message).toContain("already exists");
	});

	it("edit: unconfirmed asks; confirmed merges + renames", async () => {
		writeTasks({
			tasks: {
				build: {
					command: "npm run build",
					when: "after-implement",
					description: "Compile",
				},
			},
		});
		const mock = load();
		const unconfirmed = await runTool(mock, "codepi-task-edit", {
			name: "build",
			command: "npm run build:prod",
		});
		expect(unconfirmed.result.details.needsConfirmation).toBe(true);
		expect(readTasksFile(tasksPath()).tasks.build.command).toBe("npm run build");

		const confirmed = await runTool(mock, "codepi-task-edit", {
			name: "build",
			command: "npm run build:prod",
			newName: "build-prod",
			description: "",
			confirmed: true,
		});
		expect(confirmed.threw).toBe(false);
		const store = readTasksFile(tasksPath());
		expect(store.tasks["build-prod"].command).toBe("npm run build:prod");
		expect(store.tasks["build-prod"].description).toBeUndefined();
		expect(store.tasks["build-prod"].when).toBe("after-implement"); // untouched
		expect(store.tasks.build).toBeUndefined();
	});

	it("delete: unconfirmed asks; confirmed removes", async () => {
		writeTasks({ tasks: { build: { command: "npm run build" } } });
		const mock = load();
		const unconfirmed = await runTool(mock, "codepi-task-delete", {
			name: "build",
		});
		expect(unconfirmed.result.details.needsConfirmation).toBe(true);
		expect(unconfirmed.result.content[0].text).toContain(".pi/tasks.json");
		expect(readTasksFile(tasksPath()).tasks.build).toBeDefined();

		const confirmed = await runTool(mock, "codepi-task-delete", {
			name: "build",
			confirmed: true,
		});
		expect(confirmed.threw).toBe(false);
		expect(readTasksFile(tasksPath()).tasks).toEqual({});
	});

	it("list: renders tasks and supports when filter", async () => {
		writeTasks({
			tasks: {
				build: { command: "npm run build" },
				test: { command: "npm test", when: "after-implement" },
			},
		});
		const mock = load();
		const all = await runTool(mock, "codepi-task-list", {});
		expect(all.result.content[0].text).toContain("Tasks defined in");
		expect(all.result.content[0].text).toContain("build");
		const filtered = await runTool(mock, "codepi-task-list", {
			when: "after-implement",
		});
		expect(filtered.result.content[0].text).toContain("test");
		expect(filtered.result.content[0].text).not.toContain("build");
	});

	it("run: blocked while bash is disabled (with warning notify)", async () => {
		writeTasks({ tasks: { build: { command: "npm run build" } } });
		const mock = load();
		const { threw, error, notify } = await runTool(
			mock,
			"codepi-task-run",
			{ name: "build" },
			[bashMode("disabled")],
		);
		expect(threw).toBe(true);
		expect(error!.message).toContain("bash tool is disabled");
		expect(notify).toHaveBeenCalled();
	});

	it("run: ask mode blocks non-readOnly tasks but allows readOnly ones", async () => {
		writeTasks({
			tasks: {
				build: { command: "npm run build" },
				test: { command: "npm test", readOnly: true },
			},
		});
		const mock = load();
		const blocked = await runTool(
			mock,
			"codepi-task-run",
			{ name: "build" },
			[bashMode("ask"), agentMode("ask")],
		);
		expect(blocked.threw).toBe(true);
		expect(blocked.error!.message).toContain("readOnly");

		// readOnly task passes the gates → execution attempt fails only because
		// there is no VS Code API in the test environment.
		const allowed = await runTool(
			mock,
			"codepi-task-run",
			{ name: "test" },
			[bashMode("ask"), agentMode("ask")],
		);
		expect(allowed.threw).toBe(true);
		expect(allowed.error!.message).toContain("VS Code API unavailable");
	});

	it("run: runs without approval in ask/auto bash modes (implement mode)", async () => {
		writeTasks({ tasks: { build: { command: "npm run build" } } });
		const mock = load();
		const { threw, error } = await runTool(
			mock,
			"codepi-task-run",
			{ name: "build" },
			[bashMode("ask")],
		);
		// Gates passed (no approval dialog) — only the missing VS Code API fails.
		expect(threw).toBe(true);
		expect(error!.message).toContain("VS Code API unavailable");
	});

	it("run: missing task errors", async () => {
		const mock = load();
		const { threw, error } = await runTool(mock, "codepi-task-run", {
			name: "nope",
		});
		expect(threw).toBe(true);
		expect(error!.message).toContain("not found");
	});

	it("mutating tools are blocked in ask (read-only) mode", async () => {
		const mock = load();
		const { threw, error } = await runTool(
			mock,
			"codepi-task-create",
			{ name: "build", command: "npm run build" },
			[agentMode("ask")],
		);
		expect(threw).toBe(true);
		expect(error!.message).toContain("Ask (read-only) mode");
	});

	it("nudges after an edit-turn when after-implement tasks exist", async () => {
		writeTasks({
			tasks: {
				build: { command: "npm run build", when: "after-implement" },
			},
		});
		const mock = load();
		const toolResult = mock.handlers.get("tool_result")![0];
		const agentEnd = mock.handlers.get("agent_end")![0];
		const agentStart = mock.handlers.get("agent_start")![0];
		const ctx = toolCtx().ctx;

		await agentStart({}, ctx);
		await toolResult({ toolName: "edit" }, ctx);
		await agentEnd({}, ctx);
		expect(mock.messages.length).toBe(1);
		expect(mock.messages[0].message).toMatchObject({
			customType: "codepi-task:nudge",
		});
		expect(String((mock.messages[0].message as any).content)).toContain("build");
	});

	it("does not nudge when codepi-task-run already ran or nothing was edited", async () => {
		writeTasks({
			tasks: {
				build: { command: "npm run build", when: "after-implement" },
			},
		});
		const mock = load();
		const toolResult = mock.handlers.get("tool_result")![0];
		const agentEnd = mock.handlers.get("agent_end")![0];
		const agentStart = mock.handlers.get("agent_start")![0];
		const ctx = toolCtx().ctx;

		await agentStart({}, ctx);
		await toolResult({ toolName: "codepi-task-run" }, ctx);
		await agentEnd({}, ctx);
		expect(mock.messages.length).toBe(0);

		await agentStart({}, ctx);
		await toolResult({ toolName: "read" }, ctx);
		await agentEnd({}, ctx);
		expect(mock.messages.length).toBe(0);
	});

	it("injects the tasks section into the system prompt", async () => {
		writeTasks({ tasks: { test: { command: "npm test" } } });
		const mock = load();
		const handler = mock.handlers.get("before_agent_start")![0];
		const result = (await handler(
			{ systemPrompt: "BASE", prompt: "hi" },
			toolCtx().ctx,
		)) as { systemPrompt: string };
		expect(result.systemPrompt.startsWith("BASE")).toBe(true);
		expect(result.systemPrompt).toContain("## Project tasks (.pi/tasks.json)");
		expect(result.systemPrompt).toContain("test (anytime): npm test");
	});
});
