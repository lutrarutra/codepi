/**
 * Tests for resources/extensions/codepi-context.ts — the editor-context tools
 * (get_editor_context, get_git_diff) registered through the shared
 * `__codepiVscode` bridge.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import codepiContextFactory, {
	createContextToolDefinitions,
	getVscode,
} from "../codepi-context";
import {
	collectEditorContext,
	collectGitDiffs,
	formatContextSnapshot,
	formatLiveContext,
	getRecentFiles,
	trackContextEvents,
} from "../../../src/context-snapshot";

// ── Mock VS Code (bridge) ───────────────────────────────────

let fixtureDir: string;
beforeEach(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "codepi-context-ext-"));
	// Mirror the host: expose the context core on the shared global.
	(globalThis as any).__codepiContextCore = {
		collectEditorContext,
		collectGitDiffs,
		formatContextSnapshot,
		formatLiveContext,
		trackContextEvents,
		getRecentFiles,
	};
});
afterEach(() => {
	rmSync(fixtureDir, { recursive: true, force: true });
	delete (globalThis as any).__codepiVscode;
	delete (globalThis as any).__codepiContextCore;
});

type MockFile = {
	path: string;
	languageId?: string;
	lineCount?: number;
	isDirty?: boolean;
	content?: string;
};

function makeMockVscode(options: {
	folders?: string[];
	active?: MockFile;
	tabs?: Array<MockFile>;
	terminals?: string[];
	repos?: any[];
	scmInput?: string;
	debug?: { name: string; type: string } | null;
} = {}) {
	const { folders = [fixtureDir], active, tabs = [], terminals = [], repos = [], scmInput, debug = null } = options;
	const activeEditor = active
		? {
				document: {
					uri: { fsPath: active.path },
					languageId: active.languageId ?? "typescript",
					lineCount: active.lineCount ?? 120,
					isDirty: active.isDirty ?? false,
					getText: () => active.content ?? "const selected = 1;",
				},
				selection: {
					start: { line: 10, character: 3 },
					end: { line: 12, character: 7 },
					active: { line: 10, character: 3 },
					isEmpty: false,
				},
			}
		: undefined;
	const tabInputs = tabs.map((t) => ({ uri: { fsPath: t.path } }));
	const activeIndex = active ? tabs.findIndex((t) => t.path === active.path) : -1;
	const activeTabInput = activeIndex >= 0 ? tabInputs[activeIndex] : undefined;
	return {
		window: {
			activeTextEditor: activeEditor,
			tabGroups: { activeTabGroup: { activeTab: { input: activeTabInput } } },
			tabs: tabInputs.map((input, i) => ({ input, isDirty: tabs[i].isDirty ?? false })),
			terminals: terminals.map((name) => ({ name })),
			onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
		},
		workspace: {
			workspaceFolders: folders.map((f) => ({ uri: { fsPath: f } })),
			isTrusted: true,
			name: undefined,
		},
		extensions: {
			getExtension: (id: string) =>
				id === "vscode.git"
					? {
							exports: {
								getAPI: (version: number) => ({
									version,
									repositories: repos,
									getRepository: (uri: any) =>
										repos.find((r) => r.rootUri.fsPath === uri?.fsPath) ?? null,
								}),
							},
						}
					: undefined,
		},
		scm: { inputBox: { value: scmInput ?? "" } },
		debug: { activeDebugSession: debug },
		Uri: { file: (fsPath: string) => ({ fsPath }) },
	};
}

function makeRepo(root: string, overrides: Partial<any> = {}): any {
	const repo: any = {
		rootUri: { fsPath: root },
		state: {
			HEAD: { name: overrides.branch ?? "main", upstream: undefined, ahead: undefined, behind: undefined },
			workingTreeChanges: overrides.workingTreeChanges ?? [],
			indexChanges: overrides.indexChanges ?? [],
			untrackedChanges: overrides.untrackedChanges ?? [],
		},
		diffs: overrides.diffs ?? new Map(),
		shortStats: overrides.shortStats ?? new Map(),
		diffWithHEAD: async (path: string) => repo.diffs.get(path) ?? `(no diff for ${path})`,
		diffWithHEADShortStats: async (path: string) =>
			repo.shortStats.get(path) ?? { files: 0, insertions: 0, deletions: 0 },
	};
	return repo;
}

function createCtx() {
	return {
		cwd: fixtureDir,
		ui: {},
		sessionManager: {},
	} as any;
}

function textOf(result: any): string {
	return result.content[0].text as string;
}

// ── Tool definitions ────────────────────────────────────────

describe("createContextToolDefinitions", () => {
	it("registers both tools with schemas, snippets and guidelines", () => {
		const { get_editor_context, get_git_diff } = createContextToolDefinitions();
		expect(get_editor_context.name).toBe("get_editor_context");
		expect(get_git_diff.name).toBe("get_git_diff");
		expect(get_editor_context.promptSnippet).toContain("VS Code editor state");
		expect(get_editor_context.promptGuidelines?.length).toBeGreaterThan(0);
		expect(get_git_diff.description).toContain("unified diffs");
	});

	it("get_editor_context returns a live snapshot through the bridge", async () => {
		const repo = makeRepo(fixtureDir, {
			workingTreeChanges: [{ uri: { fsPath: join(fixtureDir, "src", "a.ts") }, status: 5 }],
			shortStats: new Map([["src/a.ts", { insertions: 2, deletions: 1 }]]),
		});
		const vscode = makeMockVscode({
			active: { path: join(fixtureDir, "src", "foo.ts") },
			tabs: [{ path: join(fixtureDir, "src", "foo.ts") }, { path: join(fixtureDir, "README.md") }],
			terminals: ["zsh"],
			repos: [repo],
			scmInput: "wip: context",
		});
		(globalThis as any).__codepiVscode = { vscode };
		const { get_editor_context } = createContextToolDefinitions();
		const result = await get_editor_context.execute("1", {}, undefined, undefined, createCtx());
		const text = textOf(result);
		expect(text).toContain("<editor_context>");
		expect(text).toContain("active: src/foo.ts [typescript]");
		expect(text).toContain("selection: src/foo.ts L11:4–L13:8 (3 lines)");
		expect(text).toContain("selection_text: const selected = 1;");
		expect(text).toContain("open(2): *src/foo.ts, README.md");
		expect(text).toContain("git: main — 1 changed: src/a.ts +2/−1");
		expect(text).toContain('scm_input: "wip: context"');
		expect(text).toContain("terminals: 1 (zsh)");
		expect(text).toContain("note: live editor state");
	});

	it("get_editor_context appends diffs when includeDiff is set", async () => {
		const repo = makeRepo(fixtureDir, {
			workingTreeChanges: [{ uri: { fsPath: join(fixtureDir, "src", "a.ts") }, status: 5 }],
			diffs: new Map([["src/a.ts", "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new"]]),
		});
		const vscode = makeMockVscode({ repos: [repo] });
		(globalThis as any).__codepiVscode = { vscode };
		const { get_editor_context } = createContextToolDefinitions();
		const result = await get_editor_context.execute("1", { includeDiff: true }, undefined, undefined, createCtx());
		const text = textOf(result);
		expect(text).toContain("diff --git");
		expect(text).toContain("+new");
	});

	it("get_editor_context reports the missing-bridge error as a text result", async () => {
		const { get_editor_context } = createContextToolDefinitions();
		const result = await get_editor_context.execute("1", {}, undefined, undefined, createCtx());
		expect(textOf(result)).toContain("VS Code API unavailable");
	});

	it("get_git_diff returns diffs for changed files", async () => {
		const repo = makeRepo(fixtureDir, {
			workingTreeChanges: [{ uri: { fsPath: join(fixtureDir, "src", "a.ts") }, status: 5 }],
			diffs: new Map([["src/a.ts", "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new"]]),
		});
		const vscode = makeMockVscode({ repos: [repo] });
		(globalThis as any).__codepiVscode = { vscode };
		const { get_git_diff } = createContextToolDefinitions();
		const result = await get_git_diff.execute("1", {}, undefined, undefined, createCtx());
		expect(textOf(result)).toContain("+new");
	});

	it("get_git_diff filters by path", async () => {
		const repo = makeRepo(fixtureDir, {
			workingTreeChanges: [
				{ uri: { fsPath: join(fixtureDir, "src", "a.ts") }, status: 5 },
				{ uri: { fsPath: join(fixtureDir, "src", "b.ts") }, status: 5 },
			],
			diffs: new Map([
				["src/a.ts", "A-DIFF"],
				["src/b.ts", "B-DIFF"],
			]),
		});
		const vscode = makeMockVscode({ repos: [repo] });
		(globalThis as any).__codepiVscode = { vscode };
		const { get_git_diff } = createContextToolDefinitions();
		const result = await get_git_diff.execute("1", { path: "src/b.ts" }, undefined, undefined, createCtx());
		expect(textOf(result)).toContain("B-DIFF");
		expect(textOf(result)).not.toContain("A-DIFF");
	});

	it("get_git_diff reports unavailable git", async () => {
		const vscode = makeMockVscode({ folders: [fixtureDir] }); // no git extension → getRepository null
		(globalThis as any).__codepiVscode = { vscode };
		const { get_git_diff } = createContextToolDefinitions();
		const result = await get_git_diff.execute("1", {}, undefined, undefined, createCtx());
		expect(textOf(result)).toBe("(git unavailable)");
	});
});

// ── Extension factory ───────────────────────────────────────

describe("codepi-context factory", () => {
	it("registers both tools with the pi API", async () => {
		const registered: any[] = [];
		const api: any = {
			on: vi.fn(),
			registerTool: (tool: any) => registered.push(tool),
			appendEntry: vi.fn(),
		};
		await codepiContextFactory(api);
		expect(registered.map((t) => t.name).sort()).toEqual([
			"get_editor_context",
			"get_git_diff",
		]);
		expect(api.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(api.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
	});

	it("injects live context when the active selection changed, nothing when unchanged", async () => {
		const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
		const api: any = {
			on: (event: string, handler: any) => {
				handlers[event] = handler;
			},
			registerTool: () => {},
			appendEntry: vi.fn(),
		};
		await codepiContextFactory(api);
		const handler = handlers["before_agent_start"]!;
		expect(handler).toBeDefined();

		const vscode = makeMockVscode({
			folders: [fixtureDir],
			active: { path: join(fixtureDir, "src", "foo.ts") },
			tabs: [{ path: join(fixtureDir, "src", "foo.ts") }],
		});
		(globalThis as any).__codepiVscode = { vscode };

		// First turn: selection present → inject.
		const first = await handler({ prompt: "x" }, createCtx());
		expect(first?.message?.content[0].text).toContain("<live_editor_context>");
		expect(first?.message?.content[0].text).toContain("active: src/foo.ts");
		expect(first?.message?.content[0].text).toContain("selection:");
		expect(first?.message?.display).toBe(false);

		// Second turn: unchanged → nothing injected.
		const second = await handler({ prompt: "y" }, createCtx());
		expect(second).toBeUndefined();

		// Selection changes → injects again.
		vscode.window.activeTextEditor.selection = {
			start: { line: 40, character: 0 },
			end: { line: 41, character: 5 },
			active: { line: 41, character: 5 },
			isEmpty: false,
		};
		const third = await handler({ prompt: "z" }, createCtx());
		expect(third?.message?.content[0].text).toContain("selection:");
	});

	it("getVscode resolves through the bridge", async () => {
		const vscode = makeMockVscode();
		(globalThis as any).__codepiVscode = { vscode };
		expect(await getVscode()).toBe(vscode);
	});

	it("getVscode returns undefined without the bridge", async () => {
		expect(await getVscode()).toBeUndefined();
	});
});
