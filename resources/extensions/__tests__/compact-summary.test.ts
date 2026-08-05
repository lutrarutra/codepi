import { describe, expect, it } from "vitest";
// The pure compact-mode logic ships inside the pi dist patch (compact-summary).
// Deep import via relative path: the pi package's "exports" map only exposes
// "." and this module is not part of the public API surface.
import {
	aggregateCompactTurn,
	formatCompactDuration,
	formatTokenCount,
	groupTurnsForCompact,
	summarizeToolCall,
	type CompactSegment,
	CompactTurnSummary,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/compact-summary.js";

/** Assert a segment is a turn and narrow its type. */
function asTurn(segment: CompactSegment) {
	expect(segment.kind).toBe("turn");
	return segment as Extract<CompactSegment, { kind: "turn" }>;
}

function usage(overrides: Record<string, unknown> = {}) {
	return {
		input: 100,
		output: 200,
		reasoning: 50,
		cacheRead: 10,
		cacheWrite: 5,
		cost: { total: 0.12 },
		...overrides,
	};
}

describe("groupTurnsForCompact", () => {
	it("groups a user message with its assistant/tool messages", () => {
		const user = { role: "user", timestamp: 1 };
		const toolMsg = {
			role: "assistant",
			content: [
				{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
			],
		};
		const toolResult = {
			role: "toolResult",
			toolCallId: "1",
			toolName: "bash",
			isError: false,
			content: [],
		};
		const finalMsg = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
		};
		const segments = groupTurnsForCompact([
			user,
			toolMsg,
			toolResult,
			finalMsg,
		]);
		expect(segments).toHaveLength(1);
		const turn = asTurn(segments[0]);
		expect(turn.entries).toHaveLength(3);
		expect(turn.finalResponse).toBe(finalMsg);
	});

	it("collapses commentary that precedes more tool calls (no final response)", () => {
		const user = { role: "user" };
		const commentary = {
			role: "assistant",
			content: [{ type: "text", text: "Let me check" }],
		};
		const toolMsg = {
			role: "assistant",
			content: [
				{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
			],
		};
		const turn = asTurn(groupTurnsForCompact([user, commentary, toolMsg])[0]);
		expect(turn.finalResponse).toBeUndefined();
	});

	it("treats custom/branch-summary messages as standalone segments", () => {
		const user = { role: "user" };
		const custom = { role: "custom", customType: "x", display: "d" };
		const segments = groupTurnsForCompact([user, custom]);
		expect(segments).toHaveLength(2);
		expect(segments[0].kind).toBe("turn");
		expect(segments[1]).toEqual({ kind: "message", message: custom });
	});

	it("handles assistant messages without a preceding user message", () => {
		const finalMsg = {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
		};
		const segments = groupTurnsForCompact([finalMsg]);
		expect(segments).toHaveLength(1);
		expect(asTurn(segments[0]).userMessage).toBeUndefined();
		expect(asTurn(segments[0]).finalResponse).toBe(finalMsg);
	});
});

describe("aggregateCompactTurn", () => {
	it("sums usage, counts tools, picks the last model and activity", () => {
		const stats = aggregateCompactTurn([
			{
				role: "assistant",
				model: "model-a",
				usage: usage(),
				content: [
					{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "1",
				toolName: "bash",
				isError: true,
				content: [],
			},
			{
				role: "assistant",
				model: "model-b",
				usage: usage({ input: 50, cost: { total: 0.05 } }),
				content: [{ type: "thinking", thinking: "first thought line\nsecond" }],
			},
		]);
		expect(stats.input).toBe(150);
		expect(stats.output).toBe(400);
		expect(stats.reasoning).toBe(100);
		expect(stats.cost).toBeCloseTo(0.17);
		expect(stats.toolCalls).toBe(1);
		expect(stats.toolFailures).toBe(1);
		expect(stats.model).toBe("model-b");
		expect(stats.latest).toEqual({
			kind: "thought",
			text: "first thought line",
		});
	});

	it("returns zeroed stats for an empty turn", () => {
		const stats = aggregateCompactTurn([]);
		expect(stats).toEqual({
			input: 0,
			output: 0,
			reasoning: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			toolCalls: 0,
			toolFailures: 0,
			model: undefined,
			latest: undefined,
		});
	});
});

describe("CompactTurnSummary stats line", () => {
	function finishedSummary() {
		return new CompactTurnSummary(undefined, {
			stats: {
				input: 372_000,
				output: 4_100,
				reasoning: 1_200,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.05,
				toolCalls: 5,
				toolFailures: 4,
				model: "deepseek-v4-flash-2508",
				latest: undefined,
			},
			startTime: 0,
			endTime: 0,
			finished: true,
		});
	}

	it("renders the full model name without ellipsis truncation", () => {
		const text = finishedSummary().getStatsText();
		expect(text).toContain("deepseek-v4-flash-2508");
		expect(text).not.toContain("…");
	});

	it("renders every stats segment (tools, tokens, cost)", () => {
		const text = finishedSummary().getStatsText();
		expect(text).toContain("✓1");
		expect(text).toContain("✗4");
		expect(text).toContain("↑372k");
		expect(text).toContain("↓4.1k");
		expect(text).toContain("$0.05");
		expect(text).toContain(" tools");
	});

	it("renders thinking tokens as the font thought-bubble glyph plus a spaced count", () => {
		const text = finishedSummary().getStatsText();
		// md-thought-bubble (U+F07F6, surrogate pair \uDB81\uDDF6) from the
		// bundled Fira Code Nerd Font — a monochrome 1-cell glyph (unlike the
		// wide 🧠 emoji) so it cannot bleed into the token count; a space
		// keeps them clearly apart.
		expect(text).toContain("\uDB81\uDDF6 1.2k");
		expect(text).not.toContain("🧠");
	});

	it("keeps the stats summary on one terminal row when space is narrow", () => {
		const summary = finishedSummary();
		expect(summary.render(60)).toHaveLength(1);
		expect(summary.render(30)).toHaveLength(1);
		expect(summary.render(30)[0]).not.toContain("\n");
	});

	it("counts each tool call once despite repeated streaming updates", () => {
		const summary = new CompactTurnSummary(undefined);
		// message_update re-emits the whole message on every delta: the same
		// tool call id is reported many times before execution starts.
		summary.noteToolCall("bash", { command: "ls" }, "call-1");
		summary.noteToolCall("bash", { command: "ls" }, "call-1");
		summary.noteToolCall("bash", { command: "ls" }, "call-1");
		summary.noteToolCall("grep", { pattern: "x" }, "call-2");
		expect(summary.getStatsText()).toContain("…2");
		expect(summary.getStatsText()).not.toContain("…3");
	});

	it("decrements the running count when a tool execution ends", () => {
		const summary = new CompactTurnSummary(undefined);
		summary.noteToolCall("bash", { command: "ls" }, "call-1");
		summary.noteToolCall("grep", { pattern: "x" }, "call-2");
		summary.toolEnded("bash", false);
		expect(summary.getStatsText()).toContain("…1");
		expect(summary.getStatsText()).toContain("✓1");
		summary.toolEnded("grep", true);
		expect(summary.getStatsText()).not.toContain("…");
		expect(summary.getStatsText()).toContain("✗1");
	});

	it("hides the running count once the turn is finished", () => {
		const summary = new CompactTurnSummary(undefined);
		summary.noteToolCall("bash", { command: "ls" }, "call-1");
		summary.setFinished(false);
		expect(summary.getStatsText()).not.toContain("…");
	});
});

describe("formatters", () => {
	it("formats token counts like the footer", () => {
		expect(formatTokenCount(999)).toBe("999");
		expect(formatTokenCount(1234)).toBe("1.2k");
		expect(formatTokenCount(45678)).toBe("46k");
		expect(formatTokenCount(1234567)).toBe("1.2M");
	});

	it("formats durations", () => {
		expect(formatCompactDuration(0)).toBe("0s");
		expect(formatCompactDuration(32_000)).toBe("32s");
		expect(formatCompactDuration(65_000)).toBe("1m05s");
		expect(formatCompactDuration(7_320_000)).toBe("2h02m");
	});

	it("summarizes tool calls with a meaningful argument", () => {
		expect(summarizeToolCall("read", { path: "/a/b.ts", offset: 10 })).toBe(
			"read /a/b.ts",
		);
		expect(summarizeToolCall("bash", { command: "ls -la" })).toBe(
			"bash ls -la",
		);
		expect(summarizeToolCall("grep", { pattern: "foo", path: "src/" })).toBe(
			"grep foo",
		);
		expect(summarizeToolCall("edit", {})).toBe("edit");
	});
});
