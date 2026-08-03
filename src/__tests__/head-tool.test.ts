/**
 * Tests for src/tools/index.ts — the `head` tool (read first N lines of a
 * file). Pure-JS implementation, so it must work without any OS binary.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const files = new Map<string, string>();
const mockVscode = vi.hoisted(() => ({
	Uri: {
		file: (p: string) => ({ fsPath: p, scheme: "file", path: p }),
		joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
			fsPath: [base.fsPath, ...parts].join("/"),
		}),
		parse: (s: string) => ({ fsPath: s, scheme: "file", path: s }),
	},
	workspace: {
		workspaceFolders: [],
		fs: {
			readFile: vi.fn(async (uri: { fsPath: string }) => {
				const text = files.get(uri.fsPath);
				if (text === undefined) {
					throw new Error(`ENOENT: ${uri.fsPath}`);
				}
				return new TextEncoder().encode(text);
			}),
		},
	},
}));
vi.mock("vscode", () => ({ default: mockVscode, ...mockVscode }));

import { headTool, createVscodeTools } from "../tools/index";

function lines(n: number): string {
	return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
}

function textOf(result: any): string {
	return result.content[0].text as string;
}

async function runHead(path: string, params: Record<string, unknown> = {}) {
	return headTool.execute("head-test", { path, ...params });
}

beforeEach(() => {
	files.clear();
});

describe("headTool", () => {
	it("is named head and documents its default/cap in the schema", () => {
		expect(headTool.name).toBe("head");
		expect(headTool.label).toBe("Head");
		expect(headTool.description).toContain("default 10");
		expect(headTool.description.toLowerCase()).toContain("all platforms");
		const props = (headTool.parameters as any).properties;
		expect(props.path).toBeDefined();
		expect(props.lines.description).toContain("default: 10");
		expect(props.lines.description).toContain("max: 1000");
		expect((headTool.parameters as any).required).toEqual(["path"]);
	});

	it("is registered in the tool list right after read", () => {
		const tools = createVscodeTools({} as any);
		const names = tools.map((t) => t.name);
		expect(names).toContain("head");
		expect(names.indexOf("head")).toBe(names.indexOf("read") + 1);
	});

	it("reads the first 10 lines by default (Unix head default)", async () => {
		files.set("/tmp/head-default.txt", lines(20));
		const result = await runHead("/tmp/head-default.txt");
		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toBe(lines(10));
		expect(result.details).toMatchObject({ linesRead: 10, totalLines: 20 });
	});

	it("respects an explicit lines parameter", async () => {
		files.set("/tmp/head-three.txt", lines(12));
		const result = await runHead("/tmp/head-three.txt", { lines: 3 });
		expect(textOf(result)).toBe(lines(3));
		expect(result.details.linesRead).toBe(3);
	});

	it("caps oversized requests at 1000 lines", async () => {
		files.set("/tmp/head-cap.txt", lines(1500));
		const result = await runHead("/tmp/head-cap.txt", { lines: 5000 });
		expect(textOf(result)).toBe(lines(1000));
		expect(result.details.linesRead).toBe(1000);
		expect(result.details.totalLines).toBe(1500);
	});

	it("clamps zero/negative/float line counts to sane values", async () => {
		files.set("/tmp/head-clamp.txt", lines(5));
		expect(textOf(await runHead("/tmp/head-clamp.txt", { lines: 0 }))).toBe(
			lines(1),
		);
		expect(textOf(await runHead("/tmp/head-clamp.txt", { lines: -7 }))).toBe(
			lines(1),
		);
		expect(textOf(await runHead("/tmp/head-clamp.txt", { lines: 2.9 }))).toBe(
			lines(2),
		);
	});

	it("works on files without a trailing newline", async () => {
		files.set("/tmp/head-no-newline.txt", "a\nb\nc");
		expect(textOf(await runHead("/tmp/head-no-newline.txt", { lines: 2 }))).toBe(
			"a\nb",
		);
	});

	it("returns an error for missing files", async () => {
		const result = await runHead("/tmp/head-missing.txt");
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("File not found: /tmp/head-missing.txt");
	});
});
