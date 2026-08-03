import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ────────────────────────────────────────────────────

type Mode = "ask" | "plan" | "implement";

/** Custom session entry type used to persist the active mode. */
const MODE_ENTRY_TYPE = "codepi-modes:mode";

/** Footer status key — read by custom-footer.ts to render the mode badge. */
const STATUS_KEY = "codepi-modes";

/** Custom message type sent into the conversation when the mode changes. */
const MODE_CHANGE_CUSTOM_TYPE = "codepi-modes:changed";

/** Tools that mutate the filesystem — blocked in Ask mode. */
const WRITE_TOOLS: readonly string[] = ["edit", "write"];

/**
 * Settings key for the Ask-mode whitelist:
 * `codepi.modes.ask.allowedTools` in <agentDir>/settings.json — a list of
 * tool names the user wants available even in read-only mode (e.g.
 * web-search tools from a trusted extension).
 */
const ASK_ALLOWED_TOOLS_KEY = ["codepi", "modes", "ask", "allowedTools"];

/**
 * Read-only tools that are ALWAYS part of the Ask-mode allowlist defaults:
 * the SDK's canonical read-only set (read/grep/find/ls) plus CodePi's host
 * tools that never mutate the filesystem, plus read-only web tools.
 */
export const READ_ONLY_TOOL_BASELINE: readonly string[] = [
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
	// codepi-context tools are pure reads of editor/git state — safe in
	// read-only mode (the session snapshot explicitly tells the agent to
	// call get_editor_context for live state).
	"get_editor_context",
	"get_git_diff",
];

/**
 * Default Ask-mode allowlist — the runtime fallback when
 * `codepi.modes.ask.allowedTools` is missing from settings.json. MUST stay in
 * sync with `ASK_MODE_DEFAULT_ALLOWED_TOOLS` in src/pi-store.ts (the host
 * seeds settings.json with the same list on activation).
 */
export const DEFAULT_ASK_ALLOWED_TOOLS: readonly string[] =
	READ_ONLY_TOOL_BASELINE;

/**
 * The Ask-mode allowlist: the explicit settings list when present (the user's
 * source of truth), otherwise the hardcoded defaults. An explicitly empty
 * list is respected as a user choice.
 */
export function getAskModeAllowlist(
	tools: readonly string[] | undefined,
): Set<string> {
	return new Set(tools === undefined ? DEFAULT_ASK_ALLOWED_TOOLS : tools);
}

/**
 * Read `codepi.modes.ask.allowedTools` from settings.json. Defensive: any
 * malformed/missing shape yields undefined (callers then fall back to
 * DEFAULT_ASK_ALLOWED_TOOLS); an explicitly empty list is preserved. Reads
 * fresh on every call so edits to settings.json take effect immediately.
 */
