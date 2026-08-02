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
	detectLegacyConfig,
	ensureDefaultTheme,
	ensureRuntimeTools,
	getAgentDir,
	importLegacyConfig,
	ensurePiJsonFileInDir,
	readJsonFile,
	setAgentDir,
	updateBundledResourceConfig,
	writeCodePiSettingsMerge,
	writeJsonFileAtomic,
} from "../pi-store";
import { DEFAULT_THEME } from "../pi-store";

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
			bundledExtensions: { "custom-footer": false, filechanges: true },
			bundledThemes: { "nebula-pulse": true },
		});

		expect(readJsonFile(settingsPath)).toEqual({
			packages: ["npm:existing"],
			defaultModel: "gpt-5",
			unknownFutureKey: { enabled: true },
			codepi: {
				bundledExtensions: { "custom-footer": false, filechanges: true },
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
			bundledExtensions: { "custom-footer": true, filechanges: false },
			bundledThemes: { "nebula-pulse": false },
		});
		expect(readJsonFile(settingsPath)).toEqual({
			codepi: {
				futureOption: { enabled: true },
				bundledExtensions: { "custom-footer": true, filechanges: false },
				bundledThemes: { "nebula-pulse": false },
			},
		});
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
				bundledExtensions: { "custom-footer": false, filechanges: true },
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

describe("importLegacyConfig", () => {
	it("copies config files and keeps auth 0o600", () => {
		const legacy = join(dir, "legacy");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"theme":"dark"}');
		writeFileSync(
			join(legacy, "auth.json"),
			'{"openai":{"type":"api_key","key":"sk-x"}}',
			{ mode: 0o600 },
		);
		const target = join(dir, "target");
		mkdirSync(target, { recursive: true });
		const res = importLegacyConfig(legacy, target, { includeSessions: false });
		expect(res.imported).toContain("settings.json");
		expect(res.imported).toContain("auth.json");
		let parsedSettings: unknown;
		try {
			parsedSettings = JSON.parse(
				readFileSync(join(target, "settings.json"), "utf8"),
			);
		} catch {
			parsedSettings = undefined;
		}
		expect(parsedSettings).toEqual({ theme: "dark" });
		const mode = statSync(join(target, "auth.json")).mode;
		expect(mode & 0o777).toBe(0o600);
	});
	it("copies sessions when requested", () => {
		const legacy = join(dir, "legacy");
		const sessions = join(legacy, "sessions", "proj");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "abc.json"), "{}");
		const target = join(dir, "target");
		mkdirSync(target, { recursive: true });
		importLegacyConfig(legacy, target, { includeSessions: true });
		expect(existsSync(join(target, "sessions", "proj", "abc.json"))).toBe(true);
	});
	it("skips sessions when not requested", () => {
		const legacy = join(dir, "legacy");
		mkdirSync(join(legacy, "sessions", "proj"), { recursive: true });
		writeFileSync(join(legacy, "sessions", "proj", "abc.json"), "{}");
		const target = join(dir, "target");
		mkdirSync(target, { recursive: true });
		importLegacyConfig(legacy, target, { includeSessions: false });
		expect(existsSync(join(target, "sessions"))).toBe(false);
	});
});

describe("ensureDefaultTheme", () => {
	it("writes the default theme when settings.json is missing", () => {
		setAgentDir(dir);
		ensureDefaultTheme();
		const settings = readJsonFile<Record<string, unknown>>(
			join(dir, "settings.json"),
		);
		expect(settings?.theme).toBe(DEFAULT_THEME);
	});
	it("adds the theme to existing settings without clobbering other keys", () => {
		setAgentDir(dir);
		writeJsonFileAtomic(join(dir, "settings.json"), {
			defaultModel: "claude-sonnet-4",
		});
		ensureDefaultTheme();
		const settings = readJsonFile<Record<string, unknown>>(
			join(dir, "settings.json"),
		);
		expect(settings?.theme).toBe(DEFAULT_THEME);
		expect(settings?.defaultModel).toBe("claude-sonnet-4");
	});
	it("respects an explicitly chosen theme", () => {
		setAgentDir(dir);
		writeJsonFileAtomic(join(dir, "settings.json"), {
			theme: "tokyo-night",
		});
		ensureDefaultTheme();
		const settings = readJsonFile<Record<string, unknown>>(
			join(dir, "settings.json"),
		);
		expect(settings?.theme).toBe("tokyo-night");
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
