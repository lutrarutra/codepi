import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	existsSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import codepiBashFactory, {
	BashOutputAccumulator,
	DEFAULT_TIMEOUT_SECONDS,
	DIALOG_OPTIONS,
	cleanTerminalOutput,
	createCodepiBashToolDefinition,
	createVscodeBashOperations,
	formatBashBadge,
	joinCommands,
	mapDialogChoice,
	readModeFromBranch,
	resolveCwd,
	type BashMode,
} from "../codepi-bash";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

// ── Helpers ──────────────────────────────────────────────────

type Handler = (event: any, ctx: any) => unknown;
type CommandHandler = (args: string, ctx: any) => Promise<void>;

const MODE_ENTRY_TYPE = "codepi-bash:mode";
const STATUS_KEY = "codepi-bash";

/** Real temp dir used as the session cwd so resolveCwd passes. */
let fixtureDir: string;
beforeEach(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "codepi-bash-fixture-"));
});
afterEach(() => {
	rmSync(fixtureDir, { recursive: true, force: true });
});

/** A fake BashOperations backend that records calls and streams canned data. */
function createMockOps(impl?: BashOperations["exec"]): {
	ops: BashOperations;
	exec: ReturnType<typeof vi.fn>;
} {
	const exec = vi.fn(
		impl ??
			(async (_command: string, _cwd: string, options: any) => {
				options?.onData?.(Buffer.from("hello from shell\n"));
				return { exitCode: 0 };
			}),
	);
	return { ops: { exec }, exec };
}

/** Minimal extension context with a mockable ui (cwd = fixture dir). */
function createCtx(overrides: Record<string, unknown> = {}) {
	const select = vi.fn().mockResolvedValue(DIALOG_OPTIONS[0]);
	const input = vi.fn().mockResolvedValue("ls -la");
	const notify = vi.fn();
	const setStatus = vi.fn();
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const ctx = {
		cwd: fixtureDir,
		hasUI: true,
		waitForIdle: async () => {},
		sessionManager: {
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

/** Execute the tool directly with a controllable mode + ops. */
async function runTool(options: {
	mode?: BashMode;
	params?: Record<string, unknown>;
	ops?: BashOperations;
	setModeSpy?: (mode: BashMode, ctx: any) => void;
	signal?: AbortSignal;
}) {
	const { mode = "ask", params = {}, ops, setModeSpy, signal } = options;
	const { ctx, select, input } = createCtx();
	const setMode = setModeSpy ?? vi.fn();
	const def = createCodepiBashToolDefinition({
		operations: ops,
		getMode: () => mode,
		setMode: setMode as any,
	});
	const execSpy = ops ? (ops.exec as any) : undefined;
	let error: unknown;
	let result: any;
	try {
		result = await def.execute("t1", params, signal, undefined, ctx);
	} catch (err) {
		error = err;
	}
	return { result, error, ctx, select, input, setMode, execSpy };
}

// ── Pure helpers ─────────────────────────────────────────────

describe("codepi-bash: joinCommands", () => {
	it("passes through a single command string", () => {
		expect(joinCommands("ls -la")).toEqual({ ok: true, command: "ls -la" });
	});

	it("joins an array of commands with &&", () => {
		expect(joinCommands(["cd src", "npm test"])).toEqual({
			ok: true,
			command: "cd src && npm test",
		});
	});

	it("filters empty array items and trims whitespace", () => {
		expect(joinCommands(["  git status ", "", "  ls  "])).toEqual({
			ok: true,
			command: "git status && ls",
		});
	});

	it("rejects empty string, empty array, and non-string input", () => {
		expect(joinCommands("").ok).toBe(false);
		expect(joinCommands("   ").ok).toBe(false);
		expect(joinCommands([]).ok).toBe(false);
		expect(joinCommands(undefined).ok).toBe(false);
		expect(joinCommands(42).ok).toBe(false);
	});

	it("rejects arrays longer than 32 commands", () => {
		expect(
			joinCommands(Array.from({ length: 33 }, (_, i) => `cmd${i}`)).ok,
		).toBe(false);
		expect(
			joinCommands(Array.from({ length: 32 }, (_, i) => `cmd${i}`)).ok,
		).toBe(true);
	});
});

describe("codepi-bash: resolveCwd", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "codepi-bash-cwd-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("defaults to the session cwd", () => {
		expect(resolveCwd(undefined, dir)).toEqual({ ok: true, cwd: dir });
	});

	it("resolves a relative cwd against the session cwd", () => {
		mkdirSync(join(dir, "sub"));
		expect(resolveCwd("sub", dir)).toEqual({
			ok: true,
			cwd: join(dir, "sub"),
		});
	});

	it("accepts an absolute cwd", () => {
		expect(resolveCwd(dir, "/elsewhere")).toEqual({ ok: true, cwd: dir });
	});

	it("rejects a nonexistent cwd", () => {
		// strict:false disables discriminated-union narrowing, so cast to the
		// failure branch instead of relying on `if (!result.ok)`.
		const result = resolveCwd(join(dir, "nope"), dir) as {
			ok: false;
			error: string;
		};
		expect(result.error).toContain("Working directory does not exist");
	});

	it("rejects a cwd that is a file, not a directory", () => {
		const file = join(dir, "a.txt");
		writeFileSync(file, "hi");
		expect(resolveCwd(file, dir).ok).toBe(false);
	});
});

