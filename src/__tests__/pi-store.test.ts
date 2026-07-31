import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	detectLegacyConfig,
	getAgentDir,
	importLegacyConfig,
	readJsonFile,
	setAgentDir,
	writeJsonFileAtomic,
} from "../pi-store";

let dir: string;
beforeEach(() => {
	dir = join(tmpdir(), `codepi-pistore-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("detectLegacyConfig", () => {
	it("undefined when empty", () => {
		expect(detectLegacyConfig(dir)).toBeUndefined();
	});
	it("detects each file", () => {
		writeFileSync(join(dir, "settings.json"), "{}");
		expect(detectLegacyConfig(dir)).toEqual({ settings: true, auth: false, models: false });
	});
});

describe("importLegacyConfig", () => {
	it("copies config files and keeps auth 0o600", () => {
		const legacy = join(dir, "legacy");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"theme":"dark"}');
		writeFileSync(join(legacy, "auth.json"), '{"openai":{"type":"api_key","key":"sk-x"}}', { mode: 0o600 });
		const target = join(dir, "target");
		mkdirSync(target, { recursive: true });
		const res = importLegacyConfig(legacy, target, { includeSessions: false });
		expect(res.imported).toContain("settings.json");
		expect(res.imported).toContain("auth.json");
		expect(JSON.parse(readFileSync(join(target, "settings.json"), "utf8"))).toEqual({ theme: "dark" });
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
