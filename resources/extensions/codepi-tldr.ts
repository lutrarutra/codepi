/**
 * codepi-tldr — TL;DR Mode for CodePi.
 *
 * A bundled PI extension providing `/codepi-toggle-tldr`. When TL;DR mode is on, each
 * turn renders as a single summary row (spinner, token/tool counts, cost,
 * elapsed, model) plus the final response — everything else the agent does is
 * collapsed (the rendering itself lives in the pi interactive mode, driven
 * through `ctx.ui.setCompactMode`).
 *
 * State resolution (highest precedence first):
 *   1. Per-session override persisted with `pi.appendEntry` — survives
 *      session reload, fork, and VS Code restarts.
 *   2. `codepi.tldrMode` in <agentDir>/settings.json (the sidebar
 *      "TL;DR Mode" toggle, default true).
 *   3. Hard default: enabled.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MODE_ENTRY_TYPE = "codepi-tldr:mode";
const SETTINGS_KEY = ["codepi", "tldrMode"];
const DEFAULT_TLDR_MODE = true;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Read `codepi.tldrMode` from settings.json. Defensive: malformed/missing
 * shape yields undefined (callers fall back to the default). Reads fresh on
 * every call so edits to settings.json take effect immediately.
 */
export function readTldrModeSetting(agentDir?: string): boolean | undefined {
	try {
		const raw = readFileSync(
			join(agentDir ?? getAgentDir(), "settings.json"),
			"utf8",
		);
		const parsed = JSON.parse(raw) as unknown;
		let value: unknown = parsed;
		for (const key of SETTINGS_KEY) {
			if (!isRecord(value)) return undefined;
			value = value[key];
		}
		return typeof value === "boolean" ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Replay the persisted per-session TL;DR mode override from the session
 * branch. Returns undefined when no override has been recorded.
 */
export function readTldrModeOverride(
	branch: readonly unknown[],
): boolean | undefined {
	let override: boolean | undefined;
	for (const entry of branch) {
		if (!isRecord(entry)) continue;
		if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) {
			continue;
		}
		const data = isRecord(entry.data) ? entry.data : {};
		if (typeof data.enabled === "boolean") override = data.enabled;
	}
	return override;
}

export default function (pi: ExtensionAPI) {
	let currentEnabled = DEFAULT_TLDR_MODE;
	// True between agent_start and agent_end. A compact toggle fired mid-turn
	// cannot create the compact summary row (pi only starts one when a turn
	// BEGINS in compact mode), so hiding the loader then would leave no
	// spinner at all until the turn ends.
	let turnActive = false;

	/**
	 * Sync pi's working loader with the mode. In TL;DR mode the summary row
	 * has its own spinner, so pi's loader (the "✳ …" icon + rotating verb
	 * line, customizable via setWorkingIndicator/setWorkingMessage) is hidden
	 * entirely. Restored when TL;DR is off.
	 */
	function applyWorkingLoader(ctx: ExtensionContext, enabled: boolean): void {
		ctx.ui.setWorkingVisible(!enabled);
	}

	/** Resolve and apply the effective mode from ctx, without notifying. */
	function applyEffectiveMode(ctx: ExtensionContext): void {
		const override = readTldrModeOverride(ctx.sessionManager.getBranch());
		const setting = readTldrModeSetting();
		const enabled = override ?? setting ?? DEFAULT_TLDR_MODE;
		currentEnabled = enabled;
		ctx.ui.setCompactMode(enabled);
		applyWorkingLoader(ctx, enabled);
	}

	// Recover the persisted mode (also fires on session reload/fork). A
	// reload mid-turn must not treat the in-flight turn as active: the turn
	// state was reconstructed, and applyEffectiveMode already asserted the
	// compact loader state.
	pi.on("session_start", async (_event, ctx) => {
		turnActive = false;
		applyEffectiveMode(ctx);
	});

	// Re-assert loader visibility every turn: pi resets workingVisible to
	// true internally on session reset, and the loader would otherwise be
	// created when streaming starts.
	pi.on("agent_start", async (_event, ctx) => {
		turnActive = true;
		applyWorkingLoader(ctx, currentEnabled);
	});

	// Turn finished: drop the turn-active gate and re-assert the compact
	// state, which clears the loader kept spinning by a mid-turn toggle.
	pi.on("agent_end", async (_event, ctx) => {
		turnActive = false;
		applyWorkingLoader(ctx, currentEnabled);
	});

	pi.registerCommand("codepi-toggle-tldr", {
		description:
			"Toggle TL;DR mode (collapse everything but the final response).",
		handler: async (_args, ctx) => {
			const next = !(ctx.ui.isCompactMode?.() ?? currentEnabled);
			currentEnabled = next;
			ctx.ui.setCompactMode(next);
			// Toggling ON mid-turn: pi has no compact summary row for the
			// in-flight turn, so hiding the loader would leave no spinner at
			// all. Keep it spinning; agent_end/agent_start re-assert the
			// compact (hidden) state.
			ctx.ui.setWorkingVisible(!next || turnActive);
			pi.appendEntry(MODE_ENTRY_TYPE, {
				enabled: next,
				timestamp: Date.now(),
			});
			ctx.ui.notify(
				next
					? "TL;DR mode on — agent activity collapses to a summary."
					: "TL;DR mode off — full transcript restored.",
			);
		},
	});
}
