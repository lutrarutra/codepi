import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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
function createMockOps(
	impl?: BashOperations["exec"],
): {
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
async function runTool(
	options: {
		mode?: "ask" | "auto";
		params?: Record<string, unknown>;
		ops?: BashOperations;
		setModeSpy?: (mode: "ask" | "auto", ctx: any) => void;
		signal?: AbortSignal;
	},
) {
	const { mode = "ask", params = {}, ops, setModeSpy, signal } = options;
	const { ctx, select, input } = createCtx();
	const setMode = setModeSpy ?? vi.fn();
	const def = createCodepiBashToolDefinition({
		operations: ops,
		getMode: () => mode,
		setMode: setMode as any,
	});
	const execSpy = ops
		? (ops.exec as any)
		: undefined;
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
		expect(joinCommands(Array.from({ length: 33 }, (_, i) => `cmd${i}`)).ok).toBe(
			false,
		);
		expect(joinCommands(Array.from({ length: 32 }, (_, i) => `cmd${i}`)).ok).toBe(
			true,
		);
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
		expect(cleanTerminalOutput("$ ls\nfile1\nfile2", "ls")).toBe("file1\nfile2");
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
	it("renders terminal icon + mode label (ask/allow)", () => {
		expect(formatBashBadge("ask")).toBe("\u{F120} ask");
		expect(formatBashBadge("auto")).toBe("\u{F120} allow");
	});
});

