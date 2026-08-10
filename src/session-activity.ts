/**
 * Per-session activity tracker: maps pi SDK session events to a coarse
 * tab-indicator state (idle / working / waiting / error).
 *
 * Signals used:
 *  - `turn_start` / `agent_end` / `compaction_*` — lifecycle of a run
 *  - `tool_execution_start/end` — a tool that blocks on user input flips the
 *    state to "waiting" for the duration of that tool's execution:
 *      - `ask_user_question` (the pi agent package dialog) always blocks
 *      - `bash` only blocks when the per-session approval mode is "ask" (the
 *        4-option Yes/No/Revise/auto-approve dialog gates every invocation)
 *  - `extension_ui_start/end` — an extension opened a blocking UI dialog
 *    (ctx.ui.select / ctx.ui.input, e.g. the safety-guard "Allow this
 *    action?" permission dialog). The dialog opens inside the tool_call
 *    hook, so `tool_execution_start` alone cannot detect it — the session
 *    emits these events when the interactive mode shows/hides the dialog.
 *    Only flips to "waiting" while a turn is active, so user-initiated
 *    extension dialogs (slash commands) while idle stay white.
 *  - `turn_end` with `message.errorMessage` — failed turn (red)
 *
 * Limitation (shared with installAutoVerify): the subscription is attached to
 * the AgentSession object handed out at backend start. When the user runs
 * /new, /resume, or /fork the runtime swaps in a new session and pi's
 * InteractiveMode (which owns the rebind hook) re-subscribes — the host cannot
 * hook that point. Switches happen while the agent is idle, so the indicator
 * stays at "idle" (white) for the new session until the panel is recreated.
 */

export type SessionActivity = "idle" | "working" | "waiting" | "error";

/** Structural subset of pi's AgentSessionEvent — enough for the state machine. */
export type ActivityEvent = {
	type: string;
	toolCallId?: string;
	toolName?: string;
	// `unknown`: the real events carry the full AgentMessage union here; the
	// tracker only reads errorMessage, narrowed below.
	message?: unknown;
	/** Which extension UI surface opened/closed ("select" | "input"). */
	ui?: string;
};

const INPUT_TOOL_NAMES = new Set(["ask_user_question"]);

/** custom entry type used by the codepi-bash extension to persist the mode. */
const BASH_MODE_ENTRY_TYPE = "codepi-bash:mode";

export type BashApprovalMode = "ask" | "auto";

/**
 * Replay the persisted bash approval mode from the session branch.
 * Mirrors `readModeFromBranch` in resources/extensions/codepi-bash.ts (kept
 * local so the host stays decoupled from bundled extensions, which can be
 * toggled off). Defaults to "ask".
 */
export function readBashApprovalMode(
	branch: readonly unknown[],
): BashApprovalMode {
	let mode: BashApprovalMode = "ask";
	for (const entry of branch) {
		if (!isRecord(entry)) continue;
		if (entry.type !== "custom" || entry.customType !== BASH_MODE_ENTRY_TYPE) {
			continue;
		}
		const data = isRecord(entry.data) ? entry.data : {};
		if (data.mode === "ask" || data.mode === "auto") mode = data.mode;
	}
	return mode;
}

/**
 * Whether executing `toolName` means the agent is blocked on user input.
 * `bashMode` is consulted lazily so the approval mode can change mid-session
 * (e.g. when the user picks "approve & auto-approve all" in the dialog).
 */
export function isInputTool(
	toolName: string,
	bashMode: () => BashApprovalMode,
): boolean {
	if (INPUT_TOOL_NAMES.has(toolName)) return true;
	return toolName === "bash" && bashMode() === "ask";
}

export type SessionActivityTracker = {
	/** Unsubscribe and forget all state. */
	dispose: () => void;
};

/**
 * Drive an activity callback from a session event stream.
 *
 * `subscribe` receives a listener and must return the unsubscribe function
 * (AgentSession.subscribe has exactly this shape).
 */
export function createSessionActivityTracker(options: {
	subscribe: (listener: (event: ActivityEvent) => void) => () => void;
	bashMode: () => BashApprovalMode;
	onActivity: (activity: SessionActivity) => void;
}): SessionActivityTracker {
	let activity: SessionActivity = "idle";
	// True between turn_start and agent_end — gates extension-UI dialogs so
	// only agent-blocking dialogs flip the indicator to "waiting".
	let turnActive = false;
	// toolCallIds of input tools currently executing. Keyed by id (not name) so
	// an end event always clears its own start — even when the bash approval
	// mode flips mid-execution (auto-approve picked inside the dialog).
	const pendingInputToolIds = new Set<string>();
	// Extension UI dialogs currently open (ctx.ui.select / ctx.ui.input).
	// Counted (not boolean) so nested dialogs — e.g. approve → "Revise…" —
	// keep the "waiting" state until the last one closes.
	let pendingExtensionUiCount = 0;

	const set = (next: SessionActivity): void => {
		if (next === activity) return;
		activity = next;
		options.onActivity(next);
	};

	const dispose = options.subscribe((event) => {
		switch (event.type) {
			case "turn_start":
				turnActive = true;
				set("working");
				break;
			case "tool_execution_start": {
				const input = isInputTool(event.toolName ?? "", options.bashMode);
				if (input) {
					pendingInputToolIds.add(event.toolCallId ?? event.toolName ?? "");
				}
				set(
					pendingInputToolIds.size > 0 || pendingExtensionUiCount > 0
						? "waiting"
						: "working",
				);
				break;
			}
			case "tool_execution_end":
				pendingInputToolIds.delete(event.toolCallId ?? event.toolName ?? "");
				set(
					pendingInputToolIds.size > 0 || pendingExtensionUiCount > 0
						? "waiting"
						: "working",
				);
				break;
			case "turn_end": {
				const errorMessage =
					event.message !== null && typeof event.message === "object"
						? (event.message as { errorMessage?: string }).errorMessage
						: undefined;
				set(errorMessage ? "error" : "working");
				break;
			}
			case "agent_end":
				turnActive = false;
				pendingExtensionUiCount = 0;
				set("idle");
				break;
			case "compaction_start":
				set("working");
				break;
			case "compaction_end":
				turnActive = false;
				pendingExtensionUiCount = 0;
				set("idle");
				break;
			// Extension UI dialog opened (e.g. safety-guard's permission
			// dialog, or codepi-bash's approval in any mode) — the agent is
			// blocked on user input until it closes.
			case "extension_ui_start":
				pendingExtensionUiCount++;
				if (turnActive) set("waiting");
				break;
			case "extension_ui_end":
				pendingExtensionUiCount = Math.max(0, pendingExtensionUiCount - 1);
				if (turnActive) {
					set(
						pendingInputToolIds.size > 0 || pendingExtensionUiCount > 0
							? "waiting"
							: "working",
					);
				}
				// No turn active: the dialog never flipped the indicator (only
				// agent-blocking dialogs do), so nothing to restore.
				break;
		}
	});

	return { dispose };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
