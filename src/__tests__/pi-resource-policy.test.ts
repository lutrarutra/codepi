import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	BUNDLED_RESOURCES,
	getCanonicalAgentDir,
	getCodePiSessionDir,
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
				id: "custom-footer",
				label: "Custom footer",
				kind: "extension",
				enabledByDefault: true,
			},
			{
				id: "filechanges",
				label: "File changes",
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
			bundledExtensions: { "custom-footer": true, filechanges: true },
			bundledThemes: { "nebula-pulse": true },
		});
	});

	it("honors explicit false values and ignores malformed values safely", () => {
		expect(
			readBundledResourceConfig({
				codepi: {
					bundledExtensions: { "custom-footer": false },
					bundledThemes: { "nebula-pulse": "off" },
				},
			}),
		).toEqual({
			bundledExtensions: { "custom-footer": false, filechanges: true },
			bundledThemes: { "nebula-pulse": true },
		});
	});
});
