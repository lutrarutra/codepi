/**
 * codepi-task — reusable per-project tasks (.pi/tasks.json).
 *
 * A bundled PI extension managing reusable shell "tasks" (build, test, lint,
 * package, …) persisted per project in `<root>/.pi/tasks.json` — a map keyed
 * by unique task name. Provides five agent tools (`codepi-task-create`,
 * `codepi-task-edit`, `codepi-task-delete`, `codepi-task-run`,
 * `codepi-task-list`) and five slash commands (`/codepi-task-*`).
 *
 * Semantics:
 * - `when` ("before-implement" | "after-implement" | "anytime"): the agent is
 *   reminded to use the tasks via a system-prompt section (before_agent_start)
 *   and a quiet follow-up nudge after turns that modified files (gated by
 *   `codepi.tasks.injectPrompt` / `codepi.tasks.remindAfterImplement` in
 *   `<agentDir>/settings.json`).
 * - `readOnly`: tasks marked readOnly may run in Ask (read-only) mode; all
 *   others are blocked there (mode read from the `codepi-modes:mode` session
 *   branch entries). Ask-mode gating is enforced here, inside the tool.
 * - Permission: creating/editing/deleting a task requires the user's approval
 *   via the `ask_user_question` tool. The three mutating tools accept a
 *   `confirmed` param and refuse to write without it, returning the exact
 *   question text (what the task does + a pointer to .pi/tasks.json) for the
 *   agent to ask.
 * - Execution: `codepi-task-run` executes through the same hidden VS Code
 *   terminal backend as codepi-bash (sibling import of ./codepi-bash.ts) and
 *   reuses its output accumulation/truncation. It honors the persisted
 *   `codepi-bash:mode` ONLY for the disabled gate: while the bash tool is in
 *   `disabled` mode, no task may run (warning). Predefined tasks are trusted,
 *   so no per-run approval dialog is shown in ask/auto modes.
 */
import type {
	AgentEndEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
	TruncationResult,
} from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	formatSize,
	getAgentDir,
	keyHint,
	truncateToVisualLines,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	BashOutputAccumulator,
	cleanTerminalOutput,
	createVscodeBashOperations,
	joinCommands,
	resolveCwd,
} from "../../src/tools/bash";
import { readModeFromBranch } from "./codepi-bash";

// ── Constants ────────────────────────────────────────────────

export const TASK_WHEN_VALUES = [
	"before-implement",
	"after-implement",
	"anytime",
] as const;
export type TaskWhen = (typeof TASK_WHEN_VALUES)[number];

/** Typebox enum schema for `when` (Type.Union of literals — works on all providers). */
const WHEN_SCHEMA = Type.Union([
	Type.Literal("before-implement"),
	Type.Literal("after-implement"),
	Type.Literal("anytime"),
]);

export const DEFAULT_TASK_TIMEOUT_SECONDS = 600;
export const MAX_TASK_NAME_LENGTH = 64;
export const TASK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const NUDGE_ENTRY_TYPE = "codepi-task:nudge";
const WIDGET_KEY = "codepi-task";
const UPDATE_THROTTLE_MS = 100;
const PREVIEW_LINES = 5;

/** Task definitions as stored in .pi/tasks.json (unknown fields preserved). */
export interface TaskDef {
	command: string | string[];
	cwd?: string;
	when?: TaskWhen;
	timeout?: number;
	readOnly?: boolean;
	description?: string;
	[key: string]: unknown;
}

/** The parsed tasks file: the full root object + a normalized task map. */
export interface TaskStore {
	root: Record<string, unknown>;
	tasks: Record<string, TaskDef>;
}

/** Fields accepted by codepi-task-edit (all optional, merge semantics). */
export interface TaskEditFields {
	newName?: string;
	command?: string | string[];
	cwd?: string;
	when?: TaskWhen;
	timeout?: number;
	readOnly?: boolean;
	description?: string;
}

const TASK_PROMPT_GUIDELINES: string[] = [
	"Use codepi-task-run for build/test/lint/package commands defined in .pi/tasks.json instead of ad-hoc bash — run codepi-task-list to see the available tasks.",
	"Respect task `when` values: run when=before-implement tasks BEFORE making changes, and when=after-implement tasks AFTER finishing an implementation to verify (build, test, lint).",
	"Ask the user for permission with ask_user_question (describing what the task does and pointing to .pi/tasks.json) before creating, editing, or deleting a task — pass confirmed: true only after the user approved.",
];

// ── Pure helpers (unit-tested) ───────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absolute path of the project tasks file for a session cwd. */
export function tasksPathForCwd(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "tasks.json");
}

/**
 * Read the tasks file defensively. Missing file → empty store. Malformed JSON
 * or a wrong top-level shape throws a clear error (reported to the LLM);
 * unknown top-level keys and unknown task fields are preserved for rewrites.
 */
