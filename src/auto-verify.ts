import type {
	AgentSession,
	AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { AutoVerifyMode } from "./shared/settings-protocol";
import { collectDiagnostics } from "./tools/diagnostics";

/**
 * Automatic post-edit verification.
 *
 * After an agent turn that used the `write`/`edit` tools, lint exactly the
 * files the agent touched (via the shared Problems-panel collector) and put
 * the findings back in front of the model:
 *
 * - "nextTurn" (default): attach as quiet context on the user's next prompt.
 * - "followUp": send immediately so the agent keeps working to fix them.
 * - "off": nothing — the agent only verifies when it calls get_diagnostics
 *   itself.
 *
 * The edited-file set is tracked from `tool_execution` events, so it is
 * precise: pre-existing problems in files the agent never touched never
 * enter the output.
 */

const EDIT_TOOLS = new Set(["write", "edit"]);
const VERIFY_TOOL = "get_diagnostics";
const VERIFY_LIMIT = 30;

export interface AutoVerifyOptions {
	/** Read the current mode (checked at agent_end, so live edits apply). */
	getMode: () => AutoVerifyMode;
}

export interface AutoVerifyControl {
	/** Stop listening to session events. */
	dispose(): void;
	/** Last verification summary (tests/debugging). */
	lastSummary: string | undefined;
}

/**
 * Subscribe to a session's agent events and queue verification messages.
 * Returns a control handle; call dispose() when the session is torn down.
 */
export function installAutoVerify(
	session: AgentSession,
	options: AutoVerifyOptions,
): AutoVerifyControl {
	let editedPaths: string[] = [];
	let verifiedAll = false;
	let verifiedPaths = new Set<string>();
	// toolCallId → edited path, paired start→end so failed calls are skipped.
	let pendingEdits = new Map<string, string>();
	let lastSummary: string | undefined;

	const unsubscribe = session.subscribe(async (event: AgentSessionEvent) => {
		switch (event.type) {
			case "tool_execution_start": {
				const path = (event.args as { path?: unknown } | undefined)?.path;
				if (event.toolName === VERIFY_TOOL) {
					if (typeof path === "string" && path !== "") {
						verifiedPaths.add(path);
					} else {
						verifiedAll = true;
					}
				} else if (EDIT_TOOLS.has(event.toolName)) {
					if (typeof path === "string" && path.trim() !== "") {
						pendingEdits.set(event.toolCallId, path.trim());
					}
				}
				break;
			}
			case "tool_execution_end": {
				const path = pendingEdits.get(event.toolCallId);
				if (path !== undefined) {
					pendingEdits.delete(event.toolCallId);
					// Only successful edits count (Ask-mode / plan-restricted calls
					// return isError and changed nothing).
					if (!event.isError) editedPaths.push(path);
				}
				break;
			}
			case "agent_end": {
				// Retried runs will re-edit — keep the accumulated set.
				if (event.willRetry) return;
				const paths = editedPaths;
				const verified =
					verifiedAll || paths.every((p) => verifiedPaths.has(p));
				editedPaths = [];
				verifiedAll = false;
				verifiedPaths = new Set();
				pendingEdits.clear();
				if (paths.length === 0 || verified || options.getMode() === "off") {
					return;
				}
				void runVerification(session, paths, options.getMode(), (text) => {
					lastSummary = text;
				});
				break;
			}
		}
	});

	return {
		dispose: unsubscribe,
		get lastSummary() {
			return lastSummary;
		},
	};
}

async function runVerification(
	session: AgentSession,
	paths: string[],
	mode: AutoVerifyMode,
	onSummary: (text: string) => void,
): Promise<void> {
	try {
		const report = await collectDiagnostics({
			paths,
			limit: VERIFY_LIMIT,
			scopeLabel: " in the files you edited",
		});
		if (report.details.total === 0) return;
		const text =
			`CodePi verification — problems found in the files you edited this turn:\n\n` +
			report.text +
			`\n\nRun get_diagnostics for full details, or fix the reported problems before continuing.`;
		onSummary(text);
		if (mode === "followUp") {
			// The agent keeps working to fix the problems (git-merge pattern).
			await session.sendUserMessage(text, { deliverAs: "followUp" });
		} else {
			// Quiet: attach as context on the user's next prompt.
			await session.sendCustomMessage(
				{
					customType: "codepi-auto-verify",
					content: text,
					display: false,
				},
				{ deliverAs: "nextTurn" },
			);
		}
	} catch {
		// Diagnostics unavailable (no language service, unreadable settings) —
		// stay silent rather than spamming the session.
	}
}
