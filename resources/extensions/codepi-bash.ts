/**
 * codepi-bash — CodePi's bash SAFETY SWITCH (ask / auto / disabled).
 *
 * The `bash` tool itself is injected by the extension host via
 * `baseToolsOverride` (src/tools/bash.ts, running in the extension host
 * process and executing through a hidden VS Code terminal). This bundled
 * extension owns everything around the approval gate:
 *
 *   - the per-session mode state (ask / auto / disabled), persisted to the
 *     session branch and shown in the custom footer ("codepi-bash" status),
 *   - the `/codepi-bash-ask`, `/codepi-bash-allow`, `/codepi-bash-disable`
 *     commands,
 *   - the TUI approval dialog (4-option, YES default) rendered through its
 *     ExtensionContext (`ctx.ui.select`), reached from the host bash tool via
 *     the per-session bridge in ./bash-bridge.ts.
 *
 * When this extension is disabled (Settings → bundled resources), no bridge
 * is registered and the host bash tool runs unguarded — the user explicitly
 * opted out of the approval layer (matching the previous stock-bash fallback
 * semantics).
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	setBashBridge,
	type BashApprovalResult,
	type BashMode,
} from "./bash-bridge";

// ── Constants ────────────────────────────────────────────────

const MODE_ENTRY_TYPE = "codepi-bash:mode";
const STATUS_KEY = "codepi-bash";
const MAX_TITLE_CHARS = 100;

export type DialogChoice = "approve" | "deny" | "revise" | "auto" | "cancel";

/** The 4-option approval dialog. Option 0 is pre-selected → Enter approves. */
export const DIALOG_OPTIONS = [
	"Yes, approve",
	"No, deny",
	"Revise…",
	"Approve & auto-approve all",
] as const;

export type { BashMode, BashApprovalResult } from "./bash-bridge";

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

// ── Approval dialog (rendered through the extension's TUI context) ──

/**
 * Ask the user whether the command may run (4 options, YES default). An
 * "auto" choice flips the switch to auto-approve before resolving; a
 * "revise" choice opens the input editor and returns the edited command.
 */
async function requestBashApproval(
	ctx: ExtensionContext,
	command: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onAutoApprove: () => void,
): Promise<BashApprovalResult> {
	const title =
		"Approve bash command?\n" +
		truncateToWidth(command, MAX_TITLE_CHARS) +
		"\ncwd: " +
		cwd;
	const choice = await ctx.ui.select(title, [...DIALOG_OPTIONS], { signal });
	const decision = mapDialogChoice(choice);
	if (decision === "auto") {
		// "Approve & auto-approve all" — flip the switch, then run.
		onAutoApprove();
		return { decision: "approve" };
	}
	if (decision === "revise") {
		const revised = await ctx.ui.input("Revise bash command", command, {
			signal,
		});
		if (revised === undefined || revised.trim() === "") {
			return { decision: "deny" };
		}
		return { decision: "revise", command: revised.trim() };
	}
	if (decision === "approve") {
		return { decision: "approve" };
	}
	return { decision: "deny" };
}

// ── Extension factory (safety switch only — no tool registration) ──

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

	// Recover the persisted mode (also fires on session reload/fork) and make
	// the approval surface reachable from the host bash tool.
	pi.on("session_start", async (_event, ctx) => {
		currentMode = readModeFromBranch(ctx.sessionManager.getBranch());
		ctx.ui.setStatus(STATUS_KEY, currentMode);
		const sessionId = ctx.sessionManager.getSessionId();
		setBashBridge(sessionId, {
			getMode: () => currentMode,
			requestApproval: (command, cwd, signal) =>
				requestBashApproval(ctx, command, cwd, signal, () =>
					setMode("auto", ctx),
				),
		});
	});

	// Drop the bridge when the session ends so stale approvals can never be
	// reached (a reload re-registers it on the next session_start).
	pi.on("session_shutdown", (_event, ctx) => {
		setBashBridge(ctx.sessionManager.getSessionId(), undefined);
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
}