export function readTasksFile(path: string): TaskStore {
	if (!existsSync(path)) {
		return { root: {}, tasks: {} };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		throw new Error(
			`Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const root = isRecord(parsed) ? parsed : {};
	if (root.tasks === undefined) {
		return { root, tasks: {} };
	}
	if (!isRecord(root.tasks)) {
		throw new Error(
			`Failed to parse ${path}: "tasks" must be an object keyed by task name.`,
		);
	}
	const tasks: Record<string, TaskDef> = {};
	for (const [name, def] of Object.entries(root.tasks)) {
		if (!isRecord(def)) {
			throw new Error(
				`Failed to parse ${path}: task "${name}" must be an object.`,
			);
		}
		tasks[name] = def as TaskDef;
	}
	return { root, tasks };
}

/** Atomically write the tasks file (parent dirs created). */
export function writeTasksFile(path: string, root: Record<string, unknown>): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(root, null, 2) + "\n", "utf8");
}

/** Validate a task name. Returns an error string, or null when valid. */
export function validateTaskName(name: unknown): string | null {
	if (typeof name !== "string" || name.trim() === "") {
		return "Task name is required.";
	}
	const n = name.trim();
	if (n.length > MAX_TASK_NAME_LENGTH) {
		return `Task name too long (max ${MAX_TASK_NAME_LENGTH} characters).`;
	}
	if (!TASK_NAME_RE.test(n)) {
		return `Invalid task name "${n}": use only letters, digits, '.', '_' and '-', starting with a letter or digit (no spaces).`;
	}
	return null;
}

/** Normalize a `when` value; anything unknown falls back to "anytime". */
export function normalizeWhen(value: unknown): TaskWhen {
	return typeof value === "string" &&
		(TASK_WHEN_VALUES as readonly string[]).includes(value)
		? (value as TaskWhen)
		: "anytime";
}

/** Parse a timeout (seconds). Invalid provided values are rejected. */
export function parseTimeout(
	value: unknown,
): { ok: true; seconds: number } | { ok: false; error: string } {
	if (value === undefined) {
		return { ok: true, seconds: DEFAULT_TASK_TIMEOUT_SECONDS };
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return { ok: false, error: "timeout must be a positive number of seconds." };
	}
	return { ok: true, seconds: value };
}

/** Effective timeout of a stored task (tolerates malformed stored values). */
export function effectiveTimeout(def: TaskDef): number {
	const r = parseTimeout(def.timeout);
	return "seconds" in r ? r.seconds : DEFAULT_TASK_TIMEOUT_SECONDS;
}

/** readOnly flag of a stored task (only literal true counts). */
export function readReadOnly(value: unknown): boolean {
	return value === true;
}

/** The shell command string for display/list purposes. */
export function commandString(command: unknown): string {
	if (Array.isArray(command)) return command.join(" && ");
	if (typeof command === "string") return command;
	return "";
}

/** Build the stored task definition from validated create fields. */
export function buildTaskDef(
	command: string | string[],
	fields: {
		cwd?: unknown;
		when?: unknown;
		timeout?: unknown;
		readOnly?: unknown;
		description?: unknown;
	},
): TaskDef {
	const def: TaskDef = { command };
	const cwd = typeof fields.cwd === "string" ? fields.cwd.trim() : "";
	if (cwd !== "") def.cwd = cwd;
	const when = normalizeWhen(fields.when);
	if (when !== "anytime") def.when = when;
	const timeout = parseTimeout(fields.timeout);
	if ("seconds" in timeout && timeout.seconds !== DEFAULT_TASK_TIMEOUT_SECONDS) {
		def.timeout = timeout.seconds;
	}
	if (fields.readOnly === true) def.readOnly = true;
	const description =
		typeof fields.description === "string" ? fields.description.trim() : "";
	if (description !== "") def.description = description;
	return def;
}

/**
 * Validate + normalize an edit's provided fields. Throws on invalid values.
 * Returns the normalized fields (keys omitted → unchanged; description ""
 * clears the description).
 */
export function normalizeEditFields(
	fields: {
		newName?: unknown;
		command?: unknown;
		cwd?: unknown;
		when?: unknown;
		timeout?: unknown;
		readOnly?: unknown;
		description?: unknown;
	},
): { ok: true; fields: TaskEditFields } | { ok: false; error: string } {
	const out: TaskEditFields = {};
	if (fields.newName !== undefined) {
		if (typeof fields.newName !== "string") {
			return { ok: false, error: "newName must be a string." };
		}
		const nameError = validateTaskName(fields.newName);
		if (nameError) return { ok: false, error: nameError };
		out.newName = fields.newName.trim();
	}
	if (fields.command !== undefined) {
		const joined = joinCommands(fields.command);
		if ("error" in joined) return { ok: false, error: joined.error };
		out.command = joined.command;
	}
	if (fields.cwd !== undefined) {
		if (typeof fields.cwd !== "string" || fields.cwd.trim() === "") {
			return { ok: false, error: "cwd must be a non-empty path string." };
		}
		out.cwd = fields.cwd.trim();
	}
	if (fields.when !== undefined) {
		if (
			typeof fields.when !== "string" ||
			!(TASK_WHEN_VALUES as readonly string[]).includes(fields.when)
		) {
			return {
				ok: false,
				error: `when must be one of: ${TASK_WHEN_VALUES.join(", ")}.`,
			};
		}
		out.when = fields.when as TaskWhen;
	}
	if (fields.timeout !== undefined) {
		const t = parseTimeout(fields.timeout);
		if ("error" in t) return { ok: false, error: t.error };
		out.timeout = t.seconds;
	}
	if (fields.readOnly !== undefined) {
		if (typeof fields.readOnly !== "boolean") {
			return { ok: false, error: "readOnly must be a boolean." };
		}
		out.readOnly = fields.readOnly;
	}
	if (fields.description !== undefined) {
		if (typeof fields.description !== "string") {
			return { ok: false, error: "description must be a string." };
		}
		out.description = fields.description.trim();
	}
	return { ok: true, fields: out };
}

/** Merge normalized edit fields into a stored task def (preserves unknowns). */
export function applyEditToDef(
	def: TaskDef,
	fields: TaskEditFields,
): TaskDef {
	const next: TaskDef = { ...def };
	if (fields.command !== undefined) next.command = fields.command;
	if (fields.cwd !== undefined) {
		if (fields.cwd === "") delete next.cwd;
		else next.cwd = fields.cwd;
	}
	if (fields.when !== undefined) {
		if (fields.when === "anytime") delete next.when;
		else next.when = fields.when;
	}
	if (fields.timeout !== undefined) {
		if (fields.timeout === DEFAULT_TASK_TIMEOUT_SECONDS) delete next.timeout;
		else next.timeout = fields.timeout;
	}
	if (fields.readOnly !== undefined) {
		if (fields.readOnly === false) delete next.readOnly;
		else next.readOnly = true;
	}
	if (fields.description !== undefined) {
		if (fields.description === "") delete next.description;
		else next.description = fields.description;
	}
	return next;
}

/** Latest agent mode from codepi-modes:mode session entries (default implement). */
export function readAgentMode(branch: readonly unknown[]): "ask" | "plan" | "implement" {
	let mode: "ask" | "plan" | "implement" = "implement";
	for (const entry of branch) {
		if (!isRecord(entry)) continue;
		if (entry.type !== "custom" || entry.customType !== "codepi-modes:mode") {
			continue;
		}
		const data = isRecord(entry.data) ? entry.data : {};
		if (
			data.mode === "ask" ||
			data.mode === "plan" ||
			data.mode === "implement"
		) {
			mode = data.mode;
		}
	}
	return mode;
}

/** One formatted task line: `name — when — command (cwd, timeout, flags) — desc`. */
export function formatTaskEntry(name: string, def: TaskDef): string {
	const when = normalizeWhen(def.when);
	const command = commandString(def.command);
	const bits: string[] = [];
	const cwd = typeof def.cwd === "string" && def.cwd.trim() !== "" ? def.cwd.trim() : ".";
	bits.push(`cwd ${cwd}`);
	bits.push(`timeout ${effectiveTimeout(def)}s`);
	if (readReadOnly(def.readOnly)) bits.push("readOnly");
	const meta = bits.join(", ");
	const description =
		typeof def.description === "string" && def.description.trim() !== ""
			? def.description.trim()
			: undefined;
	return `${name} — ${when} — ${command}${meta ? ` (${meta})` : ""}${
		description ? ` — ${description}` : ""
	}`;
}

/** Format the whole task list (sorted by name, optional when/name filters). */
export function formatTaskList(
	store: TaskStore,
	options: { when?: TaskWhen; name?: string } = {},
): string {
	if (options.name !== undefined) {
		const def = store.tasks[options.name];
		return def
			? formatTaskEntry(options.name, def)
			: `Task "${options.name}" not found in .pi/tasks.json.`;
	}
	const names = Object.keys(store.tasks)
		.filter(
			(name) =>
				options.when === undefined ||
				normalizeWhen(store.tasks[name].when) === options.when,
		)
		.sort();
	if (names.length === 0) {
		return "No tasks defined in .pi/tasks.json.";
	}
	return names.map((name) => formatTaskEntry(name, store.tasks[name])).join("\n");
}

/**
 * The ask_user_question payload the agent should present before mutating
 * .pi/tasks.json: question text, body describing what the task does, options.
 */
export function buildPermissionQuestion(
	action: "create" | "edit" | "delete",
	name: string,
	summary: string,
): { question: string; body: string; options: [string, string] } {
	if (action === "delete") {
		return {
			question: `Delete project task "${name}" from .pi/tasks.json?`,
			body: `What it does: ${summary}. See .pi/tasks.json for the full definition.`,
			options: ["Yes, delete it", "No, keep it"],
		};
	}
	const actionLabel = action === "create" ? "Create" : "Edit";
	const confirmLabel = action === "create" ? "Yes, create it" : "Yes, apply changes";
	const cancelLabel = action === "create" ? "No, cancel" : "No, keep as-is";
	return {
		question: `${actionLabel} project task "${name}" in .pi/tasks.json?`,
		body: `What it does: ${summary}. See .pi/tasks.json for the full definition.`,
		options: [confirmLabel, cancelLabel],
	};
}

/** A one-line summary of a task definition for list/permission display. */
export function summarizeTask(name: string, def: TaskDef): string {
	const when = normalizeWhen(def.when);
	const bits = [`runs "${commandString(def.command)}"`];
	if (typeof def.cwd === "string" && def.cwd.trim() !== "") {
		bits.push(`cwd ${def.cwd.trim()}`);
	}
	if (when !== "anytime") bits.push(`when ${when}`);
	const t = effectiveTimeout(def);
	if (t !== DEFAULT_TASK_TIMEOUT_SECONDS) bits.push(`timeout ${t}s`);
	if (readReadOnly(def.readOnly)) bits.push("readOnly");
	const description =
		typeof def.description === "string" && def.description.trim() !== ""
			? ` — ${def.description.trim()}`
			: "";
	return `${bits.join(", ")}${description}`;
}

/** The "User permission required" instructions returned by mutating tools. */
export function buildPermissionInstructions(
	action: "create" | "edit" | "delete",
	name: string,
	summary: string,
): string {
	const { question, body, options } = buildPermissionQuestion(
		action,
		name,
		summary,
	);
	const retryHint =
		action === "create"
			? `retry codepi-task-create with the SAME arguments plus confirmed: true`
			: action === "edit"
				? `retry codepi-task-edit with the SAME arguments plus confirmed: true`
				: `retry codepi-task-delete with confirmed: true`;
	return [
		`User permission required to ${action} task "${name}". Nothing was written yet.`,
		``,
		`Ask the user with the ask_user_question tool:`,
		`  Question: ${question}`,
		`  Details: ${body}`,
		`  Options: ${options.join(" / ")}`,
		``,
		`If the user approves, ${retryHint}. If they decline, do not ${action} the task and report their decision.`,
	].join("\n");
}

/** The system-prompt "Project tasks" section; undefined when no tasks exist. */
export function buildTasksPromptSection(store: TaskStore): string | undefined {
	const names = Object.keys(store.tasks).sort();
	if (names.length === 0) return undefined;
	const lines = names.map((name) => {
		const def = store.tasks[name];
		const flags: string[] = [normalizeWhen(def.when)];
		if (readReadOnly(def.readOnly)) flags.push("readOnly");
		const description =
			typeof def.description === "string" && def.description.trim() !== ""
				? ` — ${def.description.trim()}`
				: "";
		return `- ${name} (${flags.join(", ")}): ${commandString(def.command)}${description}`;
	});
	return [
		"## Project tasks (.pi/tasks.json)",
		"Reusable commands the user expects instead of ad-hoc bash for build/test/lint/package steps:",
		...lines,
		"",
		"Rules:",
		"- Run when=before-implement tasks BEFORE making changes (e.g. establish a test baseline).",
		"- Run when=after-implement tasks AFTER finishing implementation to verify (build, test, lint).",
		"- Prefer codepi-task-run over raw bash for these commands. Run codepi-task-list to see them all.",
		"- Tasks marked readOnly may run in Ask (read-only) mode; others require Implement mode.",
		"- Ask the user via ask_user_question before creating/editing/deleting a task.",
	].join("\n");
}

/** Whether to send the after-implement nudge after a turn. */
export function shouldNudge(input: {
	mutated: boolean;
	ranTask: boolean;
	hasAfterImplement: boolean;
	enabled: boolean;
}): boolean {
	return (
		input.enabled && input.mutated && !input.ranTask && input.hasAfterImplement
	);
}

/** Whether a task store defines any after-implement task. */
export function hasAfterImplementTasks(store: TaskStore): boolean {
	return Object.values(store.tasks).some(
		(def) => normalizeWhen(def.when) === "after-implement",
	);
}

/** Read codepi.tasks.* reminder settings defensively (defaults on). */
export function readTaskReminderSettings(settings: unknown): {
	injectPrompt: boolean;
	remindAfterImplement: boolean;
} {
	const codepi = isRecord(settings) && isRecord(settings.codepi) ? settings.codepi : undefined;
	const tasks = codepi !== undefined && isRecord(codepi.tasks) ? codepi.tasks : undefined;
	return {
		injectPrompt:
			tasks !== undefined && typeof tasks.injectPrompt === "boolean"
				? tasks.injectPrompt
				: true,
		remindAfterImplement:
			tasks !== undefined && typeof tasks.remindAfterImplement === "boolean"
				? tasks.remindAfterImplement
				: true,
	};
}

/** Read reminder settings from disk (<agentDir>/settings.json). */
export function readReminderSettingsFromDisk(): {
	injectPrompt: boolean;
	remindAfterImplement: boolean;
} {
	try {
		const raw = readFileSync(join(getAgentDir(), "settings.json"), "utf8");
		return readTaskReminderSettings(JSON.parse(raw));
	} catch {
		return { injectPrompt: true, remindAfterImplement: true };
	}
}

/** Run-gate decision (pure): returns an error string, or undefined when allowed. */
export function runGateError(input: {
	bashMode: string;
	agentMode: string;
	taskReadOnly: boolean;
	name: string;
}): string | undefined {
	if (input.bashMode === "disabled") {
		return `Task "${input.name}" was not run: the bash tool is disabled. Re-enable it with /codepi-bash-ask or /codepi-bash-allow.`;
	}
	if (input.agentMode === "ask" && !input.taskReadOnly) {
		return `Task "${input.name}" is not marked readOnly, so it may not run in Ask (read-only) mode. Switch to Implement mode (/codepi-implement), or mark the task "readOnly": true in .pi/tasks.json if it is safe to run read-only.`;
	}
	return undefined;
}

// ── Task store mutations (withFileMutationQueue) ─────────────

function branchOf(ctx: ExtensionContext): readonly unknown[] {
	try {
		return ctx.sessionManager?.getBranch?.() ?? [];
	} catch {
		return [];
	}
}

/** Gate check shared by the mutating tools: Ask mode blocks task mutations. */
function assertMutationAllowed(ctx: ExtensionContext): void {
	if (readAgentMode(branchOf(ctx)) === "ask") {
		throw new Error(
			"Ask (read-only) mode blocks task mutations — .pi/tasks.json is a file edit. Switch to Implement mode with /codepi-implement.",
		);
	}
}

/** Create or replace the tasks file through the per-file mutation queue. */
function writeTasksQueued(
	tasksPath: string,
	root: Record<string, unknown>,
): Promise<void> {
	return withFileMutationQueue(tasksPath, async () => {
		writeTasksFile(tasksPath, root);
	});
}

// ── Run tool execution (ported from codepi-bash) ─────────────

interface RunOutput {
	text: string;
	details?: { truncation?: TruncationResult; fullOutputPath?: string };
}

/** Minimal shape of BashOutputAccumulator.snapshot() used by formatOutput. */
interface OutputSnapshotLike {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Execute a task command through the shared VS Code terminal backend with the
 * same streaming/truncation semantics as the bash tool. Throws on non-zero
 * exit with the captured output appended.
 */
async function runTaskCommand(
	command: string,
	cwd: string,
	timeoutSecs: number,
	signal: AbortSignal | undefined,
	onUpdate: ((update: { content: Array<{ type: "text"; text: string }>; details?: unknown }) => void) | undefined,
): Promise<RunOutput> {
	const ops = createVscodeBashOperations();
	const output = new BashOutputAccumulator({ tempFilePrefix: "codepi-task" });
	let acceptingOutput = true;
	let updateTimer: ReturnType<typeof setTimeout> | undefined;
	let updateDirty = false;
	let lastUpdateAt = 0;

	const emitOutputUpdate = () => {
		if (!onUpdate || !updateDirty) return;
		updateDirty = false;
		lastUpdateAt = Date.now();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		const cleaned = cleanTerminalOutput(snapshot.content || "", command);
		onUpdate({
			content: [{ type: "text", text: cleaned }],
			details: snapshot.truncation.truncated
				? {
						truncation: snapshot.truncation,
						fullOutputPath: snapshot.fullOutputPath,
					}
				: undefined,
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
		const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
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

	if (onUpdate) onUpdate({ content: [] });

	const handleData = (data: Buffer) => {
		if (!acceptingOutput) return;
		output.append(data);
		scheduleOutputUpdate();
	};

	const finishOutput = async (): Promise<{
		snapshot: ReturnType<BashOutputAccumulator["snapshot"]>;
	}> => {
		acceptingOutput = false;
		output.finish();
		clearUpdateTimer();
		emitOutputUpdate();
		return { snapshot: output.snapshot({ persistIfTruncated: true }) };
	};

	const formatOutput = (snapshot: OutputSnapshotLike) => {
		const truncation = snapshot.truncation as TruncationResult;
		const cleaned = cleanTerminalOutput(snapshot.content || "", command);
		let text = cleaned || "(no output)";
		let details:
			| { truncation?: TruncationResult; fullOutputPath?: string }
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
					Buffer.byteLength(cleaned.split("\n").pop() ?? "", "utf8"),
				);
				text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
			} else if (truncation.truncatedBy === "lines") {
				text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
			} else {
				text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(50000)} limit). Full output: ${snapshot.fullOutputPath}]`;
			}
		}
		return { text, details };
	};

	const appendStatus = (text: string, status: string) =>
		`${text ? `${text}\n\n` : ""}${status}`;

	let exitCode: number | null;
	try {
		const result = await ops.exec(command, cwd, {
			onData: handleData,
			signal,
			timeout: timeoutSecs,
		});
		exitCode = result.exitCode;
	} catch (err) {
		const { snapshot } = await finishOutput();
		const { text } = formatOutput(snapshot);
		if (err instanceof Error && err.message === "aborted") {
			throw new Error(appendStatus(text, "Task aborted"));
		}
		if (err instanceof Error && err.message.startsWith("timeout:")) {
			const secs = err.message.split(":")[1];
			throw new Error(appendStatus(text, `Task timed out after ${secs} seconds`));
		}
		throw err;
	}

	const { snapshot } = await finishOutput();
	const { text, details } = formatOutput(snapshot);
	if (exitCode !== 0) {
		if (exitCode === null) {
			throw new Error(
				appendStatus(
					text,
					"Could not determine the command's exit code (the sentinel did not report one).",
				),
			);
		}
		throw new Error(appendStatus(text, `Task exited with code ${exitCode}`));
	}
	return { text, details };
}