describe("codepi-bash: cleanTerminalOutput", () => {
	it("strips ANSI escape sequences", () => {
		expect(cleanTerminalOutput("a\u001b[31mb\u001b[0mc", "x")).toBe("abc");
	});

	it("normalizes CRLF and bare CR to LF", () => {
		expect(cleanTerminalOutput("a\r\nb\rc", "x")).toBe("a\nb\nc");
	});

	it("drops the echoed command line", () => {
		expect(cleanTerminalOutput("$ ls\nfile1\nfile2", "ls")).toBe(
			"file1\nfile2",
		);
	});

	it("trims leading and trailing prompt artifacts", () => {
		const out = cleanTerminalOutput(
			"user@host:~/code$\noutput line\nuser@host:~/code$",
			"pwd",
		);
		expect(out).toBe("output line");
	});

	it("keeps output that merely looks like a prompt in the middle", () => {
		expect(cleanTerminalOutput("one\ntwo$ three\nfour", "x")).toBe(
			"one\ntwo$ three\nfour",
		);
	});
});

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

describe("codepi-bash: BashOutputAccumulator", () => {
	it("returns untruncated content below the limits", () => {
		const acc = new BashOutputAccumulator({ maxLines: 10, maxBytes: 1024 });
		acc.append(Buffer.from("a\nb\nc"));
		acc.finish();
		const snap = acc.snapshot();
		expect(snap.content).toBe("a\nb\nc");
		expect(snap.truncation.truncated).toBe(false);
		expect(snap.fullOutputPath).toBeUndefined();
	});

	it("truncates by lines keeping the tail, and reports counts", () => {
		const acc = new BashOutputAccumulator({ maxLines: 3, maxBytes: 4096 });
		acc.append(Buffer.from("1\n2\n3\n4\n5\n"));
		acc.finish();
		const snap = acc.snapshot();
		expect(snap.truncation.truncated).toBe(true);
		expect(snap.truncation.truncatedBy).toBe("lines");
		expect(snap.truncation.totalLines).toBe(5);
		expect(snap.truncation.outputLines).toBe(3);
		expect(snap.content).toBe("3\n4\n5");
	});

	it("persists the full output to a temp file when truncated", () => {
		const acc = new BashOutputAccumulator({ maxLines: 2, maxBytes: 4096 });
		acc.append(Buffer.from("line one\nline two\nline three\n"));
		acc.finish();
		const snap = acc.snapshot({ persistIfTruncated: true });
		expect(snap.fullOutputPath).toBeDefined();
		expect(snap.content).toBe("line two\nline three");
	});
});

// ── Factory registration ─────────────────────────────────────

