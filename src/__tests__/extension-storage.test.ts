import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function normalizeWhitespace(source: string): string {
	return source.replace(/\s+/g, " ");
}

function countMatches(source: string, pattern: RegExp): number {
	return [...source.matchAll(pattern)].length;
}

/**
 * These source-level assertions protect the session storage contract without
 * importing the VS Code extension host into Vitest.
 */
describe("CodePi session storage routing", () => {
	it("passes an explicit session directory to every persistent SessionManager call", () => {
		const extension = normalizeWhitespace(
			readFileSync(join(process.cwd(), "src", "extension.ts"), "utf8"),
		);
		const tree = normalizeWhitespace(
			readFileSync(
				join(process.cwd(), "src", "views", "sessions-view.ts"),
				"utf8",
			),
		);
		const runtimeDir = String.raw`getCodePiSessionDirForRuntime\s*\(\s*\)`;

		expect(countMatches(extension, /SessionManager\.create\s*\(/g)).toBe(1);
		expect(
			countMatches(
				extension,
				new RegExp(
					String.raw`SessionManager\.create\s*\([^;]*?workspaceRoot[^;]*?${runtimeDir}[^;]*?\)`,
					"g",
				),
			),
		).toBe(1);

		expect(countMatches(extension, /SessionManager\.open\s*\(/g)).toBe(2);
		expect(
			countMatches(
				extension,
				new RegExp(
					String.raw`SessionManager\.open\s*\([^;]*?sessionPath[^;]*?${runtimeDir}[^;]*?(?:workspaceRoot|getWorkspaceRoot\s*\(\s*\))[^;]*?\)`,
					"g",
				),
			),
		).toBe(2);

		expect(countMatches(extension, /SessionManager\.list\s*\(/g)).toBe(2);
		expect(
			countMatches(
				extension,
				new RegExp(
					String.raw`SessionManager\.list\s*\([^;]*?(?:workspaceRoot|getWorkspaceRoot\s*\(\s*\))[^;]*?${runtimeDir}[^;]*?\)`,
					"g",
				),
			),
		).toBe(2);

		expect(countMatches(extension, /SessionManager\.listAll\s*\(/g)).toBe(1);
		expect(
			countMatches(
				extension,
				new RegExp(
					String.raw`SessionManager\.listAll\s*\([^;]*?${runtimeDir}[^;]*?\)`,
					"g",
				),
			),
		).toBe(1);

		expect(countMatches(tree, /SessionManager\.open\s*\(/g)).toBe(1);
		expect(
			countMatches(
				tree,
				/SessionManager\.open\s*\(\s*sessionPath\s*,\s*this\.sessionDir\s*,?\s*\)/g,
			),
		).toBe(1);
		expect(countMatches(tree, /SessionManager\.list\s*\(/g)).toBe(1);
		expect(
			countMatches(
				tree,
				/SessionManager\.list\s*\(\s*(?:this\.)?cwd\s*,\s*this\.sessionDir\s*,?\s*\)/g,
			),
		).toBe(1);
	});
});
