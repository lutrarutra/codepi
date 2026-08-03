import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	ASK_MODE_DEFAULT_ALLOWED_TOOLS,
	ASK_MODE_DEFAULT_ALLOWED_TOOLS_PRE_CONTEXT,
	ASK_MODE_DEFAULT_ALLOWED_TOOLS_PRE_HEAD,
	detectLegacyConfig,
	ensureRuntimeTools,
	getAgentDir,
	getCodePiSessionDir,
	ensurePiJsonFileInDir,
	readAskModeAllowedTools,
	readJsonFile,
	readAutoVerifyMode,
	readTerminalPrefs,
	seedAskModeAllowedToolsIfMissing,
	setAgentDir,
	updateAskModeAllowedTools,
	updateAutoVerifyMode,
	updateBundledResourceConfig,
	updateTerminalPrefs,
	writeCodePiSettingsMerge,
	writeJsonFileAtomic,
} from "../pi-store";

let dir: string;
beforeEach(() => {
	dir = join(
		tmpdir(),
		`codepi-pistore-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("agent dir", () => {
	it("keeps CodePi sessions below VS Code global storage", () => {
		expect(getCodePiSessionDir(join(dir, "global"))).toBe(
			join(dir, "global", "sessions"),
		);
	});
	it("reads the env override", () => {
		process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
		expect(getAgentDir()).toBe(join(dir, "agent"));
	});
	it("setAgentDir writes the env override", () => {
		setAgentDir(join(dir, "a2"));
		expect(process.env.PI_CODING_AGENT_DIR).toBe(join(dir, "a2"));
	});
});

describe("readJsonFile / writeJsonFileAtomic", () => {
	it("returns undefined for missing files", () => {
		expect(readJsonFile(join(dir, "nope.json"))).toBeUndefined();
	});
	it("round-trips JSON", () => {
		const p = join(dir, "settings.json");
		writeJsonFileAtomic(p, { a: 1, b: [true] });
		expect(readJsonFile(p)).toEqual({ a: 1, b: [true] });
	});
	it("throws on malformed JSON", () => {
		const p = join(dir, "bad.json");
		writeFileSync(p, "{oops");
		expect(() => readJsonFile(p)).toThrow();
	});
	it("writes atomically (no tmp leftovers)", () => {
		const p = join(dir, "x.json");
		writeJsonFileAtomic(p, { v: 2 });
		const leftovers = readFileSync(p, "utf8");
		expect(leftovers).toContain('"v"');
		expect(
			existsSync(p + ".tmp") ||
				existsSync(p + ".tmp.json") ||
				readdirSync(dir).some((e) => e.includes(".tmp")),
		).toBe(false);
	});
});

describe("CodePi settings merge and Pi JSON files", () => {
	it("writes codepi toggles without clobbering Pi settings", () => {
		const settingsPath = join(dir, "settings.json");
		writeJsonFileAtomic(settingsPath, {
			packages: ["npm:existing"],
			defaultModel: "gpt-5",
			unknownFutureKey: { enabled: true },
		});

		updateBundledResourceConfig(settingsPath, {
			bundledExtensions: {
				"custom-footer": false,
				filechanges: true,
				"codepi-modes": true,
				"codepi-bash": true,
			"codepi-context": true,
			},
			bundledThemes: { "nebula-pulse": true },
		});

		expect(readJsonFile(settingsPath)).toEqual({
			packages: ["npm:existing"],
			defaultModel: "gpt-5",
			unknownFutureKey: { enabled: true },
			codepi: {
				bundledExtensions: {
					"custom-footer": false,
					filechanges: true,
					"codepi-modes": true,
					"codepi-bash": true,
				"codepi-context": true,
				},
				bundledThemes: { "nebula-pulse": true },
			},
		});
	});

	it("preserves unrelated keys inside an existing codepi namespace", () => {
		const settingsPath = join(dir, "settings.json");
		writeJsonFileAtomic(settingsPath, {
			codepi: { futureOption: { enabled: true } },
		});
		updateBundledResourceConfig(settingsPath, {
			bundledExtensions: {
				"custom-footer": true,
				filechanges: false,
				"codepi-modes": true,
				"codepi-bash": true,
			"codepi-context": true,
			},
			bundledThemes: { "nebula-pulse": false },
		});
		expect(readJsonFile(settingsPath)).toEqual({
			codepi: {
				futureOption: { enabled: true },
				bundledExtensions: {
					"custom-footer": true,
					filechanges: false,
					"codepi-modes": true,
					"codepi-bash": true,
				"codepi-context": true,
				},
				bundledThemes: { "nebula-pulse": false },
			},
		});
	});

	it("reads terminal prefs with defaults and clamps bad values", () => {
		expect(readTerminalPrefs(undefined)).toEqual({
			fontFamily: "FiraCode Nerd Font",
			fontSize: 14,
		});
		expect(readTerminalPrefs({})).toEqual({
			fontFamily: "FiraCode Nerd Font",
			fontSize: 14,
		});
		expect(readTerminalPrefs({ codepi: { other: 1 } })).toEqual({
			fontFamily: "FiraCode Nerd Font",
			fontSize: 14,
		});
		expect(
			readTerminalPrefs({
				codepi: {
					fontFamily: "  Menlo  ",
					fontSize: 18.6,
				},
			}),
		).toEqual({ fontFamily: "Menlo", fontSize: 19 });
		expect(
			readTerminalPrefs({
				codepi: { fontFamily: "", fontSize: 200 },
			}),
		).toEqual({ fontFamily: "FiraCode Nerd Font", fontSize: 40 });
		expect(
			readTerminalPrefs({
				codepi: { fontFamily: 42, fontSize: "14" },
			}),
		).toEqual({ fontFamily: "FiraCode Nerd Font", fontSize: 14 });
	});

	it("writes terminal prefs into the codepi namespace", () => {
		const settingsPath = join(dir, "settings.json");
		writeJsonFileAtomic(settingsPath, {
			defaultModel: "gpt-5",
			codepi: { bundledExtensions: { "custom-footer": true, filechanges: true } },
		});

		updateTerminalPrefs(settingsPath, { fontFamily: "JetBrains Mono", fontSize: 16 });

		expect(readJsonFile(settingsPath)).toEqual({
			defaultModel: "gpt-5",
			codepi: {
				bundledExtensions: { "custom-footer": true, filechanges: true },
				fontFamily: "JetBrains Mono",
				fontSize: 16,
			},
		});
		expect(readTerminalPrefs(readJsonFile(settingsPath))).toEqual({
			fontFamily: "JetBrains Mono",
			fontSize: 16,
		});
	});

	it("reads the auto-verify mode with a safe default", () => {
		expect(readAutoVerifyMode(undefined)).toBe("nextTurn");
		expect(readAutoVerifyMode({})).toBe("nextTurn");
		expect(readAutoVerifyMode({ codepi: { autoVerify: "followUp" } })).toBe(
			"followUp",
		);
		expect(readAutoVerifyMode({ codepi: { autoVerify: "off" } })).toBe("off");
		expect(readAutoVerifyMode({ codepi: { autoVerify: "aggressive" } })).toBe(
			"nextTurn",
		);
		expect(readAutoVerifyMode({ codepi: { autoVerify: 3 } })).toBe("nextTurn");
	});

	it("writes the auto-verify mode into the codepi namespace", () => {
		const settingsPath = join(dir, "settings.json");
		writeJsonFileAtomic(settingsPath, {
			codepi: { fontFamily: "Menlo", autoVerify: "nextTurn" },
		});

		updateAutoVerifyMode(settingsPath, "off");

		expect(readJsonFile(settingsPath)).toEqual({
			codepi: { fontFamily: "Menlo", autoVerify: "off" },
		});
		expect(readAutoVerifyMode(readJsonFile(settingsPath))).toBe("off");
	});

	it("reads ask-mode allowed tools, returning undefined when the block is missing", () => {
		expect(readAskModeAllowedTools(undefined)).toBeUndefined();
		expect(readAskModeAllowedTools({})).toBeUndefined();
		expect(readAskModeAllowedTools({ codepi: { modes: {} } })).toBeUndefined();
		expect(
			readAskModeAllowedTools({
				codepi: { modes: { ask: { allowedTools: ["web_search"] } } },
			}),
		).toEqual(["web_search"]);
	});

	it("validates ask-mode allowed tools entries defensively", () => {
		expect(
			readAskModeAllowedTools({
				codepi: { modes: { ask: { allowedTools: [42, "  ", "read", "read"] } } },
			}),
		).toEqual(["read"]);
		expect(
			readAskModeAllowedTools({
				codepi: { modes: { ask: { allowedTools: "nope" } } },
			}),
		).toBeUndefined();
		expect(
			readAskModeAllowedTools({
				codepi: { modes: { ask: { allowedTools: [] } } },
			}),
		).toEqual([]);
	});

	it("writes and seeds the ask-mode allowed tools", () => {
		const settingsPath = join(dir, "settings.json");
		writeJsonFileAtomic(settingsPath, {
			codepi: { autoVerify: "nextTurn" },
		});

		// Missing block → seed defaults.
		seedAskModeAllowedToolsIfMissing(settingsPath);
		const seeded = readJsonFile<Record<string, unknown>>(settingsPath);
		expect(
			readAskModeAllowedTools(seeded),
		).toEqual([...ASK_MODE_DEFAULT_ALLOWED_TOOLS]);
		expect(ASK_MODE_DEFAULT_ALLOWED_TOOLS).toContain("read");
		expect(ASK_MODE_DEFAULT_ALLOWED_TOOLS).toContain("grep");
		expect(ASK_MODE_DEFAULT_ALLOWED_TOOLS).toContain("web_search");
		expect(ASK_MODE_DEFAULT_ALLOWED_TOOLS).not.toContain("bash");

		// Seeding again is a no-op.
		seedAskModeAllowedToolsIfMissing(settingsPath);
		expect(
			readAskModeAllowedTools(readJsonFile(settingsPath)),
		).toEqual([...ASK_MODE_DEFAULT_ALLOWED_TOOLS]);

		// Update replaces the list and preserves unrelated codepi keys.
		updateAskModeAllowedTools(settingsPath, ["web_search"]);
		expect(readJsonFile(settingsPath)).toEqual({
			codepi: {
				autoVerify: "nextTurn",
				modes: { ask: { allowedTools: ["web_search"] } },
			},
		});
	});

	it("migrates the pre-context seeded allowlist to include the context tools", () => {
		const settingsPath = join(dir, "settings.json");
		// The old auto-seeded default (no context tools).
		writeJsonFileAtomic(settingsPath, {
			codepi: {
				modes: {
					ask: {
						allowedTools: [...ASK_MODE_DEFAULT_ALLOWED_TOOLS_PRE_CONTEXT],
					},
				},
			},
		});
		seedAskModeAllowedToolsIfMissing(settingsPath);
		expect(
			readAskModeAllowedTools(readJsonFile(settingsPath)),
		).toEqual([...ASK_MODE_DEFAULT_ALLOWED_TOOLS]);
		expect(ASK_MODE_DEFAULT_ALLOWED_TOOLS).toContain("get_editor_context");
		expect(ASK_MODE_DEFAULT_ALLOWED_TOOLS).toContain("get_git_diff");
	});

	it("migrates the pre-head seeded allowlist to include head", () => {
		const settingsPath = join(dir, "settings.json");
		// The auto-seeded default before `head` was added (has context tools,
		// but no head).
		writeJsonFileAtomic(settingsPath, {
			codepi: {
				modes: {
					ask: {
						allowedTools: [...ASK_MODE_DEFAULT_ALLOWED_TOOLS_PRE_HEAD],
					},
				},
			},
		});
		seedAskModeAllowedToolsIfMissing(settingsPath);
		expect(
			readAskModeAllowedTools(readJsonFile(settingsPath)),
		).toEqual([...ASK_MODE_DEFAULT_ALLOWED_TOOLS]);
		expect(ASK_MODE_DEFAULT_ALLOWED_TOOLS).toContain("head");
	});

	it("leaves a user-customized allowlist untouched", () => {
		const settingsPath = join(dir, "settings.json");
		writeJsonFileAtomic(settingsPath, {
			codepi: {
				modes: {
					ask: { allowedTools: ["read", "web_search"] },
				},
			},
		});
		seedAskModeAllowedToolsIfMissing(settingsPath);
		expect(
			readAskModeAllowedTools(readJsonFile(settingsPath)),
		).toEqual(["read", "web_search"]);
	});

	it("creates missing settings and models files as objects", () => {
		expect(readJsonFile(ensurePiJsonFileInDir(dir, "settings"))).toEqual({});
		expect(readJsonFile(ensurePiJsonFileInDir(dir, "models"))).toEqual({});
	});

	it("creates auth.json with owner-only permissions", () => {
		const authPath = ensurePiJsonFileInDir(dir, "auth");
		expect(readJsonFile(authPath)).toEqual({});
		expect(statSync(authPath).mode & 0o777).toBe(0o600);
	});

	it("does not overwrite malformed settings", () => {
		const settingsPath = join(dir, "settings.json");
		writeFileSync(settingsPath, "{oops");
		expect(() =>
			updateBundledResourceConfig(settingsPath, {
				bundledExtensions: {
					"custom-footer": false,
					filechanges: true,
					"codepi-modes": true,
					"codepi-bash": true,
				"codepi-context": true,
				},
				bundledThemes: { "nebula-pulse": true },
			}),
		).toThrow(/Failed to parse/);
		expect(readFileSync(settingsPath, "utf8")).toBe("{oops");
	});

	it("re-reads after a concurrent writer and preserves its latest keys", () => {
		const settingsPath = join(dir, "settings.json");
		writeJsonFileAtomic(settingsPath, { before: true });
		let injected = false;
		writeCodePiSettingsMerge(
			settingsPath,
			(settings) => ({ ...settings, updated: true }),
			{
				beforeWriteCheck: () => {
					if (injected) return;
					injected = true;
					writeJsonFileAtomic(settingsPath, {
						before: true,
						fromConcurrentWriter: true,
					});
				},
			},
		);
		expect(readJsonFile(settingsPath)).toEqual({
			before: true,
			fromConcurrentWriter: true,
			updated: true,
		});
	});
});

describe("detectLegacyConfig", () => {
	it("undefined when empty", () => {
		expect(detectLegacyConfig(dir)).toBeUndefined();
	});
	it("detects each file", () => {
		writeFileSync(join(dir, "settings.json"), "{}");
		expect(detectLegacyConfig(dir)).toEqual({
			settings: true,
			auth: false,
			models: false,
		});
	});
});

describe("ensureRuntimeTools", () => {
	it("seeds bin/rg from @vscode/ripgrep-universal and makes it executable", async () => {
		setAgentDir(dir);
		await ensureRuntimeTools(dir);
		const rg = join(dir, "bin", "rg");
		expect(existsSync(rg)).toBe(true);
		// executable bit set (mode & 0o111)
		expect(statSync(rg).mode & 0o111).not.toBe(0);
		// rg actually runs
		const { execFileSync } = await import("node:child_process");
		const out = execFileSync(rg, ["--version"]).toString();
		expect(out).toMatch(/ripgrep/i);
	});

	it("is idempotent — does not overwrite an existing rg binary", async () => {
		setAgentDir(dir);
		await ensureRuntimeTools(dir);
		const rgBefore = statSync(join(dir, "bin", "rg")).size;
		await ensureRuntimeTools(dir);
		expect(statSync(join(dir, "bin", "rg")).size).toBe(rgBefore);
	});

	it("copies fd from the actual legacy ~/.pi/agent/bin when present", async () => {
		setAgentDir(dir);
		const previousHome = process.env.HOME;
		const fakeHome = join(dir, "fake-home");
		process.env.HOME = fakeHome;
		try {
			const legacy = join(fakeHome, ".pi", "agent", "bin");
			mkdirSync(legacy, { recursive: true });
			const fakeFd = join(legacy, "fd");
			writeFileSync(fakeFd, "#!/bin/sh\necho fake fd\n", { mode: 0o755 });
			await ensureRuntimeTools(dir);
			const copiedFd = join(dir, "bin", "fd");
			expect(readFileSync(copiedFd, "utf8")).toContain("fake fd");
			expect(statSync(copiedFd).mode & 0o111).not.toBe(0);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});
});
