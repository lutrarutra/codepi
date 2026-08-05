/**
 * codepi-bash — CodePi's `bash` tool.
 *
 * A bundled PI extension that OVERRIDES pi's built-in bash tool (extension
 * tools win over builtins in the tool registry) and executes commands through
 * a hidden, transient VS Code terminal running a minimal bash
 * (`--noprofile --norc`) instead of node's child_process.
 *
 * Ported from pi's built-in bash tool (packages/coding-agent/src/core/tools/
 * bash.ts): same schema semantics, same truncation behavior (last ~2000 lines
 * / ~50KB, full output spilled to a temp file), same renderCall/renderResult
 * presentation. The execution backend and the approval gate are CodePi's.
 *
 * Per-session bash modes:
 *   - ask (default): the 4-option dialog (Yes / No / Revise / auto-approve all)
 *   - auto: commands run without asking
 *   - disabled: every bash command is rejected (forces the agent onto the
 *     dedicated read/edit/write/grep tools)
 * Switch with /codepi-bash-ask, /codepi-bash-allow, /codepi-bash-disable; the
 * active mode is persisted to the session branch and shown in the custom
 * footer via the "codepi-bash" status key.
 *
 * The agent is told to treat bash as a LAST RESORT (dedicated tools exist for
 * read/edit/write/grep/find/diagnostics) — see the tool description and
 * promptGuidelines below.
 */