describe("codepi-bash: registration", () => {
	it("registers the mode commands, session handler, and the bash tool", () => {
		const mock = load();
		for (const name of [
			"codepi-bash-ask",
			"codepi-bash-allow",
			"codepi-bash-disable",
		]) {
			expect(mock.commands.has(name), `/${name}`).toBe(true);
		}
		expect(mock.handlers.has("session_start")).toBe(true);
		expect(mock.tools).toHaveLength(1);
		const tool = mock.tools[0] as {
			name: string;
			description: string;
			promptGuidelines: readonly string[];
			executionMode: string;
		};
		expect(tool.name).toBe("bash");
		expect(tool.description).toContain("LAST RESORT");
		expect(tool.promptGuidelines.length).toBeGreaterThan(0);
		expect(tool.executionMode).toBe("sequential");
	});
});

describe("codepi-bash: session_start", () => {
	it("defaults a new session to ask and pushes the footer status", async () => {
		const mock = load();
		const { statuses } = await startSession(mock, []);
		expect(statuses).toContainEqual({ key: STATUS_KEY, text: "ask" });
	});

	it("replays a persisted auto mode", async () => {
		const mock = load();
		const { statuses } = await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "auto" }),
		]);
		expect(statuses).toContainEqual({ key: STATUS_KEY, text: "auto" });
	});

	it("replays a persisted disabled mode", async () => {
		const mock = load();
		const { statuses } = await startSession(mock, [
			createBranchEntry(MODE_ENTRY_TYPE, { mode: "disabled" }),
		]);
		expect(statuses).toContainEqual({ key: STATUS_KEY, text: "disabled" });
	});
});

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
});

// ── Execute pipeline ─────────────────────────────────────────

describe("codepi-bash: approval dialog (ask mode)", () => {
	it("shows a 4-option select with the command and cwd; YES runs", async () => {
		mkdirSync(join(fixtureDir, "sub"));
		const mockOps = createMockOps();
		const { result, select } = await runTool({
			params: { command: "npm test", cwd: "sub" },
			ops: mockOps.ops,
		});
		expect(select).toHaveBeenCalledTimes(1);
		const [title, options] = select.mock.calls[0];
		expect(title).toContain("npm test");
		expect(title).toContain("cwd:");
		expect(options).toEqual([...DIALOG_OPTIONS]);
		expect(mockOps.exec).toHaveBeenCalledWith(
			"npm test",
			join(fixtureDir, "sub"),
			expect.any(Object),
		);
		expect(result).toBeDefined();
	});

	it("denies when the user picks No", async () => {
		const mockOps = createMockOps();
		const { ctx } = createCtx();
		ctx.ui.select.mockResolvedValue(DIALOG_OPTIONS[1]);
		const def = createCodepiBashToolDefinition({
			operations: mockOps.ops,
			getMode: () => "ask",
			setMode: () => {},
		});
		await expect(
			def.execute("t1", { command: "rm -rf /" }, undefined, undefined, ctx),
		).rejects.toThrow("denied by the user");
		expect(mockOps.exec).not.toHaveBeenCalled();
	});

	it("denies on Esc (undefined)", async () => {
		const mockOps = createMockOps();
		const { ctx } = createCtx();
		ctx.ui.select.mockResolvedValue(undefined);
		const def = createCodepiBashToolDefinition({
			operations: mockOps.ops,
			getMode: () => "ask",
			setMode: () => {},
		});
		await expect(
			def.execute("t1", { command: "ls" }, undefined, undefined, ctx),
		).rejects.toThrow("denied by the user");
		expect(mockOps.exec).not.toHaveBeenCalled();
	});

	it("revise asks for a replacement command and runs it without re-asking", async () => {
		const mockOps = createMockOps();
		const { ctx, select, input } = createCtx();
		select.mockResolvedValue(DIALOG_OPTIONS[2]); // Revise…
		input.mockResolvedValue("ls -la");
		const def = createCodepiBashToolDefinition({
			operations: mockOps.ops,
			getMode: () => "ask",
			setMode: () => {},
		});
		await def.execute("t1", { command: "ls" }, undefined, undefined, ctx);
		expect(input).toHaveBeenCalledWith(
			"Revise bash command",
			"ls",
			expect.any(Object),
		);
		expect(mockOps.exec).toHaveBeenCalledWith(
			"ls -la",
			fixtureDir,
			expect.any(Object),
		);
	});

	it("denies when the revise input is cancelled or empty", async () => {
		const mockOps = createMockOps();
		for (const answer of [undefined, "   "]) {
			const { ctx, select, input } = createCtx();
			select.mockResolvedValue(DIALOG_OPTIONS[2]);
			input.mockResolvedValue(answer);
			const def = createCodepiBashToolDefinition({
				operations: mockOps.ops,
				getMode: () => "ask",
				setMode: () => {},
			});
			await expect(
				def.execute("t1", { command: "ls" }, undefined, undefined, ctx),
			).rejects.toThrow("denied by the user");
			expect(mockOps.exec).not.toHaveBeenCalled();
		}
	});

	it("approve & auto-approve all runs AND switches the session to auto", async () => {
		const mockOps = createMockOps();
		const setMode = vi.fn();
		const { ctx, select } = createCtx();
		select.mockResolvedValue(DIALOG_OPTIONS[3]);
		const def = createCodepiBashToolDefinition({
			operations: mockOps.ops,
			getMode: () => "ask",
			setMode: setMode as any,
		});
		await def.execute(
			"t1",
			{ command: "git status" },
			undefined,
			undefined,
			ctx,
		);
		expect(setMode).toHaveBeenCalledWith("auto", ctx);
		expect(mockOps.exec).toHaveBeenCalledWith(
			"git status",
			fixtureDir,
			expect.any(Object),
		);
	});
});

