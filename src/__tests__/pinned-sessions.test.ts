import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	readPinnedSessionPaths,
	removePinnedSessionPath,
	setSessionPinned,
} from "../pinned-sessions";

let dir: string;
beforeEach(() => {
	dir = join(
		tmpdir(),
		`codepi-pinned-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const store = () => join(dir, "pinned.json");
const writeStore = (value: unknown): void => {
	writeFileSync(store(), JSON.stringify(value), "utf8");
};

describe("pinned sessions store", () => {
	it("reads an empty list when the store is missing", () => {
		expect(readPinnedSessionPaths(store())).toEqual([]);
	});

	it("round-trips pinning a session", () => {
		const path = "/sessions/abc.jsonl";
		expect(setSessionPinned(store(), path, true)).toEqual([path]);
		expect(readPinnedSessionPaths(store())).toEqual([path]);
		expect(JSON.parse(readFileSync(store(), "utf8"))).toEqual([path]);
	});

	it("unpins a pinned session", () => {
		const path = "/sessions/abc.jsonl";
		setSessionPinned(store(), path, true);
		expect(setSessionPinned(store(), path, false)).toEqual([]);
		expect(readPinnedSessionPaths(store())).toEqual([]);
	});

	it("does not create the store when unpinning a never-pinned session", () => {
		setSessionPinned(store(), "/sessions/abc.jsonl", false);
		expect(existsSync(store())).toBe(false);
	});

	it("keeps earlier pins when pinning more sessions", () => {
		setSessionPinned(store(), "/sessions/a.jsonl", true);
		setSessionPinned(store(), "/sessions/b.jsonl", true);
		expect(readPinnedSessionPaths(store())).toEqual([
			"/sessions/a.jsonl",
			"/sessions/b.jsonl",
		]);
	});

	it("is a no-op when the state is already as requested", () => {
		const path = "/sessions/abc.jsonl";
		setSessionPinned(store(), path, true);
		const before = readFileSync(store(), "utf8");
		const again = setSessionPinned(store(), path, true);
		expect(again).toEqual([path]);
		expect(readFileSync(store(), "utf8")).toBe(before);
	});

	it("dedupes duplicate paths on read", () => {
		writeStore(["/sessions/a.jsonl", "/sessions/a.jsonl", "/sessions/b.jsonl"]);
		expect(readPinnedSessionPaths(store())).toEqual([
			"/sessions/a.jsonl",
			"/sessions/b.jsonl",
		]);
	});

	it("tolerates a malformed store", () => {
		writeFileSync(store(), "not json{", "utf8");
		expect(readPinnedSessionPaths(store())).toEqual([]);
		// The next write repairs the file.
		setSessionPinned(store(), "/sessions/a.jsonl", true);
		expect(readPinnedSessionPaths(store())).toEqual(["/sessions/a.jsonl"]);
	});

	it("ignores non-string entries", () => {
		writeStore(["/sessions/a.jsonl", 42, null, { path: "/x" }]);
		expect(readPinnedSessionPaths(store())).toEqual(["/sessions/a.jsonl"]);
	});

	it("removes a deleted session's pin", () => {
		setSessionPinned(store(), "/sessions/a.jsonl", true);
		setSessionPinned(store(), "/sessions/b.jsonl", true);
		removePinnedSessionPath(store(), "/sessions/a.jsonl");
		expect(readPinnedSessionPaths(store())).toEqual(["/sessions/b.jsonl"]);
	});

	it("does not touch the store when removing a never-pinned path", () => {
		removePinnedSessionPath(store(), "/sessions/abc.jsonl");
		expect(existsSync(store())).toBe(false);
		setSessionPinned(store(), "/sessions/a.jsonl", true);
		const before = readFileSync(store(), "utf8");
		removePinnedSessionPath(store(), "/sessions/unknown.jsonl");
		expect(readFileSync(store(), "utf8")).toBe(before);
	});
});