import type {
	AgentToolResult,
	BashOperations,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
	TruncationResult,
} from "@earendil-works/pi-coding-agent";
import {
	formatSize,
	keyHint,
	truncateTail,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// ── Constants ────────────────────────────────────────────────

const MODE_ENTRY_TYPE = "codepi-bash:mode";
const STATUS_KEY = "codepi-bash";
export const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_COMMANDS = 32;
const MAX_TITLE_CHARS = 100;
const VSCODE_BRIDGE_KEY = "__codepiVscode";
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

export type BashMode = "ask" | "auto" | "disabled";
export type DialogChoice = "approve" | "deny" | "revise" | "auto" | "cancel";

/** The 4-option approval dialog. Option 0 is pre-selected → Enter approves. */
export const DIALOG_OPTIONS = [
	"Yes, approve",
	"No, deny",
	"Revise…",
	"Approve & auto-approve all",
] as const;

const BASH_DESCRIPTION = `Run a shell command through the VS Code terminal, in the given working directory. Returns stdout and stderr. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); if truncated, the full output is saved to a temp file and the path is reported. Optionally provide a timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}). \`command\` may be a single command string or an array of commands, which are joined with " && " and run sequentially.

USE ONLY AS A LAST RESORT — prefer the dedicated tools whenever they can do the job:
- search file names → find
- search file CONTENTS → grep (never use bash grep)
- read files → read
- create/edit files → write / edit (never use bash sed, echo >, or cat >)
- compiler/linter problems → get_diagnostics
Use bash only for what a shell uniquely does: build/test/install/run commands, git operations, process management, and filesystem operations beyond the other tools' scope.`;

const BASH_PROMPT_GUIDELINES: string[] = [
	"Prefer dedicated tools over bash: grep for content search, find for file names, read for file contents, edit/write for changes, get_diagnostics for problems. Use bash only when a shell uniquely does the job (build, test, run, git, install, process management).",
	"Do not use bash for tasks other tools already cover (no `bash grep`, no `bash sed`-style edits).",
	"Use the cwd parameter to set the working directory instead of prefixing commands with `cd <dir> &&`. The session cwd is already the default.",
];

const BASH_SCHEMA = Type.Object({
	command: Type.Union(
		[
			Type.String({
				description:
					"The bash command to execute (string or array of strings joined with &&)",
			}),
			Type.Array(
				Type.String({
					description:
						"Multiple commands, joined with ' && ' and run sequentially",
				}),
			),
		],
		{ description: "Command(s) to execute" },
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for the command (absolute, or relative to the session cwd). Default: the session cwd.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}). The command is killed when it exceeds this.`,
		}),
	),
});

// ── Pure helpers (unit-tested) ───────────────────────────────

export type JoinResult =
	| { ok: true; command: string }
	| { ok: false; error: string };

/**
 * Normalize the `command` parameter: a single string, or an array of strings
 * joined with " && ". Empty inputs and absurdly long arrays are rejected.
 */
export function joinCommands(command: unknown): JoinResult {
	if (Array.isArray(command)) {
		if (command.length === 0) {
			return { ok: false, error: "bash: command list is empty." };
		}
		if (command.length > MAX_COMMANDS) {
			return {
				ok: false,
				error: `bash: too many commands (max ${MAX_COMMANDS}). Split the work into smaller tool calls.`,
			};
		}
		const parts: string[] = [];
		for (const item of command) {
			if (typeof item !== "string") continue;
			const trimmed = item.trim();
			if (trimmed !== "") parts.push(trimmed);
		}
		if (parts.length === 0) {
			return { ok: false, error: "bash: command is empty." };
		}
		return { ok: true, command: parts.join(" && ") };
	}
	if (typeof command !== "string" || command.trim() === "") {
		return { ok: false, error: "bash: command is required." };
	}
	return { ok: true, command: command.trim() };
}

export type CwdResult =
	| { ok: true; cwd: string }
	| { ok: false; error: string };

/** Resolve the `cwd` parameter (default: session cwd) and validate it exists. */
export function resolveCwd(cwd: unknown, sessionCwd: string): CwdResult {
	const base =
		typeof cwd === "string" && cwd.trim() !== "" ? cwd.trim() : sessionCwd;
	const absolute = isAbsolute(base) ? base : resolve(sessionCwd, base);
	try {
		if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
			return {
				ok: false,
				error: `Working directory does not exist: ${absolute}`,
			};
		}
	} catch {
		return {
			ok: false,
			error: `Working directory does not exist: ${absolute}`,
		};
	}
	return { ok: true, cwd: absolute };
}

const ANSI_ESCAPE_RE =
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const PROMPT_LINE_RE = /^[\w@~/.\-:]+[%$#>]\s*$/;

/**
 * Clean raw terminal output for the agent: strip ANSI escapes, normalize line
 * endings, drop the echoed command line, and trim trailing prompt artifacts.
 */
export function cleanTerminalOutput(raw: string, command: string): string {
	const text = raw
		.replace(ANSI_ESCAPE_RE, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	const lines = text.split("\n");
	// Drop the echoed command line (shell integration echoes the typed command,
	// often prefixed with the prompt: "user@host:dir$ ls").
	if (lines.length > 0) {
		const first = lines[0].trim();
		if (first === command.trim()) {
			lines.shift();
		} else {
			const m = first.match(/^(.*[%$#>]\s*)(.+)$/);
			if (m && m[2].trim() === command.trim()) lines.shift();
		}
	}
	// A leading prompt may remain when the echo was already consumed.
	if (lines.length > 0 && PROMPT_LINE_RE.test(lines[0].trim())) {
		lines.shift();
	}
	// Trim trailing prompt artifacts.
	while (
		lines.length > 0 &&
		PROMPT_LINE_RE.test(lines[lines.length - 1].trim())
	) {
		lines.pop();
	}
	return lines.join("\n").trim();
}

/**
 * Footer badge text — terminal icon + mode label (`\u{EBCA} ask` /
 * `\u{EBCA} allow` / `\u{EBCA} disabled`). The icon is nf-cod-terminal_bash,
 * the same glyph codepi-footer.ts renders for the "codepi-bash" footer status.
 */
export function formatBashBadge(mode: BashMode): string {
	const icon = "\u{EBCA}";
	if (mode === "ask") return `${icon} ask`;
	if (mode === "auto") return `${icon} allow`;
	return `${icon} disabled`;
}

/** Replay the persisted approval mode from the session branch (default ask). */
export function readModeFromBranch(branch: readonly unknown[]): BashMode {
	let mode: BashMode = "ask";
	for (const entry of branch) {
		if (!isRecord(entry)) continue;
		if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) {
			continue;
		}
		const data = isRecord(entry.data) ? entry.data : {};
		if (
			data.mode === "ask" ||
			data.mode === "auto" ||
			data.mode === "disabled"
		) {
			mode = data.mode;
		}
	}
	return mode;
}

/** Map a dialog selection to a decision. Esc (undefined) = cancel. */
export function mapDialogChoice(choice: string | undefined): DialogChoice {
	if (choice === undefined) return "cancel";
	switch (choice) {
		case DIALOG_OPTIONS[0]:
			return "approve";
		case DIALOG_OPTIONS[1]:
			return "deny";
		case DIALOG_OPTIONS[2]:
			return "revise";
		case DIALOG_OPTIONS[3]:
			return "auto";
		default:
			return "cancel";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

// ── Output accumulation (ported from pi's builtin bash) ─────

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Incrementally tracks streaming output with bounded memory: keeps a rolling
 * tail for display, and spills the FULL output to a temp file once the limits
 * are exceeded (mirrors pi's builtin OutputAccumulator, string-based).
 */
export class BashOutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;

	private buffer = "";
	private spilled = false;
	private tail = "";
	private totalBytes = 0;
	private totalLines = 0;
	private tempFilePath: string | undefined;
	private tempStream: ReturnType<typeof createWriteStream> | undefined;
	private finished = false;

	constructor(
		options: {
			maxLines?: number;
			maxBytes?: number;
			tempFilePrefix?: string;
		} = {},
	) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1024);
		this.tempFilePrefix = options.tempFilePrefix ?? "codepi-bash";
	}

	append(data: Buffer | string): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}
		const text = typeof data === "string" ? data : data.toString("utf-8");
		if (text.length === 0) return;
		this.totalBytes += byteLength(text);
		this.totalLines += (text.match(/\n/g) ?? []).length;
		if (this.tempStream) {
			this.tempStream.write(text);
			this.appendToTail(text);
		} else if (this.shouldSpill()) {
			this.spill();
			this.tempStream.write(text);
			this.appendToTail(text);
		} else {
			this.buffer += text;
		}
	}

	finish(): void {
		if (this.finished) return;
		this.finished = true;
		const view = this.spilled ? this.tail : this.buffer;
		if (view.length > 0 && !view.endsWith("\n")) {
			this.totalLines += 1; // unterminated final line
		}
		if (this.tempStream) {
			this.tempStream.end();
			this.tempStream = undefined;
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const view = this.spilled ? this.tail : this.buffer;
		const tailResult = truncateTail(view, {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated =
			this.totalLines > this.maxLines || this.totalBytes > this.maxBytes;
		const truncatedBy: TruncationResult["truncatedBy"] = truncated
			? (tailResult.truncatedBy ??
				(this.totalBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailResult,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalBytes,
		};
		if (options.persistIfTruncated && truncated) {
			this.ensureTempFile();
			if (!this.spilled) {
				// Defensive: limits crossed but not yet spilled (cannot normally
				// happen — spill occurs on the appending chunk) — persist what
				// we have so the temp file is complete.
				this.tempStream?.write(this.buffer);
				this.buffer = "";
			}
		}
		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.tempFilePath,
		};
	}

	private shouldSpill(): boolean {
		return this.totalBytes > this.maxBytes || this.totalLines > this.maxLines;
	}

	private spill(): void {
		this.ensureTempFile();
		this.tempStream?.write(this.buffer);
		this.buffer = "";
		this.tail = "";
		this.spilled = true;
	}

	private appendToTail(text: string): void {
		this.tail += text;
		if (byteLength(this.tail) > this.maxRollingBytes) {
			// Trim from the start, keeping whole characters.
			const excess = this.tail.length - this.maxRollingBytes;
			if (excess > 0) this.tail = this.tail.slice(excess);
		}
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) return;
		this.tempFilePath = join(
			tmpdir(),
			`${this.tempFilePrefix}-${randomBytes(8).toString("hex")}.log`,
		);
		this.tempStream = createWriteStream(this.tempFilePath);
	}
}

// ── VS Code terminal execution backend ───────────────────────

/**
 * Lazy vscode access for the bash tool. The bundled extension runs inside the
 * extension host process, but jiti's own ESM loader CANNOT resolve the
 * "vscode" module (the host only intercepts its own require/import paths), so
 * the host hands the API over via the `globalThis.__codepiVscode` bridge
 * (set in extension.ts activate, shared with codepi-context). createRequire is
 * a second-chance fallback:
 * node's CJS Module._load IS intercepted for "vscode" in the host.
 */
export async function getVscode(): Promise<any | undefined> {
	const g = globalThis as Record<string, any>;
	if (g[VSCODE_BRIDGE_KEY]?.vscode) return g[VSCODE_BRIDGE_KEY].vscode;
	try {
		const { createRequire } = await import("node:module");
		const req = createRequire(import.meta.url);
		return req("vscode");
	} catch {
		/* not in an extension host */
	}
	try {
		return await import("vscode");
	} catch {
		return undefined;
	}
}

/** Create the hidden, transient terminal all commands run in. */
function createHiddenTerminal(vscode: any, cwd: string): any {
	return vscode.window.createTerminal({
		name: "CodePi bash",
		cwd,
		hideFromUser: true,
		isTransient: true,
		// A MINIMAL shell on purpose: no rc files, no prompt themes (p10k,
		// etc.), no shell-integration scripts. Running in the user's heavy
		// interactive shell breaks command execution: prompt themes clobber
		// $? and re-render prompts into the captured stream, and VS Code's
		// shell-integration exit-code tracking never settles for heredoc/
		// multi-line input. A bare bash + the sentinel marker (see
		// runViaSendText) gives exact exit codes and clean output for every
		// command shape. Env is inherited from the extension host — the same
		// semantics as pi's built-in bash tool.
		shellPath: "/bin/bash",
		shellArgs: ["--noprofile", "--norc"],
	});
}

/**
 * BashOperations backend backed by a per-command hidden VS Code terminal.
 * Terminal disposal is the kill switch for timeouts and aborts.
 *
 * One execution path, 100% STABLE VS Code APIs (`createTerminal`/`sendText`/
 * `dispose`): the command runs with output redirected to a temp file, and a
 * sentinel writes the exit code to a second temp file which is polled. No
 * shell integration and no proposed API (see createHiddenTerminal for why
 * the shell is minimal; `onDidWriteTerminalData` is unavailable in some
 * builds/remotes).
 *
 * Follows pi's BashOperations contract: throws Error("timeout:<secs>") on
 * timeout and Error("aborted") on abort (the tool's execute formats them).
 */
export function createVscodeBashOperations(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const vscode = await getVscode();
			if (!vscode?.window) {
				throw new Error(
					"VS Code API unavailable — the bash tool must run inside the VS Code extension host.",
				);
			}

			// One hidden terminal per command; disposing it is the kill switch.
			const terminal = createHiddenTerminal(vscode, cwd);
			let disposed = false;
			const dispose = () => {
				if (disposed) return;
				disposed = true;
				try {
					terminal.dispose();
				} catch {
					/* ignore */
				}
			};
			const dir = join(
				tmpdir(),
				`codepi-bash-${randomBytes(8).toString("hex")}`,
			);
			mkdirSync(dir, { recursive: true });
			try {
				return await runWithOutputCapture(terminal, command, {
					onData,
					signal,
					timeout,
					dir,
				});
			} finally {
				dispose();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}

/**
 * Execute via `sendText` in the minimal terminal, capturing output and the
 * exit code through temp files instead of the (proposed, often unavailable)
 * `onDidWriteTerminalData` event:
 *
 *   ( <command>
 *   ) > <dir>/out 2>&1; printf '%s' "$?" > <dir>/code
 *
 * The subshell keeps `exit`/`cd`/backgrounding scoped to the command, and
 * output is captured verbatim (no echo/prompt noise). Output is streamed by
 * polling <dir>/out for growth; completion is detected by <dir>/code
 * appearing (a parse error on the wrapper leaves the shell waiting and
 * surfaces as a timeout — bounded, not a hang). Needs only stable VS Code
 * APIs; interactive TUI programs lose their pty, which is acceptable for a
 * coding-agent bash tool.
 */
async function runWithOutputCapture(
	terminal: any,
	command: string,
	options: {
		onData: (data: Buffer) => void;
		signal: AbortSignal | undefined;
		timeout?: number;
		dir: string;
	},
): Promise<{ exitCode: number | null }> {
	const { onData, signal, timeout, dir } = options;
	const outFile = join(dir, "out");
	const codeFile = join(dir, "code");
	const wrapper = `( ${command}\n) > ${outFile} 2>&1; printf '%s' "$?" > ${codeFile}`;

	return new Promise((resolve, reject) => {
		let settled = false;
		let lastSize = 0;
		let poll: ReturnType<typeof setInterval> | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (poll) clearInterval(poll);
			if (timer) clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({ exitCode });
		};
		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};
		const onAbort = () => {
			fail(new Error("aborted"));
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		const timeoutMs =
			timeout !== undefined ? Math.round(timeout * 1000) : undefined;
		if (timeoutMs !== undefined && timeoutMs > 0) {
			timer = setTimeout(() => {
				fail(new Error(`timeout:${Math.round(timeoutMs / 1000)}`));
			}, timeoutMs);
		}

		poll = setInterval(() => {
			// Stream any newly written output.
			try {
				const size = statSync(outFile).size;
				if (size > lastSize) {
					const fd = openSync(outFile, "r");
					try {
						const chunk = Buffer.alloc(size - lastSize);
						readSync(fd, chunk, 0, chunk.length, lastSize);
						lastSize = size;
						onData(chunk);
					} finally {
						closeSync(fd);
					}
				}
			} catch {
				/* out file not created yet */
			}
			// Completion: the exit-code file appears with content. Skip empty
			// reads (the sentinel may be mid-write) and check again next poll.
			try {
				const code = readFileSync(codeFile, "utf8").trim();
				if (code !== "") {
					const exitCode = Number.parseInt(code, 10);
					finish(Number.isNaN(exitCode) ? null : exitCode);
				}
			} catch {
				/* not finished yet */
			}
		}, 100);

		terminal.sendText(wrapper);
	});
}

// ── Approval dialog ──────────────────────────────────────────

/** Ask the user whether the command may run (4 options, YES default). */
async function askApproval(
	ctx: ExtensionContext,
	command: string,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<DialogChoice> {
	const title =
		"Approve bash command?\n" +
		truncateToWidth(command, MAX_TITLE_CHARS) +
		"\ncwd: " +
		cwd;
	const choice = await ctx.ui.select(title, [...DIALOG_OPTIONS], { signal });
	return mapDialogChoice(choice);
}

// ── Tool definition (ported from pi's builtin bash) ──────────

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: ReturnType<typeof setInterval> | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(
	args: { command?: unknown; timeout?: unknown } | undefined,
	theme: Theme,
): string {
	const raw = args?.command;
	const command = Array.isArray(raw)
		? raw.join(" && ")
		: typeof raw === "string"
			? raw
			: raw === undefined
				? ""
				: String(raw);
	const timeout =
		typeof args?.timeout === "number" ? (args.timeout as number) : undefined;
	const timeoutSuffix = timeout
		? theme.fg("muted", ` (timeout ${timeout}s)`)
		: "";
	const commandDisplay = command
		? theme.fg("toolTitle", theme.bold(`$ ${command}`))
		: theme.fg("toolOutput", "...");
	return commandDisplay + timeoutSuffix;
}

function getTextOutput(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	let out = "";
	for (const c of result.content) {
		if (c.type === "text" && typeof c.text === "string") out += c.text;
	}
	return out;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: { truncation?: TruncationResult; fullOutputPath?: string };
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (
		!options.isPartial &&
		truncation?.truncated &&
		fullOutputPath &&
		output.endsWith("]")
	) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (
			footerStart !== -1 &&
			output.slice(footerStart).includes(fullOutputPath)
		) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(
							styledOutput,
							BASH_PREVIEW_LINES,
							width,
						);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return [
							"",
							truncateToWidth(hint, width, "..."),
							...(state.cachedLines ?? []),
						];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(
					`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
				);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(
			new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0),
		);
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(
			new Text(
				`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`,
				0,
				0,
			),
		);
	}
}

