import { describe, expect, it, vi } from "vitest";
import {
	createSessionActivityTracker,
	readBashApprovalMode,
	type ActivityEvent,
	type SessionActivity,
} from "../session-activity";

function makeTracker(bashMode: () => "ask" | "auto" = () => "ask") {
	const onActivity = vi.fn();
	let listener: ((event: ActivityEvent) => void) | undefined;
	const tracker = createSessionActivityTracker({
		subscribe: (l) => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		bashMode,
		onActivity,
	});
	return {
		emit: (e: {
			type: string;
			toolName?: string;
			message?: { errorMessage?: string };
		}) => listener?.(e as ActivityEvent),
		activities: () => onActivity.mock.calls.map((c) => c[0] as SessionActivity),
		dispose: tracker.dispose,
	};
}

describe("createSessionActivityTracker", () => {
	it("tracks the turn lifecycle: idle → working → idle", () => {
		const t = makeTracker();
		t.emit({ type: "turn_start" });
		t.emit({ type: "agent_end" });
		expect(t.activities()).toEqual(["working", "idle"]);
	});

	it("marks ask_user_question as waiting while it executes", () => {
		const t = makeTracker();
		t.emit({ type: "turn_start" });
		t.emit({ type: "tool_execution_start", toolName: "ask_user_question" });
		t.emit({ type: "tool_execution_end", toolName: "ask_user_question" });
		expect(t.activities()).toEqual(["working", "waiting", "working"]);
	});

	it("marks bash as waiting only in ask (approval dialog) mode", () => {
		const ask = makeTracker(() => "ask");
		ask.emit({ type: "tool_execution_start", toolName: "bash" });
		ask.emit({ type: "tool_execution_end", toolName: "bash" });
		expect(ask.activities()).toEqual(["waiting", "working"]);

		const auto = makeTracker(() => "auto");
		auto.emit({ type: "tool_execution_start", toolName: "bash" });
		auto.emit({ type: "tool_execution_end", toolName: "bash" });
		expect(auto.activities()).toEqual(["working"]);
	});

	it("stays waiting while other tools run alongside an input tool", () => {
		const t = makeTracker();
		t.emit({ type: "tool_execution_start", toolName: "ask_user_question" });
		t.emit({ type: "tool_execution_start", toolName: "grep" });
		t.emit({ type: "tool_execution_end", toolName: "grep" });
		t.emit({ type: "tool_execution_end", toolName: "ask_user_question" });
		expect(t.activities()).toEqual(["waiting", "working"]);
	});

	it("switches to the new bash mode when the user auto-approves mid-session", () => {
		let mode: "ask" | "auto" = "ask";
		const t = makeTracker(() => mode);
		t.emit({ type: "tool_execution_start", toolName: "bash" }); // dialog opens
		expect(t.activities()).toEqual(["waiting"]);
		mode = "auto"; // user picked "approve & auto-approve all"
		t.emit({ type: "tool_execution_end", toolName: "bash" });
		t.emit({ type: "tool_execution_start", toolName: "bash" }); // no dialog now
		t.emit({ type: "tool_execution_end", toolName: "bash" });
		expect(t.activities()).toEqual(["waiting", "working"]);
	});

	it("shows red on a failed turn and recovers on the next turn", () => {
		const t = makeTracker();
		t.emit({ type: "turn_start" });
		t.emit({
			type: "turn_end",
			message: { errorMessage: "provider quota exceeded" },
		});
		t.emit({ type: "agent_end" });
		expect(t.activities()).toEqual(["working", "error", "idle"]);
	});

	it("treats compaction as busy work", () => {
		const t = makeTracker();
		t.emit({ type: "compaction_start" });
		t.emit({ type: "compaction_end" });
		expect(t.activities()).toEqual(["working", "idle"]);
	});

	it("does not fire duplicate activity callbacks", () => {
		const t = makeTracker();
		t.emit({ type: "turn_start" });
		t.emit({ type: "message_start" });
		t.emit({ type: "message_update" });
		t.emit({ type: "turn_start" });
		expect(t.activities()).toEqual(["working"]);
	});

	it("stops receiving events after dispose", () => {
		const t = makeTracker();
		t.dispose();
		t.emit({ type: "turn_start" });
		expect(t.activities()).toEqual([]);
	});
});

describe("readBashApprovalMode", () => {
	it("defaults to ask", () => {
		expect(readBashApprovalMode([])).toBe("ask");
		expect(readBashApprovalMode([{ type: "user", content: "x" }])).toBe("ask");
	});

	it("reads the persisted mode from codepi-bash custom entries", () => {
		const branch = [
			{ type: "user", content: "run this" },
			{
				type: "custom",
				customType: "codepi-bash:mode",
				data: { mode: "auto", timestamp: 1 },
			},
		];
		expect(readBashApprovalMode(branch)).toBe("auto");
	});

	it("last matching entry wins and other custom types are ignored", () => {
		const branch = [
			{ type: "custom", customType: "other:thing", data: { mode: "auto" } },
			{
				type: "custom",
				customType: "codepi-bash:mode",
				data: { mode: "auto" },
			},
			{
				type: "custom",
				customType: "codepi-bash:mode",
				data: { mode: "ask" },
			},
		];
		expect(readBashApprovalMode(branch)).toBe("ask");
	});
});
