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
 *  - `extension_ui_start/end` — a blocking extension UI dialog opened (any
 *    ctx.ui.* dialog: select / confirm / input / editor / custom, e.g. the
 *    safety-guard "Allow this action?" permission dialog or the bash
 *    approval dialog). The dialog opens inside the tool_call hook, so
 *    `tool_execution_start` alone cannot detect it. These events are fed in
 *    by the activity bridge (createActivityBridge), which forwards pi's
 *    official `ui_prompt_start` / `ui_prompt_end` extension events — the
 *    session event stream does not carry them. Only flips to "waiting"
 *    while a turn is active, so user-initiated extension dialogs (slash
 *    commands) while idle stay white.
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
	/** Which extension UI surface opened/closed (select / confirm / input /
	 *  editor / custom). */
	ui?: string;
	/** Dialog title, when the source provides one. */
	title?: string;
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
	/**
	 * Feed an externally-sourced event through the same state machine as
	 * session events — used by the activity bridge to inject blocking
	 * extension UI dialogs, which the session event stream does not carry.
	 */
	emit: (event: ActivityEvent) => void;
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
	// Extension UI dialogs currently open (any ctx.ui.* dialog).
	// Counted (not boolean) so nested dialogs — e.g. approve → "Revise…" —
	// keep the "waiting" state until the last one closes.
	let pendingExtensionUiCount = 0;

	const set = (next: SessionActivity): void => {
		if (next === activity) return;
		activity = next;
		options.onActivity(next);
	};

	const handle = (event: ActivityEvent): void => {
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
	};

	// Session events and the activity bridge's dialog events share one state
	// machine.
	const dispose = options.subscribe(handle);

	return { dispose, emit: handle };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Extension UI activity bridge ─────────────────────────────

/** Structural subset of pi's `ui_prompt_*` extension event payload. */
export interface UIPromptEvent {
	/** Dialog kind: select / confirm / input / editor / custom. */
	kind?: string;
	title?: string;
}

/** Structural subset of pi's ExtensionAPI that the bridge subscribes to. */
export interface UIPromptEventSource {
	on(
		event: "ui_prompt_start" | "ui_prompt_end",
		handler: (event: UIPromptEvent) => void,
	): void;
}

/**
 * Bridge pi's official `ui_prompt_start` / `ui_prompt_end` extension events
 * onto the tracker's event stream.
 *
 * pi emits these from `ExtensionRunner.withUIPrompt()` for every `ctx.ui.*`
 * dialog kind (select / confirm / input / editor / custom), so they cover
 * dialogs an SDK patch would never reach — and they stay correct upstream
 * refactors, unlike the interactive-mode internals this used to patch. The
 * factory is registered as a hidden inline extension (the loader's
 * `extensionFactories` option) and must be wired in by the host: pi's
 * extension event bus is separate from the session event stream the tracker
 * subscribes to.
 *
 * The tracker is created after the session (it needs the runtime), so the
 * caller passes a late-bound emitter that forwards into `tracker.emit`.
 */
export function createActivityBridge(
	emit: (event: ActivityEvent) => void,
): (pi: UIPromptEventSource) => void {
	return (pi) => {
		pi.on("ui_prompt_start", (event) =>
			emit({ type: "extension_ui_start", ui: event.kind, title: event.title }),
		);
		pi.on("ui_prompt_end", (event) =>
			emit({ type: "extension_ui_end", ui: event.kind }),
		);
	};
}
