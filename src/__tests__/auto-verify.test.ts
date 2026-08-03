import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { installAutoVerify } from "../auto-verify";
import { collectDiagnostics } from "../tools/diagnostics";

vi.mock("../tools/diagnostics", () => ({
	collectDiagnostics: vi.fn(),
}));

const collectDiagnosticsMock = vi.mocked(collectDiagnostics);

const DEFAULT_REPORT = {
	text: "Problems: 1 error in 1 file\n\nsrc/a.ts:\n  error   5:3  Bad call (typescript)",
	details: {
		errors: 1,
		warnings: 0,
		infos: 0,
		hints: 0,
		total: 1,
		files: 1,
		truncatedTo: 1,
		settled: true,
		staleBuffer: false,
	},
	missing: [],
};

const CLEAN_REPORT = {
	text: "No problems found (severity: info or more severe).",
	details: {
		errors: 0,
		warnings: 0,
		infos: 0,
		hints: 0,
		total: 0,
		files: 0,
		truncatedTo: 0,
		settled: true,
		staleBuffer: false,
	},
	missing: [],
};

// ── Fake session ─────────────────────────────────────────────

let listener: ((event: AgentSessionEvent) => void) | undefined;

function createSession() {
	listener = undefined;
	const sendUserMessage = vi.fn(async (_text: string, _options?: unknown) => {});
	const sendCustomMessage = vi.fn(
		async (
			_message: { customType?: string; content?: string; display?: boolean },
			_options?: { deliverAs?: string },
		) => {},
	);
	const session = {
		subscribe: vi.fn((l: (event: AgentSessionEvent) => void) => {
			listener = l;
			return () => {
				listener = undefined;
			};
		}),
		sendUserMessage,
		sendCustomMessage,
	} as unknown as AgentSession;
	return { session, sendUserMessage, sendCustomMessage };
}

function fire(event: unknown): void {
	listener!(event as AgentSessionEvent);
}

// ── Event builders ───────────────────────────────────────────

const editStart = (callId: string, path: string) => ({
	type: "tool_execution_start" as const,
	toolCallId: callId,
	toolName: "edit",
	args: { path },
});
const editEnd = (callId: string, isError = false) => ({
	type: "tool_execution_end" as const,
	toolCallId: callId,
	toolName: "edit",
	result: {},
	isError,
});
const writeEnd = (callId: string, isError = false) => ({
	type: "tool_execution_end" as const,
	toolCallId: callId,
	toolName: "write",
	result: {},
	isError,
});
const verifyStart = (callId: string, path?: string) => ({
	type: "tool_execution_start" as const,
	toolCallId: callId,
	toolName: "get_diagnostics",
	args: path ? { path } : {},
});
const agentEnd = (willRetry = false) => ({
	type: "agent_end" as const,
	messages: [],
	willRetry,
});

beforeEach(() => {
	collectDiagnosticsMock.mockReset();
	collectDiagnosticsMock.mockResolvedValue(DEFAULT_REPORT);
});

