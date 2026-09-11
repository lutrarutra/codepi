import { describe, expect, it, vi } from "vitest";
import {
	createActivityBridge,
	createSessionActivityTracker,
	readBashApprovalMode,
	type ActivityEvent,
	type SessionActivity,
	type UIPromptEvent,
	type UIPromptEventSource,
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
		/** The externally-fed path (used by the activity bridge). */
		push: tracker.emit,
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

	it("marks extension UI dialogs (safety-guard permission) as waiting even in bash auto mode", () => {
		// The exact reported case: bash auto-approve is on, so tool_execution_start
		// stays "working" — but safety-guard opens its "Allow this action?" dialog
		// inside the tool_call hook, which must flip the icon to waiting.
		const auto = makeTracker(() => "auto");
		auto.emit({ type: "turn_start" });
		auto.emit({ type: "tool_execution_start", toolName: "bash" });
		auto.emit({ type: "extension_ui_start" });
		auto.emit({ type: "extension_ui_end" });
		auto.emit({ type: "tool_execution_end", toolName: "bash" });
		auto.emit({ type: "agent_end" });
		expect(auto.activities()).toEqual([
			"working",
			"waiting",
			"working",
			"idle",
		]);
	});

	it("does not flip to waiting for extension dialogs while idle (slash commands)", () => {
		const t = makeTracker();
		t.emit({ type: "extension_ui_start" });
		t.emit({ type: "extension_ui_end" });
		expect(t.activities()).toEqual([]);
	});

	it("keeps waiting while an input tool and an extension dialog overlap", () => {
		const t = makeTracker();
		t.emit({ type: "tool_execution_start", toolName: "ask_user_question" });
		t.emit({ type: "extension_ui_start" });
		t.emit({ type: "extension_ui_end" });
		t.emit({ type: "tool_execution_end", toolName: "ask_user_question" });
		expect(t.activities()).toEqual(["waiting", "working"]);
	});

	it("stays waiting across nested dialogs (approve → Revise…)", () => {
		const t = makeTracker(() => "ask");
		t.emit({ type: "turn_start" });
		t.emit({ type: "tool_execution_start", toolName: "bash" });
		t.emit({ type: "extension_ui_start" }); // approval dialog
		t.emit({ type: "extension_ui_end" }); // picked "Revise…"
		t.emit({ type: "extension_ui_start" }); // revision input
		t.emit({ type: "extension_ui_end" });
		t.emit({ type: "tool_execution_end", toolName: "bash" });
		expect(t.activities()).toEqual(["working", "waiting", "working"]);
	});

	it("accepts externally-fed dialog events via emit() (activity bridge)", () => {
		// The session event stream does not carry dialog events; pi's ui_prompt
		// events reach the host through the bridge and tracker.emit, which
		// shares the same state machine as session events.
		const t = makeTracker();
		t.emit({ type: "turn_start" });
		t.push({ type: "extension_ui_start", ui: "custom" });
		t.push({ type: "extension_ui_end", ui: "custom" });
		expect(t.activities()).toEqual(["working", "waiting", "working"]);
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

describe("createActivityBridge", () => {
	/** Minimal fake ExtensionAPI capturing the registered handlers. */
	function makePiStub() {
		const handlers = new Map<string, (event: UIPromptEvent) => void>();
		const pi: UIPromptEventSource = {
			on: (event, handler) => {
				handlers.set(event, handler);
			},
		};
		return {
			pi,
			fire: (event: string, payload: UIPromptEvent) =>
				handlers.get(event)?.(payload),
		};
	}

	it("maps ui_prompt_start/end onto the tracker event vocabulary", () => {
		const events: ActivityEvent[] = [];
		const stub = makePiStub();
		createActivityBridge((event) => events.push(event))(stub.pi);
		stub.fire("ui_prompt_start", { kind: "custom", title: "Review changes" });
		stub.fire("ui_prompt_end", { kind: "custom" });
		expect(events).toEqual([
			{ type: "extension_ui_start", ui: "custom", title: "Review changes" },
			{ type: "extension_ui_end", ui: "custom" },
		]);
	});

	it("drives the indicator for dialog kinds the old patch never covered", () => {
		// editor/custom have no bundled call sites, so the patched
		// interactive-mode hooks could not see them; upstream's ui_prompt
		// events cover every ctx.ui.* kind.
		const t = makeTracker();
		const stub = makePiStub();
		createActivityBridge(t.push)(stub.pi);
		t.emit({ type: "turn_start" });
		stub.fire("ui_prompt_start", { kind: "editor" });
		stub.fire("ui_prompt_end", { kind: "editor" });
		expect(t.activities()).toEqual(["working", "waiting", "working"]);
	});
});
