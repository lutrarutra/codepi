import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveTerminalFilePath } from "../tui/links";

describe("resolveTerminalFilePath", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepi-links-"));
	const cwd = path.join(root, "proj");
	const other = path.join(root, "other");
	for (const dir of [cwd, other, path.join(cwd, "src")]) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const fileA = path.join(cwd, "src", "foo.ts");
	const fileB = path.join(other, "bar.ts");
	fs.writeFileSync(fileA, "x");
	fs.writeFileSync(fileB, "x");

	it("resolves an absolute path as-is", () => {
		expect(resolveTerminalFilePath(fileA, cwd, [])).toBe(fileA);
	});

	it("resolves a relative path against the cwd", () => {
		expect(resolveTerminalFilePath("src/foo.ts", cwd, [])).toBe(fileA);
	});

	it("falls back to workspace folders", () => {
		expect(resolveTerminalFilePath("bar.ts", cwd, [other])).toBe(fileB);
	});

	it("strips a file:// prefix", () => {
		expect(resolveTerminalFilePath(`file://${fileA}`, cwd, [])).toBe(fileA);
	});

	it("returns undefined for a missing file", () => {
		expect(resolveTerminalFilePath("nope.ts", cwd, [])).toBeUndefined();
		expect(resolveTerminalFilePath("src/nope.ts", cwd, [])).toBeUndefined();
	});

	it("returns undefined for empty input", () => {
		expect(resolveTerminalFilePath("   ", cwd, [])).toBeUndefined();
	});

	it("handles trailing whitespace in the raw path", () => {
		expect(resolveTerminalFilePath("src/foo.ts ", cwd, [])).toBe(fileA);
	});
});