describe("codepi-bash: readModeFromBranch", () => {
	it("defaults to ask", () => {
		expect(readModeFromBranch([])).toBe("ask");
	});

	it("replays a persisted mode and uses the latest entry", () => {
		expect(
			readModeFromBranch([createBranchEntry(MODE_ENTRY_TYPE, { mode: "auto" })]),
		).toBe("auto");
		expect(
			readModeFromBranch([
				createBranchEntry(MODE_ENTRY_TYPE, { mode: "auto" }),
				createBranchEntry(MODE_ENTRY_TYPE, { mode: "ask" }),
			]),
		).toBe("ask");
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
		for (const name of ["codepi-bash-ask", "codepi-bash-auto"]) {
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
});

describe("codepi-bash: commands", () => {
	it("switches to ask/auto, persists an entry, and updates the footer", async () => {
		const mock = load();
		await startSession(mock, []); // default ask

		const askRun = await runCommand(mock, "codepi-bash-ask", []);
		expect(askRun.notify).toHaveBeenCalledWith(
			expect.stringContaining("already ask"),
			"info",
		);

		const autoRun = await runCommand(mock, "codepi-bash-auto", []);
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
		expect(input).toHaveBeenCalledWith("Revise bash command", "ls", expect.any(Object));
		expect(mockOps.exec).toHaveBeenCalledWith("ls -la", fixtureDir, expect.any(Object));
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
		await def.execute("t1", { command: "git status" }, undefined, undefined, ctx);
		expect(setMode).toHaveBeenCalledWith("auto", ctx);
		expect(mockOps.exec).toHaveBeenCalledWith("git status", fixtureDir, expect.any(Object));
	});
});

describe("codepi-bash: execution results", () => {
	it("auto mode skips the dialog entirely", async () => {
		const mockOps = createMockOps();
		const { result, ctx, select } = await runTool({
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
		const { exec, ops } = createMockOps(
			async (_cmd: string, _cwd: string, options: any) => {
				options.onData(Buffer.from("build failed\n"));
				return { exitCode: 1 };
			},
		);
		const { error } = await runTool({ mode: "auto", params: { command: "npm run build" }, ops });
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
		const { error } = await runTool({ mode: "auto", params: { command: "make" }, ops });
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

	it("reports an abort", async () => {
		const { ops } = createMockOps(async () => {
			throw new Error("aborted");
		});
		const { error } = await runTool({ mode: "auto", params: { command: "git pull" }, ops });
		expect(String(error)).toContain("Command aborted");
	});

	it("passes through the caller's abort signal to the backend", async () => {
		const exec = vi.fn(
			async (_cmd: string, _cwd: string, options: any) => {
				options?.onData?.(Buffer.from("x"));
				return { exitCode: 0 };
			},
		);
		const ops = { exec } as any;
		const controller = new AbortController();
		await runTool({
			mode: "auto",
			params: { command: "ls" },
			ops,
			signal: controller.signal,
		});
		expect(exec).toHaveBeenCalledWith(
			"ls",
			fixtureDir,
			expect.objectContaining({ signal: controller.signal }),
		);
	});

	it("truncates oversized output with a footer and temp path", async () => {
		const big =
			Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n") + "\n";
		const { ops } = createMockOps(
			async (_cmd: string, _cwd: string, options: any) => {
				options?.onData?.(Buffer.from(big));
				return { exitCode: 0 };
			},
		);
		const { result } = await runTool({ mode: "auto", params: { command: "make noise" }, ops });
		const text = result.content[0].text;
		expect(text).toContain("Showing lines");
		expect(text).toMatch(/Showing lines \d+-\d+ of 5000/);
		expect(text).toContain("Full output:");
		expect(result.details.truncation.truncated).toBe(true);
	});

	it("rejects an invalid cwd and an invalid timeout", async () => {
		const mockOps = createMockOps();
		const { error: cwdErr } = await runTool({
			mode: "auto",
			params: { command: "ls", cwd: "/nonexistent-codepi-bash-dir" },
			ops: mockOps.ops,
		});
		expect(String(cwdErr)).toContain("Working directory does not exist");
		expect(mockOps.exec).not.toHaveBeenCalled();

		const { error: tErr } = await runTool({
			mode: "auto",
			params: { command: "ls", timeout: -5 },
			ops: mockOps.ops,
		});
		expect(String(tErr)).toContain("Invalid timeout");
	});
});

// ── VS Code runner (mocked vscode) ───────────────────────────

describe("codepi-bash: createVscodeBashOperations", () => {
	it("executes through a hidden terminal and streams output", async () => {
		// Bridge the mock vscode API in before calling the runner.
		const streams: Array<AsyncIterable<string>> = [
			(async function* () {
				yield "out one\n";
				yield "\u001b[32mout two\u001b[0m\n";
			})(),
		];
		const disposed: number[] = [];
		const terminals: any[] = [];
		const vscode = {
			window: {
				createTerminal: vi.fn((options: any) => {
					const t = {
						options,
						shellIntegration: undefined,
						dispose: () => disposed.push(terminals.indexOf(t)),
						executions: [] as any[],
					};
					terminals.push(t);
					return t;
				}),
				onDidChangeTerminalShellIntegration: vi.fn((handler: any) => {
					// Simulate shell integration activation for the first terminal.
					setTimeout(() => {
						const t = terminals[0];
						if (!t) return;
						t.shellIntegration = {
							executeCommand: vi.fn((command: string) => {
								const exec = {
									command,
									read: () => streams[0],
									exitCode: Promise.resolve(0),
								};
								return exec;
							}),
						};
						handler({ terminal: t, shellIntegration: t.shellIntegration });
					}, 0);
					return { dispose: () => {} };
				}),
			},
		};
		(globalThis as any).__codepiBashHost = { vscode };

		const ops = createVscodeBashOperations();
		const chunks: string[] = [];
		const result = await ops.exec("echo hi", "/tmp", {
			onData: (data: Buffer) => chunks.push(data.toString()),
			timeout: 10,
		});
		expect(result.exitCode).toBe(0);
		expect(chunks.join("")).toBe("out one\n\u001b[32mout two\u001b[0m\n");
		expect(terminals[0].options.hideFromUser).toBe(true);
		expect(terminals[0].options.isTransient).toBe(true);
		expect(terminals[0].options.cwd).toBe("/tmp");
		expect(disposed.length).toBe(1);
		delete (globalThis as any).__codepiBashHost;
	});

	it("falls back to sendText + sentinel when shell integration never activates", async () => {
		const terminals: any[] = [];
		let dataListener: ((e: any) => void) | undefined;
		const vscode = {
			window: {
				createTerminal: vi.fn((options: any) => {
					const t = {
						options,
						shellIntegration: undefined,
						dispose: vi.fn(),
						sendText: vi.fn(),
				};
				terminals.push(t);
				return t;
			}),
			// Never fires — shell integration never activates.
			onDidChangeTerminalShellIntegration: vi.fn(() => ({ dispose: () => {} })),
			onDidWriteTerminalData: vi.fn((listener: any) => {
				dataListener = listener;
				return { dispose: () => {} };
			}),
		},
		};
		(globalThis as any).__codepiBashHost = { vscode };

		const ops = createVscodeBashOperations({ shellIntegrationTimeoutMs: 20 });
		const chunks: string[] = [];
		const resultP = ops.exec("git status", "/tmp", {
			onData: (d: Buffer) => chunks.push(d.toString()),
			timeout: 10,
		});
		await new Promise((r) => setTimeout(r, 40)); // let the wait time out
		const term = terminals[0];
		expect(term.sendText).toHaveBeenCalledTimes(2); // command + sentinel
		const sentinel = term.sendText.mock.calls[1][0] as string;
		const marker = sentinel.match(/__CODEPI_DONE_[a-f0-9]+__/)![0];

		// Simulate the shell: prompt, echoed command, output, prompt,
		// echoed sentinel, then the marker line with the exit code.
		dataListener!({ terminal: term, data: "\n$ git status\n M file.txt\n$ " });
		dataListener!({ terminal: term, data: `echo "${marker}:$?"\n${marker}:0\n$ ` });

		const result = await resultP;
		expect(result.exitCode).toBe(0);
		expect(chunks.join("")).toContain("M file.txt");
		expect(chunks.join("")).not.toContain(marker);
		expect(term.dispose).toHaveBeenCalled();
		delete (globalThis as any).__codepiBashHost;
	});

	it("reports a non-zero exit code from the sentinel marker", async () => {
		let dataListener: ((e: any) => void) | undefined;
		const terminals: any[] = [];
		const vscode = {
			window: {
				createTerminal: vi.fn((options: any) => {
					const t = { options, shellIntegration: undefined, dispose: vi.fn(), sendText: vi.fn() };
					terminals.push(t);
					return t;
				}),
				onDidChangeTerminalShellIntegration: vi.fn(() => ({ dispose: () => {} })),
				onDidWriteTerminalData: vi.fn((listener: any) => {
					dataListener = listener;
					return { dispose: () => {} };
				}),
			},
		};
		(globalThis as any).__codepiBashHost = { vscode };
		const ops = createVscodeBashOperations({ shellIntegrationTimeoutMs: 20 });
		const resultP = ops.exec("false", "/tmp", { onData: () => {} });
		await new Promise((r) => setTimeout(r, 40));
		const term = terminals[0];
		const sentinel = term.sendText.mock.calls[1][0] as string;
		const marker = sentinel.match(/__CODEPI_DONE_[a-f0-9]+__/)![0];
		dataListener!({ terminal: term, data: `${marker}:1\n` });
		const result = await resultP;
		expect(result.exitCode).toBe(1);
		delete (globalThis as any).__codepiBashHost;
	});

	it("skips the shell-integration wait once it is known broken", async () => {
		let dataListener: ((e: any) => void) | undefined;
		let registrations = 0;
		const terminals: any[] = [];
		const vscode = {
			window: {
				createTerminal: vi.fn((options: any) => {
					const t = { options, shellIntegration: undefined, dispose: vi.fn(), sendText: vi.fn() };
					terminals.push(t);
					return t;
				}),
				onDidChangeTerminalShellIntegration: vi.fn(() => {
					registrations++;
					return { dispose: () => {} };
				}),
				onDidWriteTerminalData: vi.fn((listener: any) => {
					dataListener = listener;
					return { dispose: () => {} };
				}),
			},
		};
		(globalThis as any).__codepiBashHost = { vscode };
		const ops = createVscodeBashOperations({ shellIntegrationTimeoutMs: 20 });
		const run = async () => {
			const p = ops.exec("ls", "/tmp", { onData: () => {} });
			await new Promise((r) => setTimeout(r, 40));
			const term = terminals[terminals.length - 1];
			const sentinel = term.sendText.mock.calls[1][0] as string;
			const marker = sentinel.match(/__CODEPI_DONE_[a-f0-9]+__/)![0];
			dataListener!({ terminal: term, data: `${marker}:0\n` });
			return p;
		};
		await run();
		expect(registrations).toBe(1);
		await run();
		expect(registrations).toBe(1); // cached — no wait on the second call
		delete (globalThis as any).__codepiBashHost;
	});

	it("errors clearly when neither shell integration nor data events exist", async () => {
		const vscode = {
			window: {
				createTerminal: vi.fn(() => ({ shellIntegration: undefined, dispose: () => {} })),
				onDidChangeTerminalShellIntegration: vi.fn(() => ({ dispose: () => {} })),
				// no onDidWriteTerminalData
			},
		};
		(globalThis as any).__codepiBashHost = { vscode };
		const ops = createVscodeBashOperations({ shellIntegrationTimeoutMs: 20 });
		await expect(ops.exec("ls", "/tmp", { onData: () => {} })).rejects.toThrow(
			"Cannot capture command output",
		);
		delete (globalThis as any).__codepiBashHost;
	});
});
