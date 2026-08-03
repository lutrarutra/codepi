import { describe, expect, it } from "vitest";
import {
	buildSnapshot,
	classifySource,
	computeAskMode,
	deriveDisplayName,
	modeFromSessionBranch,
	readAskAllowedToolsFromSettings,
} from "../extension-snapshot";

const ROOTS = {
	bundledDir: "/ext/codepi/resources/extensions",
	agentDir: "/home/u/.pi/agent",
	cwd: "/proj/app",
};

describe("classifySource", () => {
	it("classifies bundled, agent, project, and package paths", () => {
		expect(classifySource("/ext/codepi/resources/extensions/codepi-bash.ts", ROOTS)).toBe("bundled");
		expect(classifySource("/home/u/.pi/agent/extensions/safety-guard.ts", ROOTS)).toBe("agent");
		expect(classifySource("/proj/app/.pi/extensions/team-ext/index.ts", ROOTS)).toBe("project");
		expect(classifySource("/home/u/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo/index.ts", ROOTS)).toBe("package");
		expect(classifySource("/elsewhere/foo.ts", ROOTS)).toBe("other");
	});
});

describe("deriveDisplayName", () => {
	it("strips extensions and resolves npm package names", () => {
		expect(deriveDisplayName("/x/codepi-bash.ts")).toBe("codepi-bash");
		expect(deriveDisplayName("/x/team-ext/index.ts")).toBe("team-ext");
		expect(deriveDisplayName("/home/u/.pi/agent/npm/node_modules/@juicesharp/rpiv-todo/index.ts")).toBe("@juicesharp/rpiv-todo");
		expect(deriveDisplayName("/home/u/.pi/agent/npm/node_modules/plain-pkg/main.js")).toBe("plain-pkg");
	});
});

describe("computeAskMode", () => {
	const baseline = ["read", "grep"];
	it("marks whitelisted tools before baseline, then blocked", () => {
		expect(computeAskMode("web_search", baseline, new Set(["web_search"]))).toBe("whitelisted");
		expect(computeAskMode("read", baseline, new Set(["read"]))).toBe("whitelisted"); // whitelist wins
		expect(computeAskMode("read", baseline, new Set())).toBe("safe");
		expect(computeAskMode("bash", baseline, new Set())).toBe("blocked");
	});
});

describe("modeFromSessionBranch", () => {
	it("reads the latest codepi-modes:mode entry", () => {
		const branch = [
			{ type: "custom", customType: "codepi-modes:mode", data: { mode: "ask" } },
			{ type: "message", message: { role: "user" } },
			{ type: "custom", customType: "codepi-modes:mode", data: { mode: "implement" } },
		];
		expect(modeFromSessionBranch(branch)).toBe("implement");
		expect(modeFromSessionBranch([{ type: "custom", customType: "codepi-bash:mode", data: { mode: "auto" } }])).toBeUndefined();
		expect(modeFromSessionBranch([{ type: "message", message: { role: "user" } }])).toBeUndefined();
	});
});

describe("readAskAllowedToolsFromSettings", () => {
	it("reads codepi.modes.ask.allowedTools defensively", () => {
		expect(readAskAllowedToolsFromSettings({ codepi: { modes: { ask: { allowedTools: ["web_search"] } } } })).toEqual(["web_search"]);
		expect(readAskAllowedToolsFromSettings({ codepi: {} })).toEqual([]);
		expect(readAskAllowedToolsFromSettings({ codepi: { modes: { ask: { allowedTools: "nope" } } } })).toEqual([]);
		expect(readAskAllowedToolsFromSettings(null)).toEqual([]);
	});
});