// ── Renderers (simplified bash-style) ────────────────────────

type TaskRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: ReturnType<typeof setInterval> | undefined;
};

type TaskResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class TaskResultComponent extends Container {
	state: TaskResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatRunCall(
	args: { name?: unknown; cwd?: unknown; timeout?: unknown } | undefined,
	theme: Theme,
): string {
	const name = typeof args?.name === "string" ? args.name : "?";
	const timeout =
		typeof args?.timeout === "number" ? (args.timeout as number) : undefined;
	const timeoutSuffix = timeout
		? theme.fg("muted", ` (timeout ${timeout}s)`)
		: "";
	return (
		theme.fg("toolTitle", theme.bold(`$ ${name}`)) +
		timeoutSuffix
	);
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

function rebuildTaskResult(
	component: TaskResultComponent,
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
							PREVIEW_LINES,
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
		if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
		if (truncation?.truncated) {
			warnings.push(
				`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? 50000)} limit)`,
			);
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

// ── Tool definitions ─────────────────────────────────────────

function runToolDefinition(): ToolDefinition<any, unknown, TaskRenderState> {
	return {
		name: "codepi-task-run",
		label: "Run Task",
		description:
			"Run a predefined project task from .pi/tasks.json (build, test, lint, package, …). Executes through the same VS Code terminal as the bash tool, with the same output truncation (last 2000 lines / 50KB, full output spilled to a temp file). Prefer this over raw bash for commands defined as tasks. While the bash tool is in 'disabled' mode no task can run. Tasks marked readOnly in .pi/tasks.json may run in Ask (read-only) mode; other tasks require Implement mode. Non-zero exit codes are reported as errors.",
		promptSnippet: "Run a predefined project task (build/test/lint) from .pi/tasks.json",
		promptGuidelines: TASK_PROMPT_GUIDELINES,
		parameters: Type.Object({
			name: Type.String({
				description:
					"Name of the task to run (see codepi-task-list for available tasks).",
			}),
			cwd: Type.Optional(
				Type.String({
					description:
						"Optional working-directory override (absolute, or relative to the project root). Default: the task's cwd.",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description:
						"Optional timeout override in seconds. Default: the task's timeout (600s when unset).",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { name: rawName, cwd: rawCwd, timeout: rawTimeout } = (params ??
				{}) as {
				name?: unknown;
				cwd?: unknown;
				timeout?: unknown;
			};
			if (typeof rawName !== "string" || rawName.trim() === "") {
				throw new Error("Task name is required.");
			}
			const name = rawName.trim();

			const tasksPath = tasksPathForCwd(ctx?.cwd ?? process.cwd());
			const store = readTasksFile(tasksPath);
			const task = store.tasks[name];
			if (!task) {
				throw new Error(
					`Task "${name}" not found in ${tasksPath}. Run codepi-task-list to see the available tasks.`,
				);
			}

			// Gate 1: bash-disabled → no tasks run (warning).
			const bashMode = readModeFromBranch(branchOf(ctx));
			const gateError = runGateError({
				bashMode,
				agentMode: readAgentMode(branchOf(ctx)),
				taskReadOnly: readReadOnly(task.readOnly),
				name,
			});
			if (gateError !== undefined) {
				if (bashMode === "disabled") {
					ctx?.ui?.notify?.(
						`Task "${name}" was NOT run — the bash tool is disabled and codepi-task runs through it. Re-enable with /codepi-bash-ask or /codepi-bash-allow.`,
						"warning",
					);
				}
				throw new Error(gateError);
			}

			const joined = joinCommands(task.command);
			if ("error" in joined) {
				throw new Error(
					`Task "${name}" has an invalid command: ${joined.error}`,
				);
			}

			const taskCwd = typeof task.cwd === "string" ? task.cwd : undefined;
			const resolved = resolveCwd(rawCwd ?? taskCwd, ctx?.cwd ?? process.cwd());
			if ("error" in resolved) throw new Error(resolved.error);

			const timeout = parseTimeout(rawTimeout);
			if ("error" in timeout) throw new Error(timeout.error);
			const timeoutSecs =
				rawTimeout === undefined ? effectiveTimeout(task) : timeout.seconds;

			const { text, details } = await runTaskCommand(
				joined.command,
				resolved.cwd,
				timeoutSecs,
				signal,
				onUpdate as any,
			);
			return {
				content: [{ type: "text", text }],
				details: details ?? {},
			};
		},
		renderCall(args, theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatRunCall(args as any, theme));
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
				(context.lastComponent as TaskResultComponent | undefined) ??
				new TaskResultComponent();
			rebuildTaskResult(
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

async function createTaskWithCwd(
	tasksPath: string,
	name: string,
	command: string | string[],
	fields: Record<string, unknown>,
	confirmed: boolean,
	ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
	const store = readTasksFile(tasksPath);
	if (store.tasks[name]) {
		throw new Error(
			`Task "${name}" already exists in .pi/tasks.json. Use codepi-task-edit to change it.`,
		);
	}
	const def = buildTaskDef(command, fields);
	const summary = summarizeTask(name, def);

	if (!confirmed) {
		assertMutationAllowed(ctx);
		return {
			content: [
				{
					type: "text",
					text: buildPermissionInstructions("create", name, summary),
				},
			],
			details: {
				needsConfirmation: true,
				task: name,
				action: "create",
				summary,
			},
		};
	}

	await writeTasksQueued(tasksPath, {
		...store.root,
		tasks: { ...store.tasks, [name]: def },
	});
	const when = normalizeWhen(def.when);
	return {
		content: [
			{
				type: "text",
				text: `Created task "${name}"${when !== "anytime" ? ` (${when})` : ""}: ${commandString(def.command)} in ${tasksPath}`,
			},
		],
		details: { task: name, action: "create", summary },
	};
}

// ── Extension factory ────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Per-prompt nudge state.
	let mutated = false;
	let ranTask = false;

	// ── Tools ──
	pi.registerTool(runToolDefinition());

	pi.registerTool({
		name: "codepi-task-create",
		label: "Create Task",
		description:
			"Create a reusable project task in .pi/tasks.json. NEVER call without first asking the user for permission via ask_user_question (describe what the task does, refer them to .pi/tasks.json), then retry with confirmed: true only after they approve. Errors if the name already exists.",
		promptSnippet: "Create a reusable project task in .pi/tasks.json",
		promptGuidelines: TASK_PROMPT_GUIDELINES,
		parameters: Type.Object({
			name: Type.String({
				description:
					"Unique task name (letters, digits, '.', '_', '-'; no spaces; e.g. 'build').",
			}),
			command: Type.Union(
				[
					Type.String({ description: "The shell command to run." }),
					Type.Array(
						Type.String({
							description:
								"Multiple commands, joined with ' && ' and run sequentially.",
						}),
					),
				],
				{ description: "Command(s) the task runs" },
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory for the command, relative to the project root. Default: the project root.",
				}),
			),
			when: Type.Optional(WHEN_SCHEMA),
			timeout: Type.Optional(
				Type.Number({
					description: `Timeout in seconds (default ${DEFAULT_TASK_TIMEOUT_SECONDS}).`,
				}),
			),
			readOnly: Type.Optional(
				Type.Boolean({
					description:
						"Mark the task read-only (it does not modify project files, e.g. test/lint) so it may run in Ask (read-only) mode. Default: false.",
				}),
			),
			description: Type.Optional(
				Type.String({
					description:
						"Short human-readable description of what the task does.",
				}),
			),
			confirmed: Type.Optional(
				Type.Boolean({
					description:
						"Set to true ONLY after the user approved via ask_user_question. Without it the tool validates and asks, but does not write.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = (params ?? {}) as Record<string, unknown>;
			const nameError = validateTaskName(p.name);
			if (nameError) throw new Error(nameError);
			const name = String(p.name).trim();
			const joined = joinCommands(p.command);
			if ("error" in joined) throw new Error(joined.error);
			if (p.timeout !== undefined) {
				const t = parseTimeout(p.timeout);
				if ("error" in t) throw new Error(t.error);
			}
			if (p.readOnly !== undefined && typeof p.readOnly !== "boolean") {
				throw new Error("readOnly must be a boolean.");
			}
			const tasksPath = tasksPathForCwd(ctx?.cwd ?? process.cwd());
			return createTaskWithCwd(
				tasksPath,
				name,
				joined.command,
				p,
				p.confirmed === true,
				ctx,
			);
		},
	});

	pi.registerTool({
		name: "codepi-task-edit",
		label: "Edit Task",
		description:
			"Edit a task in .pi/tasks.json (rename with newName, or update command/cwd/when/timeout/readOnly/description). Only provided fields change; pass description: \"\" to clear it. NEVER call without first asking the user for permission via ask_user_question (state what will change, refer them to .pi/tasks.json), then retry with confirmed: true only after they approve.",
		promptSnippet: "Edit a task in .pi/tasks.json",
		promptGuidelines: TASK_PROMPT_GUIDELINES,
		parameters: Type.Object({
			name: Type.String({ description: "Name of the task to edit." }),
			newName: Type.Optional(
				Type.String({ description: "Optional new name (rename)." }),
			),
			command: Type.Optional(
				Type.Union(
					[
						Type.String({ description: "The shell command to run." }),
						Type.Array(
							Type.String({
								description:
									"Multiple commands, joined with ' && ' and run sequentially.",
							}),
						),
					],
					{ description: "Command(s) the task runs" },
				),
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory, relative to the project root. Pass \"\" to reset to the project root.",
				}),
			),
			when: Type.Optional(WHEN_SCHEMA),
			timeout: Type.Optional(
				Type.Number({
					description: `Timeout in seconds (default ${DEFAULT_TASK_TIMEOUT_SECONDS}).`,
				}),
			),
			readOnly: Type.Optional(
				Type.Boolean({
					description:
						"Mark the task read-only so it may run in Ask (read-only) mode.",
				}),
			),
			description: Type.Optional(
				Type.String({
					description:
						"Short human-readable description (pass \"\" to clear).",
				}),
			),
			confirmed: Type.Optional(
				Type.Boolean({
					description:
						"Set to true ONLY after the user approved via ask_user_question. Without it the tool validates and asks, but does not write.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = (params ?? {}) as Record<string, unknown>;
			const nameError = validateTaskName(p.name);
			if (nameError) throw new Error(nameError);
			const name = String(p.name).trim();
			const normalized = normalizeEditFields({
				newName: p.newName,
				command: p.command,
				cwd: p.cwd,
				when: p.when,
				timeout: p.timeout,
				readOnly: p.readOnly,
				description: p.description,
			});
			if ("error" in normalized) throw new Error(normalized.error);
			const fields = normalized.fields;

			const tasksPath = tasksPathForCwd(ctx?.cwd ?? process.cwd());
			const store = readTasksFile(tasksPath);
			const existing = store.tasks[name];
			if (!existing) {
				throw new Error(
					`Task "${name}" not found in ${tasksPath}. Run codepi-task-list to see the available tasks.`,
				);
			}
			const targetName = fields.newName ?? name;
			if (fields.newName !== undefined && store.tasks[targetName] && targetName !== name) {
				throw new Error(
					`Task "${targetName}" already exists — cannot rename "${name}" to it.`,
				);
			}

			const nextDef = applyEditToDef(existing, fields);
			const summary =
				fields.newName !== undefined
					? `renamed "${name}" to "${fields.newName}"${describeChange(fields, existing)}`
					: describeChange(fields, existing);

			if (p.confirmed !== true) {
				assertMutationAllowed(ctx);
				return {
					content: [
						{
							type: "text",
							text: buildPermissionInstructions(
								"edit",
								name,
								summary || summarizeTask(name, existing),
							),
						},
					],
					details: {
						needsConfirmation: true,
						task: name,
						action: "edit",
						summary,
					},
				};
			}

			const tasks = { ...store.tasks };
			delete tasks[name];
			if (fields.newName !== undefined) tasks[fields.newName] = nextDef;
			else tasks[name] = nextDef;
			await writeTasksQueued(tasksPath, { ...store.root, tasks });
			return {
				content: [
					{
						type: "text",
						text: `Edited task "${name}"${fields.newName ? ` → "${fields.newName}"` : ""} in ${tasksPath}.`,
					},
				],
				details: { task: targetName, action: "edit", summary },
			};
		},
	});

	pi.registerTool({
		name: "codepi-task-delete",
		label: "Delete Task",
		description:
			"Delete a task from .pi/tasks.json. NEVER call without first asking the user for permission via ask_user_question (state the task will be removed, refer them to .pi/tasks.json), then retry with confirmed: true only after they approve.",
		promptSnippet: "Delete a task from .pi/tasks.json",
		promptGuidelines: TASK_PROMPT_GUIDELINES,
		parameters: Type.Object({
			name: Type.String({ description: "Name of the task to delete." }),
			confirmed: Type.Optional(
				Type.Boolean({
					description:
						"Set to true ONLY after the user approved via ask_user_question. Without it the tool validates and asks, but does not write.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = (params ?? {}) as Record<string, unknown>;
			const nameError = validateTaskName(p.name);
			if (nameError) throw new Error(nameError);
			const name = String(p.name).trim();

			const tasksPath = tasksPathForCwd(ctx?.cwd ?? process.cwd());
			const store = readTasksFile(tasksPath);
			const existing = store.tasks[name];
			if (!existing) {
				throw new Error(
					`Task "${name}" not found in ${tasksPath}. Run codepi-task-list to see the available tasks.`,
				);
			}

			if (p.confirmed !== true) {
				assertMutationAllowed(ctx);
				const summary = summarizeTask(name, existing);
				return {
					content: [
						{
							type: "text",
							text: buildPermissionInstructions("delete", name, summary),
						},
					],
					details: {
						needsConfirmation: true,
						task: name,
						action: "delete",
						summary,
					},
				};
			}

			const tasks = { ...store.tasks };
			delete tasks[name];
			await writeTasksQueued(tasksPath, { ...store.root, tasks });
			return {
				content: [
					{
						type: "text",
						text: `Deleted task "${name}" from ${tasksPath}.`,
					},
				],
				details: { task: name, action: "delete" },
			};
		},
	});

	pi.registerTool({
		name: "codepi-task-list",
		label: "List Tasks",
		description:
			"List the reusable project tasks defined in .pi/tasks.json (name, when, command, cwd, timeout, readOnly, description). Optional filters: a specific task name, or a when value (before-implement / after-implement / anytime). Read-only — available in Ask mode.",
		promptSnippet: "List project tasks from .pi/tasks.json",
		promptGuidelines: TASK_PROMPT_GUIDELINES,
		parameters: Type.Object({
			when: Type.Optional(WHEN_SCHEMA),
			name: Type.Optional(
				Type.String({
					description:
						"Only show this single task (errors reported inline if missing).",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = (params ?? {}) as Record<string, unknown>;
			const tasksPath = tasksPathForCwd(ctx?.cwd ?? process.cwd());
			const store = readTasksFile(tasksPath);
			const body = formatTaskList(store, {
				when: p.when as TaskWhen | undefined,
				name: typeof p.name === "string" ? p.name.trim() : undefined,
			});
			const header = `Tasks defined in ${tasksPath}:`;
			return {
				content: [
					{
						type: "text",
						text: body === "No tasks defined in .pi/tasks.json." ? body : `${header}\n${body}`,
					},
				],
				details: { count: Object.keys(store.tasks).length, path: tasksPath },
			};
		},
	});

	// ── Commands ──

	async function taskNames(ctx: ExtensionCommandContext): Promise<string[]> {
		try {
			const store = readTasksFile(tasksPathForCwd(ctx.cwd));
			return Object.keys(store.tasks).sort();
		} catch {
			return [];
		}
	}

	pi.registerCommand("codepi-task-list", {
		description: "List project tasks from .pi/tasks.json",
		handler: async (args, ctx) => {
			const store = readTasksFile(tasksPathForCwd(ctx.cwd));
			let body: string;
			if (args && args.trim() !== "") {
				const parts = args.trim().split(/\s+/);
				if (parts.length > 1) {
					ctx.ui.notify("Usage: /codepi-task-list [when|name]", "warning");
					return;
				}
				const filter = parts[0];
				body = formatTaskList(store, {
					when: normalizeWhen(filter),
					name: (TASK_WHEN_VALUES as readonly string[]).includes(filter)
						? undefined
						: filter,
				});
			} else {
				body = formatTaskList(store);
			}
			ctx.ui.notify(body, "info");
		},
	});

	pi.registerCommand("codepi-task-create", {
		description: "Create a project task in .pi/tasks.json",
		handler: async (_args, ctx) => {
			const name = await ctx.ui.input("Task name (e.g. build):", "build");
			if (name === undefined || name.trim() === "") {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}
			const nameError = validateTaskName(name);
			if (nameError) {
				ctx.ui.notify(nameError, "error");
				return;
			}
			const command = await ctx.ui.input(
				"Command(s) to run (e.g. npm run build):",
				"",
			);
			if (command === undefined || command.trim() === "") {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}
			const cwd =
				(await ctx.ui.input("Working directory (relative to project root, default '.'):", ".")) ??
				".";
			const when =
				(await ctx.ui.select("When should the agent run this task?", [
					"anytime",
					"before-implement",
					"after-implement",
				])) ?? "anytime";
			const readOnly =
				(await ctx.ui.confirm(
					"Read-only task?",
					"Read-only tasks (test/lint/typecheck — no file modifications) may run in Ask (read-only) mode.",
				)) ?? false;
			const description =
				(await ctx.ui.input(
					"Description (optional, Enter to skip):",
					"",
				)) ?? "";

			const tasksPath = tasksPathForCwd(ctx.cwd);
			const store = readTasksFile(tasksPath);
			if (store.tasks[name.trim()]) {
				ctx.ui.notify(`Task "${name.trim()}" already exists.`, "error");
				return;
			}
			const def = buildTaskDef(command.trim(), {
				cwd,
				when,
				readOnly,
				description,
			});
			await writeTasksQueued(tasksPath, {
				...store.root,
				tasks: { ...store.tasks, [name.trim()]: def },
			});
			ctx.ui.notify(
				`Created task "${name.trim()}": ${commandString(def.command)}`,
				"info",
			);
		},
	});

	pi.registerCommand("codepi-task-edit", {
		description: "Edit a project task in .pi/tasks.json",
		getArgumentCompletions: async (prefix: string) => {
			const names = await taskNames({ cwd: process.cwd() } as ExtensionCommandContext);
			return names
				.filter((n) => n.startsWith(prefix))
				.map((n) => ({ value: n, label: n }));
		},
		handler: async (args, ctx) => {
			const names = await taskNames(ctx);
			if (names.length === 0) {
				ctx.ui.notify("No tasks defined in .pi/tasks.json.", "info");
				return;
			}
			let name = args?.trim() ?? "";
			if (name === "" && ctx.hasUI) {
				name = (await ctx.ui.select("Edit which task?", names)) ?? "";
			}
			if (name === "") {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}
			const tasksPath = tasksPathForCwd(ctx.cwd);
			const store = readTasksFile(tasksPath);
			const existing = store.tasks[name];
			if (!existing) {
				ctx.ui.notify(`Task "${name}" not found.`, "error");
				return;
			}

			const command = await ctx.ui.input(
				`Command (was: ${commandString(existing.command)}):`,
				commandString(existing.command),
			);
			const when =
				(await ctx.ui.select(
					`When (was: ${normalizeWhen(existing.when)})?`,
					["keep", "anytime", "before-implement", "after-implement"],
				)) ?? "keep";
			const readOnly =
				(await ctx.ui.confirm(
					"Read-only task?",
					`Currently: ${readReadOnly(existing.readOnly) ? "readOnly" : "not readOnly"}.`,
				)) ?? readReadOnly(existing.readOnly);

			const fields: TaskEditFields = {
				when: when === "keep" ? undefined : (when as TaskWhen),
				readOnly,
			};
			if (command !== undefined && command.trim() !== "" && command !== commandString(existing.command)) {
				const joined = joinCommands(command.trim());
				if ("error" in joined) {
					ctx.ui.notify(joined.error, "error");
					return;
				}
				fields.command = joined.command;
			}
			const normalized = normalizeEditFields(fields);
			if ("error" in normalized) {
				ctx.ui.notify(normalized.error, "error");
				return;
			}
			const nextDef = applyEditToDef(existing, normalized.fields);
			const tasks = { ...store.tasks, [name]: nextDef };
			await writeTasksQueued(tasksPath, { ...store.root, tasks });
			ctx.ui.notify(`Edited task "${name}".`, "info");
		},
	});

	pi.registerCommand("codepi-task-delete", {
		description: "Delete a project task from .pi/tasks.json",
		getArgumentCompletions: async (prefix: string) => {
			const names = await taskNames({ cwd: process.cwd() } as ExtensionCommandContext);
			return names
				.filter((n) => n.startsWith(prefix))
				.map((n) => ({ value: n, label: n }));
		},
		handler: async (args, ctx) => {
			const names = await taskNames(ctx);
			if (names.length === 0) {
				ctx.ui.notify("No tasks defined in .pi/tasks.json.", "info");
				return;
			}
			let name = args?.trim() ?? "";
			if (name === "" && ctx.hasUI) {
				name = (await ctx.ui.select("Delete which task?", names)) ?? "";
			}
			if (name === "") {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}
			const tasksPath = tasksPathForCwd(ctx.cwd);
			const store = readTasksFile(tasksPath);
			if (!store.tasks[name]) {
				ctx.ui.notify(`Task "${name}" not found.`, "error");
				return;
			}
			const ok = await ctx.ui.confirm(
				`Delete task "${name}"?`,
				"This removes it from .pi/tasks.json.",
			);
			if (!ok) {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}
			const tasks = { ...store.tasks };
			delete tasks[name];
			await writeTasksQueued(tasksPath, { ...store.root, tasks });
			ctx.ui.notify(`Deleted task "${name}".`, "info");
		},
	});

	pi.registerCommand("codepi-task-run", {
		description: "Run a project task from .pi/tasks.json",
		getArgumentCompletions: async (prefix: string) => {
			const names = await taskNames({ cwd: process.cwd() } as ExtensionCommandContext);
			return names
				.filter((n) => n.startsWith(prefix))
				.map((n) => ({ value: n, label: n }));
		},
		handler: async (args, ctx) => {
			const names = await taskNames(ctx);
			if (names.length === 0) {
				ctx.ui.notify("No tasks defined in .pi/tasks.json.", "info");
				return;
			}
			let name = args?.trim() ?? "";
			if (name === "" && ctx.hasUI) {
				name = (await ctx.ui.select("Run which task?", names)) ?? "";
			}
			if (name === "") {
				ctx.ui.notify("Cancelled.", "info");
				return;
			}
			const tasksPath = tasksPathForCwd(ctx.cwd);
			const store = readTasksFile(tasksPath);
			const task = store.tasks[name];
			if (!task) {
				ctx.ui.notify(`Task "${name}" not found.`, "error");
				return;
			}
			const joined = joinCommands(task.command);
			if ("error" in joined) {
				ctx.ui.notify(`Task "${name}" has an invalid command: ${joined.error}`, "error");
				return;
			}
			const resolved = resolveCwd(
				typeof task.cwd === "string" ? task.cwd : undefined,
				ctx.cwd,
			);
			if ("error" in resolved) {
				ctx.ui.notify(resolved.error, "error");
				return;
			}
			const timeoutSecs = effectiveTimeout(task);

			ctx.ui.notify(`Running task "${name}": ${joined.command}`, "info");
			const tail: string[] = [];
			try {
				const { text } = await runTaskCommand(
					joined.command,
					resolved.cwd,
					timeoutSecs,
					undefined,
					(update) => {
						const chunk = update.content
							.map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
							.join("");
						if (chunk === "") return;
						const lines = chunk.split("\n");
						tail.push(...lines);
						if (tail.length > 20) tail.splice(0, tail.length - 20);
						ctx.ui.setWidget(WIDGET_KEY, [...tail]);
					},
				);
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.notify(`Task "${name}" passed:\n${text}`, "info");
			} catch (err) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Task "${name}" failed:\n${msg}`, "error");
			}
		},
	});

	// ── Reminder: system-prompt section ──

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
		if (!readReminderSettingsFromDisk().injectPrompt) return undefined;
		try {
			const store = readTasksFile(tasksPathForCwd(ctx.cwd));
			const section = buildTasksPromptSection(store);
			if (!section) return undefined;
			return { systemPrompt: event.systemPrompt + "\n\n" + section };
		} catch {
			return undefined; // malformed tasks file — don't break the turn
		}
	});

	// ── Reminder: after-implement nudge ──

	pi.on("agent_start", async (_event: AgentStartEvent) => {
		mutated = false;
		ranTask = false;
	});

	pi.on("tool_result", async (event: { toolName?: string }) => {
		if (event.toolName === "edit" || event.toolName === "write") {
			mutated = true;
		}
		if (event.toolName === "codepi-task-run") {
			ranTask = true;
		}
	});

	pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
		const settings = readReminderSettingsFromDisk();
		let store: TaskStore;
		try {
			store = readTasksFile(tasksPathForCwd(ctx.cwd));
		} catch {
			return;
		}
		if (
			!shouldNudge({
				mutated,
				ranTask,
				hasAfterImplement: hasAfterImplementTasks(store),
				enabled: settings.remindAfterImplement,
			})
		) {
			return;
		}
		const names = Object.keys(store.tasks)
			.filter((n) => normalizeWhen(store.tasks[n].when) === "after-implement")
			.sort();
		try {
			pi.sendMessage(
				{
					customType: NUDGE_ENTRY_TYPE,
					content: `You modified files. The project defines after-implement tasks in .pi/tasks.json — verify your changes by running them with codepi-task-run: ${names.join(", ")}. Skip only if the user asked you not to.`,
					display: false,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			/* nudge is best-effort */
		}
	});
}

/** Human-readable summary of an edit's changes (for the permission question). */
function describeChange(
	fields: TaskEditFields,
	existing: TaskDef,
): string {
	const parts: string[] = [];
	if (fields.command !== undefined) {
		parts.push(
			`command → "${commandString(fields.command)}" (was "${commandString(existing.command)}")`,
		);
	}
	if (fields.cwd !== undefined) {
		const was = typeof existing.cwd === "string" && existing.cwd !== "" ? existing.cwd : ".";
		parts.push(`cwd → "${fields.cwd === "" ? "." : fields.cwd}" (was "${was}")`);
	}
	if (fields.when !== undefined) {
		parts.push(`when → ${fields.when} (was ${normalizeWhen(existing.when)})`);
	}
	if (fields.timeout !== undefined) {
		parts.push(`timeout → ${fields.timeout}s (was ${effectiveTimeout(existing)}s)`);
	}
	if (fields.readOnly !== undefined) {
		parts.push(`readOnly → ${fields.readOnly}`);
	}
	if (fields.description !== undefined) {
		parts.push(
			`description → ${fields.description === "" ? "(cleared)" : `"${fields.description}"`}`,
		);
	}
	return parts.join("; ");
}