export interface CodepiBashToolOptions {
	/** Execution backend. Default: VS Code terminal. */
	operations?: BashOperations;
	/** Current approval mode (module state). Default: "ask". */
	getMode?: () => BashMode;
	/** Persist a mode change (entry + footer status + notify). */
	setMode?: (mode: BashMode, ctx: ExtensionContext) => void;
}

/**
 * The `bash` tool definition. Ported from pi's `createBashToolDefinition`
 * (same truncation/render behavior, thrown errors carry the output) with:
 * - `command` accepting a string OR an array (joined with " && "),
 * - a per-call `cwd` (default: session cwd),
 * - a default timeout,
 * - the ask/auto/disabled gate,
 * - last-resort guidance in the description + promptGuidelines.
 */
export function createCodepiBashToolDefinition(
	options: CodepiBashToolOptions = {},
): ToolDefinition<any, unknown, BashRenderState> {
	const ops = options.operations ?? createVscodeBashOperations();
	const getMode = options.getMode ?? (() => "ask" as BashMode);
	const setMode = options.setMode ?? (() => {});

	return {
		name: "bash",
		label: "Bash",
		description: BASH_DESCRIPTION,
		promptSnippet:
			"Run shell commands — only when dedicated tools cannot (last resort)",
		promptGuidelines: BASH_PROMPT_GUIDELINES,
		parameters: BASH_SCHEMA,
		executionMode: "sequential",
		async execute(
			_toolCallId,
			params,
			signal,
			onUpdate,
			ctx,
		): Promise<AgentToolResult<unknown>> {
			// ── Disabled gate ──
			if (getMode() === "disabled") {
				throw new Error(
					"The bash tool is disabled. Enable it with /codepi-bash-ask (ask before every command) or /codepi-bash-allow (auto-approve all commands).",
				);
			}

			const {
				command: rawCommand,
				cwd: rawCwd,
				timeout,
			} = (params ?? {}) as {
				command?: unknown;
				cwd?: unknown;
				timeout?: unknown;
			};

			const joined = joinCommands(rawCommand);
			if ("error" in joined) throw new Error(joined.error);

			const sessionCwd = ctx?.cwd ?? process.cwd();
			const resolved = resolveCwd(rawCwd, sessionCwd);
			if ("error" in resolved) throw new Error(resolved.error);

			const timeoutSecs =
				timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : timeout;
			if (
				typeof timeoutSecs !== "number" ||
				!Number.isFinite(timeoutSecs) ||
				timeoutSecs <= 0
			) {
				throw new Error(
					"Invalid timeout: must be a positive number of seconds.",
				);
			}

			// ── Approval gate (ask mode) ──
			let command = joined.command;
			if (getMode() === "ask" && ctx?.ui) {
				const decision = await askApproval(ctx, command, resolved.cwd, signal);
				if (decision === "deny" || decision === "cancel") {
					throw new Error("Command execution denied by the user.");
				}
				if (decision === "auto") {
					setMode("auto", ctx);
				}
				if (decision === "revise") {
					const revised = await ctx.ui.input("Revise bash command", command, {
						signal,
					});
					if (revised === undefined || revised.trim() === "") {
						throw new Error("Command execution denied by the user.");
					}
					command = revised.trim();
				}
			}

			// ── Execute (ported from pi's builtin bash) ──
			const output = new BashOutputAccumulator({
				tempFilePrefix: "codepi-bash",
			});
			let acceptingOutput = true;
			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				// Terminal streams are raw: strip ANSI, the echoed command line,
				// and prompt artifacts before the agent sees them.
				const cleaned = cleanTerminalOutput(snapshot.content || "", command);
				onUpdate({
					content: [{ type: "text", text: cleaned }],
					details: {
						truncation: snapshot.truncation.truncated
							? snapshot.truncation
							: undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				return snapshot;
			};

			const formatOutput = (
				snapshot: OutputSnapshot,
				emptyText = "(no output)",
			) => {
				const truncation = snapshot.truncation;
				// Terminal streams are raw — clean the echo/prompt/ANSI artifacts
				// before the agent sees the output (cleaning only removes text, so
				// the truncated view stays within the limits).
				const cleaned = cleanTerminalOutput(snapshot.content || "", command);
				let text = cleaned || emptyText;
				let details:
					| {
							truncation?: TruncationResult;
							fullOutputPath?: string;
					  }
					| undefined;
				if (truncation.truncated) {
					details = {
						truncation,
						fullOutputPath: snapshot.fullOutputPath,
					};
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(
							byteLength(cleaned.split("\n").pop() ?? ""),
						);
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) =>
				`${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(command, resolved.cwd, {
						onData: handleData,
						signal,
						timeout: timeoutSecs,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const secs = err.message.split(":")[1];
						throw new Error(
							appendStatus(text, `Command timed out after ${secs} seconds`),
						);
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0) {
					if (exitCode === null) {
						throw new Error(
							appendStatus(
								outputText,
								"Could not determine the command's exit code (the sentinel did not report one).",
							),
						);
					}
					throw new Error(
						appendStatus(outputText, `Command exited with code ${exitCode}`),
					);
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const state = context.state;
			if (
				state.startedAt !== undefined &&
				options.isPartial &&
				!state.interval
			) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ??
				new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				theme,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

// ── Extension factory ────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let currentMode: BashMode = "ask";

	/** Persist a mode change: footer status, session entry, notification. */
	function setMode(mode: BashMode, ctx: ExtensionContext): void {
		currentMode = mode;
		ctx.ui.setStatus(STATUS_KEY, mode);
		pi.appendEntry(MODE_ENTRY_TYPE, { mode, timestamp: Date.now() });
		const messages: Record<BashMode, string> = {
			ask: "Bash approval: ask before every command.",
			auto: "Bash approval: auto-approve all commands.",
			disabled: "Bash tool disabled — commands are rejected until re-enabled.",
		};
		ctx.ui.notify(messages[mode]);
	}

	// Recover the persisted mode (also fires on session reload/fork).
	pi.on("session_start", async (_event, ctx) => {
		currentMode = readModeFromBranch(ctx.sessionManager.getBranch());
		ctx.ui.setStatus(STATUS_KEY, currentMode);
	});

	async function transitionTo(
		mode: BashMode,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		await ctx.waitForIdle();
		if (currentMode === mode) {
			ctx.ui.notify(`Bash is already in ${mode} mode.`, "info");
			return;
		}
		setMode(mode, ctx);
	}

	pi.registerCommand("codepi-bash-ask", {
		description: "Ask before running bash commands",
		handler: async (_args, ctx) => transitionTo("ask", ctx),
	});

	pi.registerCommand("codepi-bash-allow", {
		description: "Auto-approve all bash commands",
		handler: async (_args, ctx) => transitionTo("auto", ctx),
	});

	pi.registerCommand("codepi-bash-disable", {
		description: "Disable the bash tool",
		handler: async (_args, ctx) => transitionTo("disabled", ctx),
	});

	pi.registerTool(
		createCodepiBashToolDefinition({
			getMode: () => currentMode,
			setMode,
		}),
	);
}