describe("codepi-bash: disabled mode", () => {
	it("rejects every command without asking or executing", async () => {
		const mockOps = createMockOps();
		const { error, select } = await runTool({
			mode: "disabled",
			params: { command: "ls" },
			ops: mockOps.ops,
		});
		expect(String(error)).toContain("disabled");
		expect(String(error)).toContain("codepi-bash-ask");
		expect(select).not.toHaveBeenCalled();
		expect(mockOps.exec).not.toHaveBeenCalled();
	});

	it("rejects the command before any output is produced", async () => {
		const mockOps = createMockOps();
		const onUpdate = vi.fn();
		const def = createCodepiBashToolDefinition({
			operations: mockOps.ops,
			getMode: () => "disabled",
			setMode: () => {},
		});
		await expect(
			def.execute("t1", { command: "rm -rf /" }, undefined, onUpdate, {
				cwd: fixtureDir,
				hasUI: true,
				ui: {
					select: vi.fn(),
					input: vi.fn(),
					notify: vi.fn(),
					setStatus: vi.fn(),
				},
			} as any),
		).rejects.toThrow("disabled");
		expect(onUpdate).not.toHaveBeenCalled();
		expect(mockOps.exec).not.toHaveBeenCalled();
	});
});

describe("codepi-bash: execution results", () => {
	it("auto mode skips the dialog entirely", async () => {
		const mockOps = createMockOps();
		const { result, select } = await runTool({
			mode: "auto",
			params: { command: "ls" },
			ops: mockOps.ops,
		});
		expect(select).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("hello from shell");
	});

	it("joins an array of commands with && and passes the default timeout", async () => {
		const mockOps = createMockOps();
		await runTool({
			mode: "auto",
			params: { command: ["cd src", "npm test"] },
			ops: mockOps.ops,
		});
		expect(mockOps.exec).toHaveBeenCalledWith(
			"cd src && npm test",
			fixtureDir,
			expect.objectContaining({ timeout: DEFAULT_TIMEOUT_SECONDS }),
		);
	});

	it("throws for a non-zero exit code with the output attached", async () => {
		const { ops } = createMockOps(
			async (_cmd: string, _cwd: string, options: any) => {
				options.onData(Buffer.from("build failed\n"));
				return { exitCode: 1 };
			},
		);
		const { error } = await runTool({
			mode: "auto",
			params: { command: "npm run build" },
			ops,
		});
		expect(String(error)).toContain("Command exited with code 1");
		expect(String(error)).toContain("build failed");
	});

	it("throws when the exit code could not be determined (null)", async () => {
		const { ops } = createMockOps(
			async (_cmd: string, _cwd: string, options: any) => {
				options.onData(Buffer.from("partial\n"));
				return { exitCode: null };
			},
		);
		const { error } = await runTool({
			mode: "auto",
			params: { command: "make" },
			ops,
		});
		expect(String(error)).toContain("Could not determine");
		expect(String(error)).toContain("partial");
	});

	it("reports a timeout with the seconds", async () => {
		const { ops } = createMockOps(
			async (_cmd: string, _cwd: string, _options: any) => {
				throw new Error("timeout:42");
			},
		);
		const { error } = await runTool({
			mode: "auto",
			params: { command: "sleep 999", timeout: 42 },
			ops,
		});
		expect(String(error)).toContain("timed out after 42 seconds");
	});
});

