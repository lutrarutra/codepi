import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	BUNDLED_RESOURCES,
	getCanonicalAgentDir,
	getCodePiSessionDir,
	isBashExtensionEnabled,
	readBundledResourceConfig,
} from "../pi-store";

describe("canonical Pi and CodePi paths", () => {
	it("uses the executing computer's ~/.pi/agent as the canonical agent dir", () => {
		expect(getCanonicalAgentDir()).toBe(join(homedir(), ".pi", "agent"));
	});

	it("keeps CodePi sessions below VS Code global storage", () => {
		expect(getCodePiSessionDir("/vscode/codepi")).toBe(
			"/vscode/codepi/sessions",
		);
	});
});

describe("bundled resource policy", () => {
	it("declares stable metadata for every CodePi bundled resource", () => {
		expect(BUNDLED_RESOURCES).toEqual([
			{
				id: "codepi-footer",
				label: "Custom footer",
				kind: "extension",
				enabledByDefault: true,
			},
			{
				id: "codepi-diff",
				label: "File changes",
				kind: "extension",
				enabledByDefault: true,
			},
			{
				id: "codepi-modes",
				label: "Agent modes (Ask / Plan / Implement)",
				kind: "extension",
				enabledByDefault: true,
			},
			{
				id: "codepi-bash",
				label: "Bash tool (VS Code terminal + approval)",
				kind: "extension",
				enabledByDefault: true,
			},
			{
				id: "codepi-context",
				label: "Editor context (snapshot + tools)",
				kind: "extension",
				enabledByDefault: true,
			},
			{
				id: "codepi-task",
				label: "Project tasks (.pi/tasks.json)",
				kind: "extension",
				enabledByDefault: true,
			},
			{
				id: "nebula-pulse",
				label: "Nebula Pulse theme",
				kind: "theme",
				enabledByDefault: true,
			},
		]);
	});

	it("enables every bundled resource when codepi settings are absent", () => {
		expect(readBundledResourceConfig({})).toEqual({
			bundledExtensions: {
				"codepi-footer": true,
				"codepi-diff": true,
				"codepi-modes": true,
				"codepi-bash": true,
				"codepi-context": true,
				"codepi-task": true,
			},
			bundledThemes: { "nebula-pulse": true },
		});
	});

	it("honors explicit false values and ignores malformed values safely", () => {
		expect(
			readBundledResourceConfig({
				codepi: {
					bundledExtensions: { "codepi-footer": false },
					bundledThemes: { "nebula-pulse": "off" },
				},
			}),
		).toEqual({
			bundledExtensions: {
				"codepi-footer": false,
				"codepi-diff": true,
				"codepi-modes": true,
				"codepi-bash": true,
				"codepi-context": true,
				"codepi-task": true,
			},
			bundledThemes: { "nebula-pulse": true },
		});
	});

	it("reports whether the codepi-bash extension is enabled (default true)", () => {
		expect(isBashExtensionEnabled({})).toBe(true);
		expect(
			isBashExtensionEnabled({
				codepi: { bundledExtensions: { "codepi-bash": false } },
			}),
		).toBe(false);
	});
});
