import { describe, expect, it } from "vitest";
import type {
	ExtensionsMessage,
	ExtensionsReply,
	ExtensionsSnapshot,
} from "../shared/extensions-protocol";

describe("extensions protocol", () => {
	it("message union covers getSnapshot and refresh", () => {
		const msgs: ExtensionsMessage[] = [
			{ type: "getSnapshot" },
			{ type: "refresh" },
		];
		expect(msgs.map((m) => m.type)).toEqual(["getSnapshot", "refresh"]);
	});

	it("reply union covers snapshot and error", () => {
		const snapshot: ExtensionsSnapshot = {
			generatedAt: 0,
			cwd: "/cwd",
			agentDir: "/agent",
			mode: { active: false },
			askPolicy: { baseline: [], whitelisted: [] },
			extensions: [],
			core: { commands: [], tools: [] },
			loadErrors: [],
		};
		const replies: ExtensionsReply[] = [
			{ type: "snapshot", snapshot },
			{ type: "error", message: "boom" },
		];
		expect(replies.map((r) => r.type)).toEqual(["snapshot", "error"]);
	});

	it("snapshot round-trips through JSON without losing fields", () => {
		const snapshot: ExtensionsSnapshot = {
			generatedAt: 1,
			cwd: "/cwd",
			agentDir: "/agent",
			mode: { active: true, current: "ask", sessionName: "s1" },
			askPolicy: { baseline: ["read"], whitelisted: ["web_search"] },
			extensions: [
				{
					displayName: "codepi-bash",
					path: "/b/codepi-bash.ts",
					source: "bundled",
					enabled: true,
					commands: [{ name: "codepi-bash-allow", source: "extension" }],
					tools: [
						{
							name: "bash",
							label: "Bash",
							description: "d",
							askMode: "blocked",
						},
					],
					events: 2,
					flags: 0,
					shortcuts: 1,
					messageRenderers: 0,
				},
			],
			core: {
				commands: [{ name: "help", description: "h", source: "extension" }],
				tools: [
					{ name: "read", label: "Read", description: "r", askMode: "safe" },
				],
			},
			loadErrors: [{ path: "/bad.ts", error: "x" }],
		};
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
	});
});