// ── VS Code runner (mocked vscode) ───────────────────────────

describe("codepi-bash: createVscodeBashOperations", () => {
	/** Minimal vscode mock: ONLY stable APIs (createTerminal/sendText/
	 * dispose). The runner must not need any proposed API (e.g.
	 * onDidWriteTerminalData is unavailable in some builds/remotes). */
	function createVscodeMock() {
		const terminals: any[] = [];
		const disposed: number[] = [];
		const vscode = {
			window: {
				createTerminal: vi.fn((options: any) => {
					const t = {
						options,
						dispose: vi.fn(() => disposed.push(terminals.indexOf(t))),
						sendText: vi.fn(),
					};
					terminals.push(t);
					return t;
				}),
			},
		};
		return { vscode, terminals, disposed };
	}

	/** Extract the temp out/code file paths from the wrapper sendText wrote. */
	function filePaths(terminal: any): { out: string; code: string } {
		const wrapper = terminal.sendText.mock.calls[0][0] as string;
		const outMatch = wrapper.match(/^\( [\s\S]*?\) > ([^\s]+)\/out 2>&1;/);
		const codeMatch = wrapper.match(/> ([^\s]+)\/code$/);
		expect(outMatch).not.toBeNull();
		expect(codeMatch).not.toBeNull();
		return { out: `${outMatch![1]}/out`, code: `${codeMatch![1]}/code` };
	}

	it("runs commands through a minimal bash terminal with file-based capture", async () => {
		const { vscode, terminals, disposed } = createVscodeMock();
		(globalThis as any).__codepiVscode = { vscode };
		const ops = createVscodeBashOperations();
		const chunks: string[] = [];
		const resultP = ops.exec("echo hi", "/tmp", {
			onData: (d: Buffer) => chunks.push(d.toString()),
			timeout: 10,
		});
		await new Promise((r) => setTimeout(r, 20)); // let sendText fire
		const term = terminals[0];

		// The terminal must be a minimal bash: no rc files, no integration.
		expect(term.options.shellPath).toBe("/bin/bash");
		expect(term.options.shellArgs).toEqual(["--noprofile", "--norc"]);
		expect(term.options.hideFromUser).toBe(true);
		expect(term.options.isTransient).toBe(true);
		expect(term.options.cwd).toBe("/tmp");
		// Exactly one sendText: the wrapped command.
		expect(term.sendText).toHaveBeenCalledTimes(1);

		const { out, code } = filePaths(term);
		writeFileSync(out, "hi\n");
		writeFileSync(code, "0");
		const result = await resultP;
		expect(result.exitCode).toBe(0);
		expect(chunks.join("")).toBe("hi\n");
		expect(disposed.length).toBe(1);
		delete (globalThis as any).__codepiVscode;
	});

	it("wraps the command so output and exit code land in the temp files", async () => {
		const { vscode, terminals } = createVscodeMock();
		(globalThis as any).__codepiVscode = { vscode };
		const ops = createVscodeBashOperations();
		const resultP = ops.exec("python3 - <<'EOF'\nprint('hi')\nEOF", "/tmp", {
			onData: () => {},
			timeout: 10,
		});
		await new Promise((r) => setTimeout(r, 20));
		const wrapper = terminals[0].sendText.mock.calls[0][0] as string;
		// The heredoc is preserved verbatim inside a subshell group.
		expect(wrapper).toContain("( python3 - <<'EOF'\nprint('hi')\nEOF\n) > ");
		expect(wrapper).toContain("printf '%s' \"$?\" > ");
		const { out, code } = filePaths(terminals[0]);
		writeFileSync(out, "hi\n");
		writeFileSync(code, "0");
		await resultP;
		delete (globalThis as any).__codepiVscode;
	});

	it("reports a non-zero exit code", async () => {
		const { vscode, terminals } = createVscodeMock();
		(globalThis as any).__codepiVscode = { vscode };
		const ops = createVscodeBashOperations();
		const resultP = ops.exec("false", "/tmp", { onData: () => {} });
		await new Promise((r) => setTimeout(r, 20));
		const { code } = filePaths(terminals[0]);
		writeFileSync(code, "1");
		const result = await resultP;
		expect(result.exitCode).toBe(1);
		delete (globalThis as any).__codepiVscode;
	});

	it("streams output as it is written, before the command finishes", async () => {
		const { vscode, terminals } = createVscodeMock();
		(globalThis as any).__codepiVscode = { vscode };
		const ops = createVscodeBashOperations();
		const chunks: string[] = [];
		const resultP = ops.exec("slow", "/tmp", {
			onData: (d: Buffer) => chunks.push(d.toString()),
			timeout: 10,
		});
		await new Promise((r) => setTimeout(r, 20));
		const { out, code } = filePaths(terminals[0]);
		writeFileSync(out, "partial one\n");
		await new Promise((r) => setTimeout(r, 250)); // let the poll stream it
		expect(chunks.join("")).toContain("partial one");
		writeFileSync(out, "partial one\nsecond part\n");
		writeFileSync(code, "0");
		const result = await resultP;
		expect(result.exitCode).toBe(0);
		expect(chunks.join("")).toBe("partial one\nsecond part\n");
		delete (globalThis as any).__codepiVscode;
	});

	it("times out when the command never completes", async () => {
		const { vscode, terminals, disposed } = createVscodeMock();
		(globalThis as any).__codepiVscode = { vscode };
		const ops = createVscodeBashOperations();
		const resultP = ops.exec("sleep 100", "/tmp", {
			onData: () => {},
			timeout: 0.15,
		});
		await new Promise((r) => setTimeout(r, 20)); // let it start
		expect(terminals[0].sendText).toHaveBeenCalledTimes(1);
		// Never write the code file.
		await expect(resultP).rejects.toThrow(/^timeout:/);
		expect(disposed.length).toBe(1);
		delete (globalThis as any).__codepiVscode;
	});

	it("aborts a running command and disposes the terminal", async () => {
		const { vscode, disposed } = createVscodeMock();
		(globalThis as any).__codepiVscode = { vscode };
		const ops = createVscodeBashOperations();
		const controller = new AbortController();
		const resultP = ops.exec("sleep 100", "/tmp", {
			onData: () => {},
			signal: controller.signal,
		});
		await new Promise((r) => setTimeout(r, 20)); // let it start
		controller.abort();
		await expect(resultP).rejects.toThrow("aborted");
		expect(disposed.length).toBe(1);
		delete (globalThis as any).__codepiVscode;
	});

	it("cleans up the temp directory after completion", async () => {
		const { vscode, terminals } = createVscodeMock();
		(globalThis as any).__codepiVscode = { vscode };
		const ops = createVscodeBashOperations();
		const resultP = ops.exec("echo hi", "/tmp", { onData: () => {} });
		await new Promise((r) => setTimeout(r, 20));
		const { out, code } = filePaths(terminals[0]);
		expect(existsSync(dirname(out))).toBe(true); // dir created before completion
		writeFileSync(code, "0");
		await resultP;
		expect(existsSync(dirname(code))).toBe(false); // dir removed after completion
		delete (globalThis as any).__codepiVscode;
	});
});
