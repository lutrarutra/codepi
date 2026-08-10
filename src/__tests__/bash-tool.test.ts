import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
	BashOutputAccumulator,
	DEFAULT_TIMEOUT_SECONDS,
	cleanTerminalOutput,
	createCodepiBashToolDefinition,
	createVscodeBashOperations,
	joinCommands,
	resolveCwd,
	type BashMode,
} from "../tools/bash";
import { setBashBridge, type BashApprovalResult } from "../../resources/extensions/bash-bridge";
import { wrapToolDefinition } from "../tools/wrap-tool";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

// ── Helpers ──────────────────────────────────────────────────

const TEST_SESSION = "bash-tool-test-session";

/** Real temp dir used as the session cwd so resolveCwd passes. */
let fixtureDir: string;
beforeEach(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "codepi-bash-fixture-"));
});
afterEach(() => {
	rmSync(fixtureDir, { recursive: true, force: true });
	setBashBridge(TEST_SESSION, undefined);
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

/** Register a bridge whose approval dialog resolves with `result`. */
function registerBridge(result: BashApprovalResult) {
	const requestApproval = vi.fn().mockResolvedValue(result);
	setBashBridge(TEST_SESSION, {
		getMode: () => "ask",
		requestApproval,
	});
	return requestApproval;
}

// The SDK's ToolDefinition type demands a 5th (ExtensionContext) argument at
// call sites, but the host tool's execute never receives one — loosen the
// call signature for direct invocation in tests.
type ExecutableTool = {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (partial: unknown) => void,
	): Promise<any>;
};

/** Execute the tool directly with a controllable mode + ops. */
async function runTool(options: {
	mode?: BashMode;
	params?: Record<string, unknown>;
	ops?: BashOperations;
	signal?: AbortSignal;
	approval?: BashApprovalResult | "missing-bridge";
}) {
	const { mode = "ask", params = {}, ops, signal, approval } = options;
	const requestApproval =
		approval === undefined
			? undefined
			: approval === "missing-bridge"
				? undefined
				: registerBridge(approval);
	if (approval === undefined) {
		// No bridge override: register one so "ask" has a dialog to call.
		registerBridge({ decision: "approve" });
	}
	const def = createCodepiBashToolDefinition({
		sessionId: TEST_SESSION,
		cwd: fixtureDir,
		operations: ops,
		getMode: () => mode,
	}) as unknown as ExecutableTool;
	const execSpy = ops ? (ops.exec as any) : undefined;
	let error: unknown;
	let result: any;
	try {
		result = await def.execute("t1", params, signal, undefined);
	} catch (err) {
		error = err;
	}
	return { result, error, requestApproval, execSpy };
}

// ── Pure helpers ─────────────────────────────────────────────

describe("bash tool: joinCommands", () => {
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

describe("bash tool: resolveCwd", () => {
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

describe("bash tool: cleanTerminalOutput", () => {
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

describe("bash tool: BashOutputAccumulator", () => {
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

// ── Approval gate (via the codepi-bash bridge) ───────────────

describe("bash tool: approval gate (ask mode)", () => {
	it("routes the approval through the session bridge with command and cwd", async () => {
		mkdirSync(join(fixtureDir, "sub"));
		const mockOps = createMockOps();
		const requestApproval = registerBridge({ decision: "approve" });
		const def = wrapToolDefinition(
			createCodepiBashToolDefinition({
				sessionId: TEST_SESSION,
				cwd: fixtureDir,
				operations: mockOps.ops,
				getMode: () => "ask",
			}),
		);
		await def.execute("t1", { command: "npm test", cwd: "sub" }, undefined, undefined);
		expect(requestApproval).toHaveBeenCalledTimes(1);
		expect(requestApproval).toHaveBeenCalledWith(
			"npm test",
			join(fixtureDir, "sub"),
			undefined,
		);
		expect(mockOps.exec).toHaveBeenCalledWith(
			"npm test",
			join(fixtureDir, "sub"),
			expect.any(Object),
		);
	});

	it("denies when the bridge denies", async () => {
		const mockOps = createMockOps();
		registerBridge({ decision: "deny" });
		const { error } = await runTool({
			params: { command: "rm -rf /" },
			ops: mockOps.ops,
			approval: { decision: "deny" },
		});
		expect(String(error)).toContain("denied by the user");
		expect(mockOps.exec).not.toHaveBeenCalled();
	});

	it("runs the revised command when the bridge returns one", async () => {
		const mockOps = createMockOps();
		registerBridge({ decision: "revise", command: "ls -la" });
		const { error } = await runTool({
			params: { command: "ls" },
			ops: mockOps.ops,
			approval: { decision: "revise", command: "ls -la" },
		});
		expect(error).toBeUndefined();
		expect(mockOps.exec).toHaveBeenCalledWith(
			"ls -la",
			fixtureDir,
			expect.any(Object),
		);
	});

	it("fails safe when the bridge is missing (extension not registered)", async () => {
		const mockOps = createMockOps();
		const { error, requestApproval } = await runTool({
			params: { command: "ls" },
			ops: mockOps.ops,
			approval: "missing-bridge",
		});
		expect(String(error)).toContain("approval UI is not available");
		expect(requestApproval).toBeUndefined();
		expect(mockOps.exec).not.toHaveBeenCalled();
	});

	it("defaults to the bridge mode when no getMode is provided", async () => {
		const mockOps = createMockOps();
		registerBridge({ decision: "approve" });
		// No getMode → the factory reads the bridge's mode ("ask").
		const def = createCodepiBashToolDefinition({
			sessionId: TEST_SESSION,
			cwd: fixtureDir,
			operations: mockOps.ops,
		}) as unknown as ExecutableTool;
		await def.execute("t1", { command: "ls" }, undefined, undefined);
		expect(mockOps.exec).toHaveBeenCalledTimes(1);
	});
});

describe("bash tool: disabled mode", () => {
	it("rejects every command without asking or executing", async () => {
		const mockOps = createMockOps();
		const { error, requestApproval } = await runTool({
			mode: "disabled",
			params: { command: "ls" },
			ops: mockOps.ops,
		});
		expect(String(error)).toContain("disabled");
		expect(String(error)).toContain("codepi-bash-ask");
		expect(requestApproval).toBeUndefined();
		expect(mockOps.exec).not.toHaveBeenCalled();
	});

	it("rejects the command before any output is produced", async () => {
		const mockOps = createMockOps();
		const onUpdate = vi.fn();
		const def = createCodepiBashToolDefinition({
			sessionId: TEST_SESSION,
			cwd: fixtureDir,
			operations: mockOps.ops,
			getMode: () => "disabled",
		}) as unknown as ExecutableTool;
		await expect(
			def.execute("t1", { command: "rm -rf /" }, undefined, onUpdate),
		).rejects.toThrow("disabled");
		expect(onUpdate).not.toHaveBeenCalled();
		expect(mockOps.exec).not.toHaveBeenCalled();
	});
});

// ── Execution results ────────────────────────────────────────

describe("bash tool: execution results", () => {
	it("auto mode skips the dialog entirely", async () => {
		const mockOps = createMockOps();
		const { result } = await runTool({
			mode: "auto",
			params: { command: "ls" },
			ops: mockOps.ops,
		});
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

describe("bash tool: createVscodeBashOperations", () => {
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