describe("buildSnapshot", () => {
	it("maps extensions, core, chips, enabled flags, and load errors", () => {
		const snapshot = buildSnapshot({
			...ROOTS,
			settings: { codepi: { modes: { ask: { allowedTools: ["web_search"] } } } },
			mode: { active: true, current: "ask", sessionName: "s1" },
			extensions: [
				{
					resolvedPath: "/ext/codepi/resources/extensions/codepi-bash.ts",
					commands: new Map([["codepi-bash-allow", { name: "codepi-bash-allow", description: "Set mode" }]]),
					tools: new Map([["bash", { definition: { name: "bash", label: "Bash", description: "Run a command" } }]]),
					flags: new Map(),
					shortcuts: new Map([["ctrl+r", {}]]),
					handlers: new Map([["tool_call", [() => {}]], ["input", [() => {}]]]),
					messageRenderers: new Map(),
				},
				{
					resolvedPath: "/home/u/.pi/agent/extensions/safety-guard.ts",
					commands: new Map(),
					tools: new Map([["edit", { definition: { name: "edit", label: "Edit", description: "Edit file" } }]]),
					flags: new Map(), shortcuts: new Map(), handlers: new Map(), messageRenderers: new Map(),
				},
			],
			loadErrors: [{ path: "/home/u/.pi/agent/extensions/broken.ts", error: "SyntaxError: x" }],
			coreCommands: [
				{ name: "help", description: "Show help", source: "extension" },
				{ name: "skill:diagnose", description: "Diagnose", source: "skill" },
			],
			coreTools: [
				{ name: "read", label: "Read", description: "Read a file" },
				{ name: "bash", label: "Bash", description: "Run" },
			],
		});

		expect(snapshot.mode).toEqual({ active: true, current: "ask", sessionName: "s1" });
		expect(snapshot.askPolicy.whitelisted).toEqual(["web_search"]);

		const [bashExt, guardExt] = snapshot.extensions;
		expect(bashExt.displayName).toBe("codepi-bash");
		expect(bashExt.source).toBe("bundled");
		expect(bashExt.enabled).toBe(true);
		expect(bashExt.commands).toEqual([
			{ name: "codepi-bash-allow", description: "Set mode", source: "extension" },
		]);
		expect(bashExt.tools).toEqual([
			{ name: "bash", label: "Bash", description: "Run a command", askMode: "blocked" },
		]);
		expect(bashExt.events).toBe(2);
		expect(bashExt.shortcuts).toBe(1);
		expect(bashExt.flags).toBe(0);
		expect(bashExt.messageRenderers).toBe(0);

		expect(guardExt.source).toBe("agent");
		expect(guardExt.tools[0].askMode).toBe("blocked"); // edit is not read-only

		expect(snapshot.core.commands).toEqual([
			{ name: "help", description: "Show help", source: "extension" },
			{ name: "skill:diagnose", description: "Diagnose", source: "skill" },
		]);
		expect(snapshot.core.tools).toEqual([
			{ name: "read", label: "Read", description: "Read a file", askMode: "safe" },
			{ name: "bash", label: "Bash", description: "Run", askMode: "blocked" },
		]);
		expect(snapshot.loadErrors).toEqual([
			{ path: "/home/u/.pi/agent/extensions/broken.ts", error: "SyntaxError: x" },
		]);
	});

	it("honors the bundled settings toggle for enabled", () => {
		const snapshot = buildSnapshot({
			...ROOTS,
			settings: { codepi: { bundledExtensions: { "codepi-bash": false } } },
			mode: { active: false },
			extensions: [
				{
					resolvedPath: "/ext/codepi/resources/extensions/codepi-bash.ts",
					commands: new Map(), tools: new Map(),
					flags: new Map(), shortcuts: new Map(), handlers: new Map(), messageRenderers: new Map(),
				},
			],
			loadErrors: [],
			coreCommands: [],
			coreTools: [],
		});
		expect(snapshot.extensions[0].enabled).toBe(false);
	});

	it("produces a JSON-safe snapshot", () => {
		const snapshot = buildSnapshot({
			...ROOTS,
			settings: {},
			mode: { active: false },
			extensions: [
				{
					resolvedPath: "/ext/codepi/resources/extensions/codepi-footer.ts",
					commands: new Map(), tools: new Map(),
					flags: new Map(), shortcuts: new Map(), handlers: new Map(), messageRenderers: new Map(),
				},
			],
			loadErrors: [],
			coreCommands: [],
			coreTools: [],
		});
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
	});
});