export function readAskAllowedTools(agentDir?: string): string[] | undefined {
	const dir =
		agentDir ??
		process.env.PI_CODING_AGENT_DIR ??
		join(homedir(), ".pi", "agent");
	try {
		const raw = readFileSync(join(dir, "settings.json"), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		let value: unknown = parsed;
		for (const key of ASK_ALLOWED_TOOLS_KEY) {
			if (!isRecord(value)) return undefined;
			value = value[key];
		}
		if (value === undefined) return undefined;
		if (!Array.isArray(value)) return undefined;
		const seen = new Set<string>();
		const out: string[] = [];
		for (const item of value) {
			if (typeof item !== "string") continue;
			const tool = item.trim();
			if (tool === "" || seen.has(tool)) continue;
			seen.add(tool);
			out.push(tool);
		}
		return out;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Notice injected into the conversation when the user manually switches
 * modes mid-session. The agent's context still holds the previous mode's
 * instructions and tool assumptions (and implement mode adds no system-prompt
 * instructions at all), so it must be told explicitly — otherwise it keeps
 * acting on the stale mode ("I'm still in Ask mode") or tries tools that are
 * no longer allowed ("Tool edit not found"). Delivered as a custom message on
 * the next turn, so it reaches the model without triggering an extra turn.
 */
const MODE_CHANGE_NOTICE: Record<Mode, string> = {
	ask: `## MODE CHANGED: ASK (READ-ONLY)

The user switched you to **Ask mode**. Only read-only tools are allowed — the
\`edit\`/\`write\` tools, shell commands (\`bash\`), and third-party extension tools
are all BLOCKED. You may read files, search, run diagnostics, and ask the user
questions, but you cannot modify or create files, and you cannot delegate work
that would do so. If the user wants changes, tell them to run /codepi-implement
(or /codepi-plan to plan first).`,
	plan: `## MODE CHANGED: PLAN (PLANNING ONLY)

The user switched you to **Plan mode**. Produce a detailed, actionable plan (explore with read/grep/find/ls, ask clarifying questions with ask_user_question, document it in docs/plans/, track steps with todo) and do NOT implement it. You may write plan/documentation files, but must not modify source code.`,
	implement: `## MODE CHANGED: IMPLEMENT (FULL ACCESS)

The user switched you to **Implement mode**. The \`edit\` and \`write\` tools are enabled — you may modify files and implement changes. Any previous read-only mode instructions no longer apply.`,
};

const MODE_BADGE: Record<Mode, string> = {
	ask: "ASK",
	plan: "PLAN",
	implement: "IMPLEMENT",
};

const MODE_LABELS: Record<Mode, string> = {
	ask: "Ask mode (read-only)",
	plan: "Plan mode (planning only)",
	implement: "Implement mode (full access)",
};

function isMode(value: unknown): value is Mode {
	return (
		value === "ask" || value === "plan" || value === "implement"
	);
}

// ── Mode instructions injected into the system prompt ────────

const ASK_INSTRUCTIONS = `## MODE: ASK (READ-ONLY)

You are in **Ask (read-only) mode**.

- You may read files, search the codebase, run read-only diagnostics, and answer questions.
- Shell commands (\`bash\`), the \`edit\`/\`write\` tools, and third-party extension
  tools are DISABLED — you cannot modify or create files, and you cannot
  delegate work that would do so.
- Only read-only tools are available: read, grep, find, ls, list_dir,
  find_files, get_diagnostics, ask_user_question — plus anything the user
  whitelists in \`codepi.modes.ask.allowedTools\` (settings.json).
- Do not attempt to change files, and never suggest that you will.
- You cannot switch modes yourself. If the user wants to plan or implement,
  tell them to run the command: /codepi-plan (plan) or /codepi-implement (implement).`;

const PLAN_INSTRUCTIONS = `## MODE: PLAN (PLANNING ONLY)

You are in **Plan mode**. Your goal is to produce a detailed, actionable plan —
NOT to implement it.

Workflow:
1. **Brainstorm**: explore the current implementation with read/grep/find/ls.
   Identify what exists, what is missing, and what should change.
2. **Clarify**: ask the user clarifying questions with the ask_user_question
   tool until the requirements are unambiguous.
3. **Document**: write the plan to a markdown file, e.g.
   \`docs/plans/<feature>.md\`, with a step-by-step implementation breakdown.
4. **Track**: add implementation todos using the todo tool so each planned step
   becomes a tracked task.
5. **Confirm**: when the plan is complete, ask the user (ask_user_question)
   whether they are satisfied with it. If they are, tell them to run
   \`/codepi-implement\` to start implementing.

Rules:
- You MAY write/edit documentation and planning files (.md, .txt, notes).
- You MUST NOT modify source code or configuration (.ts, .js, .json, .py, …)
  and you MUST NOT implement features or fix bugs.
- Keep exploration and discussion focused on producing the plan.`;

function buildModeInstructions(mode: Mode): string | undefined {
	switch (mode) {
		case "ask":
			return ASK_INSTRUCTIONS;
		case "plan":
			return PLAN_INSTRUCTIONS;
		case "implement":
			// Implement is pi's default mode — no extra instructions.
			return undefined;
	}
}

// ── Extension ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// In-memory mode for this session. Recovered from persisted custom
	// entries on session_start; new sessions default to implement.
	let currentMode: Mode = "implement";

	/** Latest persisted mode from the session branch (replays entries). */
	function readModeFromBranch(ctx: ExtensionContext): Mode {
		let mode: Mode = "implement";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) {
				continue;
			}
			const data = (entry.data ?? {}) as { mode?: unknown };
			if (isMode(data.mode)) mode = data.mode;
		}
		return mode;
	}

	/**
	 * Make the agent's tool registry match the current mode. Ask mode does NOT
	 * remove edit/write from the registry: blocking happens in the tool_call
	 * backstop, which returns a clear reason — removing them instead makes the
	 * model hit an opaque "Tool edit not found" error when it calls from stale
	 * context. This also heals sessions that stripped the tools under the old
	 * behavior (persisted active-tools state), so the backstop is reachable.
	 */
	function ensureWriteToolsPresent(): void {
		const active = pi.getActiveTools();
		const missing = WRITE_TOOLS.filter((t) => !active.includes(t));
		if (missing.length > 0) {
			pi.setActiveTools([...active, ...missing]);
		}
	}

	/** Update in-memory state, tools, footer status, persistence, and the
	 * agent's context. */
	function setMode(mode: Mode, ctx: ExtensionContext): void {
		currentMode = mode;
		ensureWriteToolsPresent();
		ctx.ui.setStatus(STATUS_KEY, MODE_BADGE[mode]);
		pi.appendEntry(MODE_ENTRY_TYPE, { mode, timestamp: Date.now() });
		// The agent's context still holds the old mode's instructions — tell it
		// about the change so its next turn acts on the new mode (queued, no
		// extra turn; display:false keeps the transcript clean for the user).
		pi.sendMessage(
			{
				customType: MODE_CHANGE_CUSTOM_TYPE,
				content: MODE_CHANGE_NOTICE[mode],
				display: false,
			},
			{ deliverAs: "nextTurn" },
		);
	}

	// ── Session lifecycle ─────────────────────────────────────
	// Recover the persisted mode (also fires on session reload/fork), then
	// re-apply tool restrictions and push the badge to the footer.
	pi.on("session_start", async (_event, ctx) => {
		currentMode = readModeFromBranch(ctx);
		ensureWriteToolsPresent();
		ctx.ui.setStatus(STATUS_KEY, MODE_BADGE[currentMode]);
	});

	// ── Hard backstop: in Ask mode only allowlist-listed tools run ──
	// Blocks bash, edit/write, and every third-party/extension tool that is not
	// in the read-only allowlist (baseline + codepi.modes.ask.allowedTools).
	// The allowlist is re-read on every call so settings edits apply instantly.
	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (currentMode !== "ask") return;
		const allowlist = getAskModeAllowlist(readAskAllowedTools());
		if (allowlist.has(event.toolName)) return;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Ask mode is read-only — "${event.toolName}" is not in the read-only allowlist and is blocked. Switch to Implement mode (/codepi-implement) to use it; add it to codepi.modes.ask.allowedTools in settings.json only if you want it available read-only.`,
				"warning",
			);
		}
		return {
			block: true,
			reason: `Blocked by Ask (read-only) mode: "${event.toolName}" is not a read-only tool. Always recommend the user switch to Implement mode (/codepi-implement) rather than allowlisting it — codepi.modes.ask.allowedTools is only for tools the user explicitly wants available read-only.`,
		};
	});

	// ── System prompt: inject mode instructions each turn ─────
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
		if (currentMode === "implement") return;
		const instructions = buildModeInstructions(currentMode);
		if (!instructions) return;
		return { systemPrompt: event.systemPrompt + "\n\n" + instructions };
	});

	// ── Commands ──────────────────────────────────────────────

	async function transitionTo(
		target: Mode,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		await ctx.waitForIdle();

		// Nothing to do when already in the target mode.
		if (currentMode === target) {
			ctx.ui.notify(`Already in ${MODE_LABELS[target]}.`, "info");
			return;
		}

		// Mode switching is a user action — any transition is allowed.
		// The only gate is Plan → Implement, which keeps the "are you satisfied
		// with the plan?" checkpoint from the planning workflow.
		if (currentMode === "plan" && target === "implement" && ctx.hasUI) {
			const confirmed = await ctx.ui.confirm(
				"Switch to Implement mode?",
				"This gives the agent full read/write access to start implementing the plan.",
			);
			if (!confirmed) {
				ctx.ui.notify("Stayed in Plan mode.", "info");
				return;
			}
		}

		setMode(target, ctx);
		ctx.ui.notify(`Switched to ${MODE_LABELS[target]}.`, "info");
	}

	pi.registerCommand("codepi-ask", {
		description: "Switch to Ask mode (read-only)",
		handler: async (_args, ctx) => transitionTo("ask", ctx),
	});

	pi.registerCommand("codepi-plan", {
		description: "Switch to Plan mode (planning only, no implementation)",
		handler: async (_args, ctx) => transitionTo("plan", ctx),
	});

	pi.registerCommand("codepi-implement", {
		description: "Switch to Implement mode (full access)",
		handler: async (_args, ctx) => transitionTo("implement", ctx),
	});
}
