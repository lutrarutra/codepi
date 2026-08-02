import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateLegacyCodePiStorage } from "../pi-store";

let root: string;
beforeEach(() => {
	root = join(tmpdir(), `codepi-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("migrateLegacyCodePiStorage", () => {
	it("copies only legacy config files missing from canonical storage", () => {
		const legacy = join(root, "legacy-agent");
		const canonical = join(root, "canonical-agent");
		const oldSessions = join(legacy, "sessions");
		const sessions = join(root, "global", "sessions");
		mkdirSync(oldSessions, { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"theme":"legacy"}');
		writeFileSync(join(legacy, "auth.json"), '{"token":"secret"}', { mode: 0o644 });
		writeFileSync(join(legacy, "models.json"), '{"model":"legacy"}');
		mkdirSync(canonical, { recursive: true });
		writeFileSync(join(canonical, "settings.json"), '{"theme":"canonical"}');

		const result = migrateLegacyCodePiStorage(legacy, canonical, oldSessions, sessions);

		expect(result.copiedFiles).toEqual(["auth.json", "models.json"]);
		expect(result.skippedFiles).toEqual(["settings.json"]);
		expect(readFileSync(join(canonical, "settings.json"), "utf8")).toContain("canonical");
		expect(statSync(join(canonical, "auth.json")).mode & 0o777).toBe(0o600);
	});

	it("is idempotent when invoked again with the same inputs", () => {
		const legacy = join(root, "legacy-agent");
		const canonical = join(root, "canonical-agent");
		const oldSessions = join(legacy, "sessions");
		const sessions = join(root, "global", "sessions");
		mkdirSync(oldSessions, { recursive: true });
		writeFileSync(join(legacy, "settings.json"), '{"theme":"legacy"}');
		writeFileSync(join(oldSessions, "old.json"), "old");

		const first = migrateLegacyCodePiStorage(
			legacy,
			canonical,
			oldSessions,
			sessions,
		);
		const canonicalSnapshot = readFileSync(
			join(canonical, "settings.json"),
			"utf8",
		);
		const sessionsSnapshot = readFileSync(join(sessions, "old.json"), "utf8");
		const second = migrateLegacyCodePiStorage(
			legacy,
			canonical,
			oldSessions,
			sessions,
		);

		expect(first.copiedFiles).toEqual(["settings.json"]);
		expect(first.copiedSessions).toEqual(["old.json"]);
		expect(second.copiedFiles).toEqual([]);
		expect(second.copiedSessions).toEqual([]);
		expect(second.skippedFiles).toEqual(["settings.json"]);
		expect(second.sessionsSkipped).toBe("destination-not-empty");
		expect(readFileSync(join(canonical, "settings.json"), "utf8")).toBe(
			canonicalSnapshot,
		);
		expect(readFileSync(join(sessions, "old.json"), "utf8")).toBe(
			sessionsSnapshot,
		);
	});

	it("copies old CodePi sessions without touching canonical Pi sessions", () => {
		const legacy = join(root, "legacy-agent");
		const canonical = join(root, "canonical-agent");
		const oldSessions = join(legacy, "sessions");
		const sessions = join(root, "global", "sessions");
		const piSessions = join(canonical, "sessions");
		mkdirSync(oldSessions, { recursive: true });
		mkdirSync(piSessions, { recursive: true });
		writeFileSync(join(oldSessions, "old.json"), "old");
		writeFileSync(join(piSessions, "sentinel.json"), "pi");

		const result = migrateLegacyCodePiStorage(legacy, canonical, oldSessions, sessions);

		expect(result.copiedSessions).toEqual(["old.json"]);
		expect(existsSync(join(sessions, "old.json"))).toBe(true);
		expect(readFileSync(join(piSessions, "sentinel.json"), "utf8")).toBe("pi");
		expect(readdirSync(piSessions)).toEqual(["sentinel.json"]);
	});

	it("does not overwrite a non-empty new CodePi session directory", () => {
		const legacy = join(root, "legacy-agent");
		const canonical = join(root, "canonical-agent");
		const oldSessions = join(legacy, "sessions");
		const sessions = join(root, "global", "sessions");
		mkdirSync(oldSessions, { recursive: true });
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(oldSessions, "old.json"), "old");
		writeFileSync(join(sessions, "current.json"), "current");

		const result = migrateLegacyCodePiStorage(legacy, canonical, oldSessions, sessions);

		expect(result.sessionsSkipped).toBe("destination-not-empty");
		expect(readdirSync(sessions)).toEqual(["current.json"]);
	});
});
