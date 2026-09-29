import { describe, expect, it } from "vitest";
import { SETTINGS_SCHEMA, validateSettings } from "../shared/pi-settings-schema";

describe("validateSettings", () => {
	it("accepts an empty object", () => {
		expect(validateSettings({})).toEqual([]);
	});

	it("accepts a full valid settings object", () => {
		const valid = {
			defaultProvider: "openai",
			defaultModel: "gpt-4o",
			defaultThinkingLevel: "high",
			steeringMode: "one-at-a-time",
			hideThinkingBlock: true,
			quietStartup: true,
			defaultProjectTrust: "ask",
			shellCommandPrefix: "set -e",
			editorPaddingX: 8,
			autocompleteMaxVisible: 5,
			compaction: { enabled: true, reserveTokens: 16000 },
			retry: { enabled: true, maxRetries: 3 },
			enabledModels: ["openai/gpt-4o", "anthropic/claude"],
			skills: ["/home/me/skills"],
		};
		expect(validateSettings(valid)).toEqual([]);
	});

	it("rejects wrong types with field paths", () => {
		const bad = {
			hideThinkingBlock: "yes",
			editorPaddingX: "eight",
			compaction: "x",
			defaultThinkingLevel: "insane",
		};
		const errors = validateSettings(bad);
		expect(errors.some((e) => e.startsWith("hideThinkingBlock"))).toBe(true);
		expect(errors.some((e) => e.startsWith("editorPaddingX"))).toBe(true);
		expect(errors.some((e) => e.startsWith("compaction"))).toBe(true);
		expect(errors.some((e) => e.startsWith("defaultThinkingLevel"))).toBe(true);
	});

	it("rejects null (was: silently accepted, clobbering settings.json)", () => {
		const errors = validateSettings(null);
		expect(errors.some((e) => e.startsWith("settings:"))).toBe(true);
	});

	it("rejects non-object values", () => {
		for (const bad of ["x", [1], 42, true]) {
			const errors = validateSettings(bad);
			expect(errors.some((e) => e.startsWith("settings:"))).toBe(true);
		}
	});

	it("rejects invalid string[] values with field path", () => {
		const errors = validateSettings({ skills: "not-an-array" });
		expect(errors.some((e) => e.startsWith("skills"))).toBe(true);
	});

	it("tolerates unknown keys (typos are not rejected)", () => {
		// validateSettings only checks known schema fields; unknown keys like
		// "defautlProvider" pass through silently. The extension-side JSON
		// editor relies on this leniency for forward compatibility.
		expect(validateSettings({ defautlProvider: "openai" })).toEqual([]);
	});

	it("covers every key of pi's Settings interface", () => {
		const keys = SETTINGS_SCHEMA.flatMap((s) => s.fields.map((f) => f.key));
		const expected = [
			"lastChangelogVersion", "defaultProvider", "defaultModel", "defaultThinkingLevel",
			"transport", "steeringMode", "followUpMode", "theme", "compaction",
			"branchSummary", "retry", "hideThinkingBlock", "shellPath", "quietStartup",
			"defaultProjectTrust", "shellCommandPrefix", "npmCommand", "collapseChangelog",
			"enableInstallTelemetry", "enableAnalytics", "trackingId", "packages",
			"extensions", "skills", "prompts", "themes", "enableSkillCommands",
			"terminal", "images", "enabledModels", "doubleEscapeAction",
			"treeFilterMode", "thinkingBudgets", "editorPaddingX",
			"autocompleteMaxVisible", "showHardwareCursor", "markdown", "warnings",
			"sessionDir", "httpProxy", "httpIdleTimeoutMs", "websocketConnectTimeoutMs",
			"cacheWarming",
		];
		for (const k of expected) {
			expect(keys).toContain(k);
		}
	});
});
