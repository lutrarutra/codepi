/**
 * Bash safety-switch bridge between the extension host and the codepi-bash
 * bundled extension.
 *
 * The `bash` tool itself lives in the host (src/tools/bash.ts) and is injected
 * via `baseToolsOverride`. The approval gate and the ask/auto/disabled switch
 * live in the codepi-bash extension (resources/extensions/codepi-bash.ts),
 * which owns the mode state, its persistence (session branch + footer badge)
 * and the TUI approval dialog (ctx.ui).
 *
 * The two sides meet here: a per-session bridge object registered under
 * `globalThis.__codepiBash[sessionId]` by the extension on `session_start`
 * (removed on `session_shutdown`). The tool looks the bridge up per call.
 * When the extension is disabled there is no bridge and the tool runs in
 * "auto" mode (no approval gate) — the same "explicitly opted out" semantics
 * as the previous stock-bash fallback.
 */

export type BashMode = "ask" | "auto" | "disabled";

export type BashApprovalResult =
	| { decision: "approve" }
	| { decision: "deny" }
	| { decision: "revise"; command: string };

/** Per-session contract implemented by the codepi-bash extension. */
export interface CodepiBashBridge {
	/** Current approval mode (per-session state owned by the extension). */
	getMode(): BashMode;
	/**
	 * Ask the user whether the command may run (4-option TUI dialog, YES
	 * default). Resolves to the final decision; an "auto" choice is persisted
	 * by the extension before resolving, a "revise" choice returns the
	 * user-edited command.
	 */
	requestApproval(
		command: string,
		cwd: string,
		signal?: AbortSignal,
	): Promise<BashApprovalResult>;
}

const BASH_BRIDGE_KEY = "__codepiBash";

type BridgeTable = Record<string, CodepiBashBridge | undefined>;

function bridgeTable(): BridgeTable {
	const g = globalThis as Record<string, unknown>;
	const table = g[BASH_BRIDGE_KEY] as BridgeTable | undefined;
	if (table && typeof table === "object") return table;
	const fresh: BridgeTable = {};
	g[BASH_BRIDGE_KEY] = fresh;
	return fresh;
}

/** Look up the codepi-bash bridge for a session (undefined when the bundled
 * extension is disabled or has not registered yet). */
export function getBashBridge(sessionId: string): CodepiBashBridge | undefined {
	return bridgeTable()[sessionId];
}

/** Register (or clear, with `undefined`) the bridge for a session. */
export function setBashBridge(
	sessionId: string,
	bridge: CodepiBashBridge | undefined,
): void {
	const table = bridgeTable();
	if (bridge === undefined) {
		delete table[sessionId];
		return;
	}
	table[sessionId] = bridge;
}
