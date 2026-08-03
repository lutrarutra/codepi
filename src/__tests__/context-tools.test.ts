/**
 * Tests for src/context-tools.ts — the host-side fallback definitions for the
 * codepi-context tools (used when the bundled extension fails to load).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mockVscode = vi.hoisted(() => {
	const state: any = {
		window: {},
		workspace: {},
		extensions: {},
		scm: {},
		debug: {},
		Uri: { file: (fsPath: string) => ({ fsPath }) },
	};
	return state;
});
vi.mock("vscode", () => ({ default: mockVscode, ...mockVscode }));

import { createHostContextTools } from "../context-tools";

let fixtureDir: string;
beforeEach(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "codepi-hosttools-"));
	Object.assign(mockVscode.window, {
		activeTextEditor: undefined,
		tabGroups: undefined,
		tabs: [],
		terminals: [],
		onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
	});
	Object.assign(mockVscode.workspace, {
		workspaceFolders: [],
		isTrusted: true,
		name: undefined,
	});
	mockVscode.extensions = { getExtension: () => undefined };
});
afterEach(() => {
	rmSync(fixtureDir, { recursive: true, force: true });
});

function textOf(result: any): string {
	return result.content[0].text as string;
}

describe("createHostContextTools", () => {
	it("returns both tools with matching names and schemas", () => {
		const tools = createHostContextTools();
		expect(tools.map((t) => t.name).sort()).toEqual([
			"get_editor_context",
			"get_git_diff",
		]);
		const editor = tools.find((t) => t.name === "get_editor_context")!;
		expect(editor.promptSnippet).toContain("VS Code editor state");
		expect(editor.promptGuidelines?.length).toBeGreaterThan(0);
		expect(editor.executionMode).toBe("sequential");
		const diff = tools.find((t) => t.name === "get_git_diff")!;
		expect(diff.parameters).toBeTruthy();
	});

	it("executes get_editor_context against the vscode mock", async () => {
		const foo = join(fixtureDir, "src", "foo.ts");
		Object.assign(mockVscode.window, {
			activeTextEditor: {
				document: {
					uri: { fsPath: foo },
					languageId: "typescript",
					lineCount: 120,
					isDirty: false,
					getText: () => "const x = 1;",
				},
				selection: {
					start: { line: 4, character: 0 },
					end: { line: 4, character: 12 },
					active: { line: 4, character: 12 },
					isEmpty: false,
				},
			},
			tabGroups: {
				activeTabGroup: { activeTab: { input: { uri: { fsPath: foo } } } },
			},
			tabs: [{ input: { uri: { fsPath: foo } }, isDirty: false }],
			terminals: [],
		});
		Object.assign(mockVscode.workspace, {
			workspaceFolders: [{ uri: { fsPath: fixtureDir } }],
			isTrusted: true,
		});

		const tools = createHostContextTools();
		const editor = tools.find((t) => t.name === "get_editor_context")!;
		const result = await editor.execute("1", {}, undefined, undefined, {
			cwd: fixtureDir,
		} as any);
		const text = textOf(result);
		expect(text).toContain("<editor_context>");
		expect(text).toContain("active: src/foo.ts [typescript]");
		expect(text).toContain("selection: src/foo.ts L5:1–L5:13 (1 line)");
		expect(text).toContain("selection_text: const x = 1;");
		expect(text).toContain("note: live editor state");
	});

	it("reports unavailable git in get_git_diff without throwing", async () => {
		Object.assign(mockVscode.window, {
			terminals: [],
			tabs: [],
		});
		Object.assign(mockVscode.workspace, {
			workspaceFolders: [{ uri: { fsPath: fixtureDir } }],
			isTrusted: true,
		});

		const tools = createHostContextTools();
		const diff = tools.find((t) => t.name === "get_git_diff")!;
		const result = await diff.execute("2", {}, undefined, undefined, {
			cwd: fixtureDir,
		} as any);
		expect(textOf(result)).toBe("(git unavailable)");
	});
});