describe("installAutoVerify", () => {
	it("queues a nextTurn verification message after an editing turn", async () => {
		const { session, sendCustomMessage, sendUserMessage } = createSession();
		const mode = { current: "nextTurn" as const };
		installAutoVerify(session, { getMode: () => mode.current });

		fire(editStart("e1", "src/a.ts"));
		fire(editEnd("e1"));
		fire(agentEnd());

		await vi.waitFor(() => expect(sendCustomMessage).toHaveBeenCalledTimes(1));
		expect(collectDiagnosticsMock).toHaveBeenCalledWith({
			paths: ["src/a.ts"],
			limit: 30,
			scopeLabel: " in the files you edited",
		});
		const [message, options] = sendCustomMessage.mock.calls[0]!;
		expect(message.customType).toBe("codepi-auto-verify");
		expect(message.display).toBe(false);
		expect(options).toEqual({ deliverAs: "nextTurn" });
		expect(message.content).toContain("CodePi verification");
		expect(message.content).toContain("Problems: 1 error in 1 file");
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("sends an immediate follow-up in followUp mode", async () => {
		const { session, sendCustomMessage, sendUserMessage } = createSession();
		const mode = { current: "followUp" as const };
		installAutoVerify(session, { getMode: () => mode.current });

		fire(editStart("e1", "src/a.ts"));
		fire(editEnd("e1"));
		fire(agentEnd());

		await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledTimes(1));
		const [text, options] = sendUserMessage.mock.calls[0]!;
		expect(options).toEqual({ deliverAs: "followUp" });
		expect(text).toContain("Problems: 1 error in 1 file");
		expect(sendCustomMessage).not.toHaveBeenCalled();
	});

	it("stays silent when the mode is off", async () => {
		const { session, sendCustomMessage, sendUserMessage } = createSession();
		const mode = { current: "off" as const };
		installAutoVerify(session, { getMode: () => mode.current });

		fire(editStart("e1", "src/a.ts"));
		fire(editEnd("e1"));
		fire(agentEnd());
		await new Promise((r) => setTimeout(r, 10));

		expect(sendCustomMessage).not.toHaveBeenCalled();
		expect(sendUserMessage).not.toHaveBeenCalled();
		expect(collectDiagnosticsMock).not.toHaveBeenCalled();
	});

	it("stays silent when the model already verified the edited files", async () => {
		const { session, sendCustomMessage } = createSession();
		installAutoVerify(session, { getMode: () => "nextTurn" });

		fire(editStart("e1", "src/a.ts"));
		fire(editEnd("e1"));
		fire(verifyStart("v1", "src/a.ts"));
		fire(agentEnd());
		await new Promise((r) => setTimeout(r, 10));

		expect(collectDiagnosticsMock).not.toHaveBeenCalled();
		expect(sendCustomMessage).not.toHaveBeenCalled();
	});

	it("treats an unscoped get_diagnostics as verifying everything", async () => {
		const { session, sendCustomMessage } = createSession();
		installAutoVerify(session, { getMode: () => "nextTurn" });

		fire(editStart("e1", "src/a.ts"));
		fire(editEnd("e1"));
		fire(verifyStart("v1"));
		fire(agentEnd());
		await new Promise((r) => setTimeout(r, 10));

		expect(collectDiagnosticsMock).not.toHaveBeenCalled();
		expect(sendCustomMessage).not.toHaveBeenCalled();
	});

	it("stays silent when the report is clean", async () => {
		collectDiagnosticsMock.mockResolvedValue(CLEAN_REPORT);
		const { session, sendCustomMessage, sendUserMessage } = createSession();
		installAutoVerify(session, { getMode: () => "nextTurn" });

		fire(editStart("e1", "src/a.ts"));
		fire(editEnd("e1"));
		fire(agentEnd());
		await new Promise((r) => setTimeout(r, 10));

		expect(sendCustomMessage).not.toHaveBeenCalled();
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("ignores failed writes and edits", async () => {
		const { session, sendCustomMessage } = createSession();
		installAutoVerify(session, { getMode: () => "nextTurn" });

		fire(editStart("e1", "src/a.ts"));
		fire(editEnd("e1", true)); // Ask-mode rejection → isError
		fire(editStart("w1", "src/b.ts"));
		fire(writeEnd("w1", true));
		fire(agentEnd());
		await new Promise((r) => setTimeout(r, 10));

		expect(collectDiagnosticsMock).not.toHaveBeenCalled();
		expect(sendCustomMessage).not.toHaveBeenCalled();
	});

	it("keeps the edit set across a retried run", async () => {
		const { session, sendCustomMessage } = createSession();
		installAutoVerify(session, { getMode: () => "nextTurn" });

		fire(editStart("e1", "src/a.ts"));
		fire(editEnd("e1"));
		fire(agentEnd(true)); // will retry — nothing sent, set kept
		fire(editStart("e2", "src/b.ts"));
		fire(editEnd("e2"));
		fire(agentEnd(false)); // settled — both files verified

		await vi.waitFor(() => expect(collectDiagnosticsMock).toHaveBeenCalledTimes(1));
		expect(collectDiagnosticsMock.mock.calls[0]?.[0]?.paths).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
		expect(sendCustomMessage).toHaveBeenCalledTimes(1);
	});

	it("resets state after a settled turn", async () => {
		const { session, sendCustomMessage } = createSession();
		installAutoVerify(session, { getMode: () => "nextTurn" });

		fire(editStart("e1", "src/a.ts"));
		fire(editEnd("e1"));
		fire(agentEnd());
		await vi.waitFor(() => expect(sendCustomMessage).toHaveBeenCalledTimes(1));

		// Second turn with no edits must not re-verify.
		fire(agentEnd());
		await new Promise((r) => setTimeout(r, 10));
		expect(sendCustomMessage).toHaveBeenCalledTimes(1);
		expect(collectDiagnosticsMock).toHaveBeenCalledTimes(1);
	});

	it("exposes the last summary and supports disposal", async () => {
		const { session } = createSession();
		const control = installAutoVerify(session, {
			getMode: () => "nextTurn",
		});

		fire(editStart("e1", "src/a.ts"));
		fire(editEnd("e1"));
		fire(agentEnd());
		await vi.waitFor(() => expect(control.lastSummary).toBeDefined());
		expect(control.lastSummary).toContain("Problems: 1 error in 1 file");

		control.dispose();
		expect(listener).toBeUndefined();
	});
});
