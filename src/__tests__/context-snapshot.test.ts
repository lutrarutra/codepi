/**
 * Unit tests for src/context-snapshot.ts — the pure editor-context collector
 * shared by the codepi-context bundled extension and the host's system-prompt
 * snapshot injection.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectEditorContext,
	collectGitDiffs,
	formatContextSnapshot,
	formatLiveContext,
	getRecentFiles,
	renderSystemPromptSnapshot,
	trackContextEvents,
	waitForEditorRestore,
	__resetContextStateForTests,
	GIT_FILES_MAX,
	OPEN_EDITORS_MAX,
	RESTORE_WAIT_MS,
	SELECTION_TEXT_MAX,
} from "../context-snapshot";

// ── Helpers ─────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codepi-context-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface MockRepo {
	root: string;
	branch?: string;
	upstream?: string;
	ahead?: number;
	behind?: number;
	workingTreeChanges?: any[];
	indexChanges?: any[];
	untrackedChanges?: any[];
	diffs?: Map<string, string>;
	shortStats?: Map<string, { insertions: number; deletions: number }>;
}

function makeRepo(root: string, overrides: Partial<MockRepo> = {}): any {
	const repo: any = {
		rootUri: { fsPath: root },
		state: {
			HEAD: {
				name: overrides.branch ?? "main",
				upstream: overrides.upstream,
				ahead: overrides.ahead,
				behind: overrides.behind,
			},
			workingTreeChanges: overrides.workingTreeChanges ?? [],
			indexChanges: overrides.indexChanges ?? [],
			untrackedChanges: overrides.untrackedChanges ?? [],
		},
		diffs: overrides.diffs ?? new Map(),
		shortStats: overrides.shortStats ?? new Map(),
		diffWithHEAD: async (path: string) =>
			repo.diffs.get(path) ?? `(no diff for ${path})`,
		diffWithHEADShortStats: async (path: string) =>
			repo.shortStats.get(path) ?? { files: 0, insertions: 0, deletions: 0 },
	};
	return repo;
}

function makeMockVscode(options: {
	folders?: string[];
	trusted?: boolean;
	active?: { path: string; languageId?: string; lineCount?: number; isDirty?: boolean; content?: string };
	tabs?: Array<{ path: string; isDirty?: boolean }>;
	textDocuments?: Array<{ path: string; isDirty?: boolean }>;
	visibleEditors?: Array<{ path: string; selection?: any; languageId?: string; lineCount?: number }>;
	terminals?: string[];
	repos?: any[];
	gitExtension?: boolean;
	scmInput?: string;
	debug?: { name: string; type: string } | null;
	activeTextEditorHandler?: (listener: (editor: any) => void) => void;
} = {}) {
	const {
		folders = [],
		trusted = true,
		active,
		tabs = [],
		textDocuments = [],
		visibleEditors = [],
		terminals = [],
		repos = [],
		gitExtension = true,
		scmInput,
		debug = null,
	} = options;

	const activeEditor =
		active !== undefined
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

	// Tab inputs are shared objects so identity-based active detection works.
	const tabInputs = tabs.map((t) => ({ uri: { fsPath: t.path } }));
	const activeIndex = active ? tabs.findIndex((t) => t.path === active.path) : -1;
	const activeTabInput = activeIndex >= 0 ? tabInputs[activeIndex] : undefined;

	return {
		window: {
			activeTextEditor: activeEditor,
			visibleTextEditors: visibleEditors.map((v) => ({
				document: {
					uri: { fsPath: v.path },
					languageId: v.languageId ?? "typescript",
					lineCount: v.lineCount ?? 100,
					isDirty: false,
					getText: () => "const visible = 2;",
				},
				selection: v.selection ?? {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 },
					active: { line: 0, character: 0 },
					isEmpty: true,
				},
			})),
			tabGroups: {
				activeTabGroup: { activeTab: { input: activeTabInput } },
			},
			tabs: tabInputs.map((input, i) => ({
				input,
				isDirty: tabs[i].isDirty ?? false,
			})),
			terminals: terminals.map((name) => ({ name })),
			onDidChangeActiveTextEditor:
				options.activeTextEditorHandler ?? (() => ({ dispose: () => {} })),
		},
		workspace: {
			workspaceFolders: folders.map((f) => ({ uri: { fsPath: f } })),
			isTrusted: trusted,
			name: undefined,
			textDocuments: textDocuments.map((d) => ({
				uri: { fsPath: d.path, scheme: "file" },
				isDirty: d.isDirty ?? false,
			})),
		},
		extensions: {
			getExtension: (id: string) =>
				id === "vscode.git" && gitExtension
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

beforeEach(() => {
	__resetContextStateForTests();
});

// ── formatContextSnapshot ───────────────────────────────────

describe("formatContextSnapshot", () => {
	it("renders a compact live-context block with selection", async () => {
		const vscode = makeMockVscode({
			folders: ["/p"],
			active: { path: "/p/src/foo.ts" },
		});
		const ctx = await collectEditorContext(vscode, "/p");
		const text = formatLiveContext(ctx, "/p");
		expect(text).toContain("<live_editor_context>");
		expect(text).toContain("active: src/foo.ts [typescript] L11:4");
		expect(text).toContain("selection: src/foo.ts L11:4–L13:8 (3 lines)");
		expect(text).toContain("selection_text: const selected = 1;");
	});

	it("returns an empty live block without an active editor", async () => {
		const vscode = makeMockVscode({ folders: ["/p"] });
		const ctx = await collectEditorContext(vscode, "/p");
		expect(formatLiveContext(ctx, "/p")).toBe("");
	});

	it("finds a selection in a visible editor when none is active (panel focused)", async () => {
		// No activeTextEditor (CodePi panel has focus), but a visible editor
		// holds a deliberate multi-line selection.
		const vscode = makeMockVscode({
			folders: ["/p"],
			visibleEditors: [
				{ path: "/p/other.ts", selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true } },
				{
					path: "/p/src/highlighted.ts",
					selection: {
						start: { line: 5, character: 2 },
						end: { line: 9, character: 8 },
						active: { line: 9, character: 8 },
						isEmpty: false,
					},
				},
			],
		});
		const ctx = await collectEditorContext(vscode, "/p");
		expect(ctx.active?.path).toBe("/p/src/highlighted.ts");
		expect(ctx.selections).toHaveLength(1);
		expect(ctx.selections[0].lines).toBe(5);
		expect(ctx.selections[0].start).toBe("L6:3");
		const text = formatLiveContext(ctx, "/p");
		expect(text).toContain("active: src/highlighted.ts");
		expect(text).toContain("selection: src/highlighted.ts L6:3–L10:9 (5 lines)");
		expect(text).toContain("selection_text: const visible = 2;");
	});

	it("collects selections from multiple visible editors, each with its file", async () => {
		const vscode = makeMockVscode({
			folders: ["/p"],
			visibleEditors: [
				{
					path: "/p/src/a.ts",
					selection: {
						start: { line: 1, character: 0 },
						end: { line: 2, character: 4 },
						active: { line: 2, character: 4 },
						isEmpty: false,
					},
				},
				{
					path: "/p/src/b.ts",
					selection: {
						start: { line: 8, character: 2 },
						end: { line: 8, character: 9 },
						active: { line: 8, character: 9 },
						isEmpty: false,
					},
				},
			],
		});
		const ctx = await collectEditorContext(vscode, "/p");
		expect(ctx.selections.map((s) => s.file).sort()).toEqual([
			"/p/src/a.ts",
			"/p/src/b.ts",
		]);
		const text = formatContextSnapshot(ctx, "/p");
		expect(text).toContain("selection: src/a.ts L2:1–L3:5 (2 lines)");
		expect(text).toContain("selection: src/b.ts L9:3–L9:10 (1 line)");
	});

	it("ignores stray caret selections in visible editors", async () => {
		const vscode = makeMockVscode({
			folders: ["/p"],
			visibleEditors: [
				{ path: "/p/a.ts", selection: { start: { line: 3, character: 1 }, end: { line: 3, character: 1 }, isEmpty: true } },
			],
		});
		const ctx = await collectEditorContext(vscode, "/p");
		expect(ctx.active).toBeUndefined();
		expect(ctx.selections).toEqual([]);
	});

	it("renders an empty-ish state without throwing", async () => {
		const repo = makeRepo("/p", {});
		const vscode = makeMockVscode({ folders: ["/p"], repos: [repo] });
		const ctx = await collectEditorContext(vscode, "/p");
		const text = formatContextSnapshot(ctx, "/p");
		expect(text).toContain("<editor_context>");
		expect(text).toContain("workspace: /p");
		expect(text).toContain("git: main — clean");
		// Empty placeholders are omitted — nothing valuable to report.
		expect(text).not.toContain("terminals:");
		expect(text).not.toContain("debug:");
		expect(text).toContain(
			"note: snapshot from session start — call get_editor_context for live state",
		);
	});

	it("shows the active editor with cursor, selection range and short selection text", async () => {
		const vscode = makeMockVscode({
			folders: ["/p"],
			active: { path: "/p/src/foo.ts" },
		});
		const ctx = await collectEditorContext(vscode, "/p");
		const text = formatContextSnapshot(ctx, "/p");
		expect(text).toContain("active: src/foo.ts [typescript] L11:4");
		expect(text).toContain("selection: src/foo.ts L11:4–L13:8 (3 lines)");
		expect(text).toContain("selection_text: const selected = 1;");
		expect(text).toContain("(120 lines)");
	});

	it("keeps long selections as range-only by default", async () => {
		const long = "x".repeat(SELECTION_TEXT_MAX + 50);
		const vscode = makeMockVscode({
			folders: ["/p"],
			active: { path: "/p/src/long.ts", content: long },
		});
		const ctx = await collectEditorContext(vscode, "/p");
		const text = formatContextSnapshot(ctx, "/p");
		expect(text).toContain("selection: src/long.ts");
		expect(text).not.toContain("selection_text:");
	});

	it("forces the selection text when includeSelection is true (capped)", async () => {
		const long = "y".repeat(SELECTION_TEXT_MAX + 50);
		const vscode = makeMockVscode({
			folders: ["/p"],
			active: { path: "/p/src/long.ts", content: long },
		});
		const ctx = await collectEditorContext(vscode, "/p", {
			includeSelection: true,
		});
		const text = formatContextSnapshot(ctx, "/p");
		expect(text).toContain("selection_text:");
		expect(text).toContain("…");
	});

	it("lists open editors with active and dirty markers, capped", async () => {
		const many = Array.from({ length: OPEN_EDITORS_MAX + 5 }, (_, i) => ({
			path: `/p/f${i}.ts`,
		}));
		const vscode = makeMockVscode({
			folders: ["/p"],
			active: { path: "/p/f0.ts" },
			tabs: [{ path: "/p/f0.ts", isDirty: true }, ...many.slice(1)],
		});
		const ctx = await collectEditorContext(vscode, "/p");
		const text = formatContextSnapshot(ctx, "/p");
		expect(text).toContain(`open(${OPEN_EDITORS_MAX + 5}): *f0.ts (dirty), f1.ts`);
		expect(text).toContain("… +5 more");
	});

	it("falls back to open text documents when the tab model is empty", async () => {
		const vscode = makeMockVscode({
			folders: ["/p"],
			active: { path: "/p/a.ts" },
			tabs: [], // window still restoring its layout — tab model not populated
			textDocuments: [
				{ path: "/p/a.ts", isDirty: true },
				{ path: "/p/b.ts" },
			],
		});
		const ctx = await collectEditorContext(vscode, "/p");
		const text = formatContextSnapshot(ctx, "/p");
		expect(text).toContain("open(2): *a.ts (dirty), b.ts");
	});

	it("renders git branch, divergence, changed files with ±stats", async () => {
		const repo = makeRepo("/p", {
			branch: "feat/context",
			upstream: "origin/feat/context",
			ahead: 2,
			workingTreeChanges: [{ uri: { fsPath: "/p/src/a.ts" }, status: 5 }],
			indexChanges: [{ uri: { fsPath: "/p/src/b.ts" }, status: 1 }],
			shortStats: new Map([
				["src/a.ts", { insertions: 12, deletions: 3 }],
				["src/b.ts", { insertions: 1, deletions: 0 }],
			]),
		});
		const vscode = makeMockVscode({ folders: ["/p"], repos: [repo] });
		const ctx = await collectEditorContext(vscode, "/p");
		const text = formatContextSnapshot(ctx, "/p");
		expect(text).toContain("git: feat/context (ahead 2) — 2 changed:");
		expect(text).toContain("src/a.ts +12/−3");
		expect(text).toContain("src/b.ts +1/−0");
	});

	it("marks untracked files as new with a line count", async () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "new.ts"), "line1\nline2\nline3");
		const repo = makeRepo(dir, {
			untrackedChanges: [{ uri: { fsPath: join(dir, "new.ts") }, status: 7 }],
		});
		const vscode = makeMockVscode({ folders: [dir], repos: [repo] });
		const ctx = await collectEditorContext(vscode, dir);
		const text = formatContextSnapshot(ctx, dir);
		expect(text).toMatch(/new\.ts \(new, 3 lines\)/);
	});

	it("reports git as unavailable when the git extension is missing", async () => {
		const vscode = makeMockVscode({ folders: ["/p"], gitExtension: false });
		const ctx = await collectEditorContext(vscode, "/p");
		const text = formatContextSnapshot(ctx, "/p");
		expect(text).toContain("git: unavailable (vscode.git unavailable)");
	});

	it("reports git as unavailable outside a repository", async () => {
		const vscode = makeMockVscode({ folders: ["/p"] }); // no repos
		const ctx = await collectEditorContext(vscode, "/p");
		const text = formatContextSnapshot(ctx, "/p");
		expect(text).toContain("git: unavailable (not a git repository)");
	});

	it("includes scm input, terminals and debug session", async () => {
		const vscode = makeMockVscode({
			folders: ["/p"],
			terminals: ["zsh", "npm run dev"],
			scmInput: "fix: typo in context tool",
			debug: { name: "Launch Extension", type: "node" },
		});
		const ctx = await collectEditorContext(vscode, "/p");
		const text = formatContextSnapshot(ctx, "/p");
		expect(text).toContain('scm_input: "fix: typo in context tool"');
		expect(text).toContain("terminals: 2 (zsh, npm run dev)");
		expect(text).toContain("debug: Launch Extension (node)");
	});

	it("uses the fresh note when rendered live", async () => {
		const vscode = makeMockVscode({ folders: ["/p"] });
		const ctx = await collectEditorContext(vscode, "/p");
		const text = formatContextSnapshot(ctx, "/p", { fresh: true });
		expect(text).toContain("note: live editor state");
	});

	it("marks untrusted workspaces", async () => {
		const vscode = makeMockVscode({ folders: ["/p"], trusted: false });
		const ctx = await collectEditorContext(vscode, "/p");
		const text = formatContextSnapshot(ctx, "/p");
		expect(text).toContain("(untrusted)");
	});
});

// ── collectEditorContext behavior ───────────────────────────

describe("collectEditorContext", () => {
	it("dedupes a file present in both working tree and index (marks staged)", async () => {
		const repo = makeRepo("/p", {
			workingTreeChanges: [{ uri: { fsPath: "/p/src/a.ts" }, status: 5 }],
			indexChanges: [{ uri: { fsPath: "/p/src/a.ts" }, status: 0 }],
			shortStats: new Map([["src/a.ts", { insertions: 4, deletions: 2 }]]),
		});
		const vscode = makeMockVscode({ folders: ["/p"], repos: [repo] });
		const ctx = await collectEditorContext(vscode, "/p");
		expect(ctx.git?.repos[0].changes).toHaveLength(1);
		expect(ctx.git?.repos[0].changes[0].staged).toBe(true);
	});

	it("caps git changed files to maxFiles for stats", async () => {
		const many = Array.from({ length: GIT_FILES_MAX + 10 }, (_, i) => ({
			uri: { fsPath: `/p/m${i}.ts` },
			status: 5,
		}));
		const repo = makeRepo("/p", { workingTreeChanges: many });
		const vscode = makeMockVscode({ folders: ["/p"], repos: [repo] });
		const ctx = await collectEditorContext(vscode, "/p", { maxFiles: 5 });
		expect(ctx.git?.repos[0].changes.length).toBe(GIT_FILES_MAX + 10);
		const statted = ctx.git!.repos[0].changes.filter(
			(c) => c.insertions !== undefined,
		);
		expect(statted.length).toBeLessThanOrEqual(5);
	});

	it("never throws on a broken vscode shape", async () => {
		const ctx = await collectEditorContext({}, "/p");
		expect(Array.isArray(ctx.errors)).toBe(true);
		expect(ctx.openEditors).toEqual([]);
	});
});

// ── Git stats cache ─────────────────────────────────────────

describe("git stats cache", () => {
	it("calls diffWithHEADShortStats once per file within the TTL", async () => {
		const repo = makeRepo("/p", {
			workingTreeChanges: [{ uri: { fsPath: "/p/src/a.ts" }, status: 5 }],
			shortStats: new Map([["src/a.ts", { insertions: 1, deletions: 1 }]]),
		});
		const shortStatSpy = vi.fn(repo.diffWithHEADShortStats);
		repo.diffWithHEADShortStats = shortStatSpy;
		const vscode = makeMockVscode({ folders: ["/p"], repos: [repo] });

		await collectEditorContext(vscode, "/p");
		await collectEditorContext(vscode, "/p");
		expect(shortStatSpy).toHaveBeenCalledTimes(1);
	});
});

// ── collectGitDiffs ─────────────────────────────────────────

describe("collectGitDiffs", () => {
	it("returns unified diffs for changed files", async () => {
		const repo = makeRepo("/p", {
			workingTreeChanges: [{ uri: { fsPath: "/p/src/a.ts" }, status: 5 }],
			diffs: new Map([
				["src/a.ts", "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new"],
			]),
		});
		const vscode = makeMockVscode({ folders: ["/p"], repos: [repo] });
		const text = await collectGitDiffs(vscode, "/p");
		expect(text).toContain("diff --git");
		expect(text).toContain("+new");
	});

	it("inlines untracked files with their content", async () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "new.ts"), "export const x = 1;\n");
		const repo = makeRepo(dir, {
			untrackedChanges: [{ uri: { fsPath: join(dir, "new.ts") }, status: 7 }],
		});
		const vscode = makeMockVscode({ folders: [dir], repos: [repo] });
		const text = await collectGitDiffs(vscode, dir);
		expect(text).toContain("# new file: new.ts (untracked)");
		expect(text).toContain("export const x = 1;");
	});

	it("filters to a single path", async () => {
		const repo = makeRepo("/p", {
			workingTreeChanges: [
				{ uri: { fsPath: "/p/src/a.ts" }, status: 5 },
				{ uri: { fsPath: "/p/src/b.ts" }, status: 5 },
			],
			diffs: new Map([
				["src/a.ts", "A-DIFF"],
				["src/b.ts", "B-DIFF"],
			]),
		});
		const vscode = makeMockVscode({ folders: ["/p"], repos: [repo] });
		const text = await collectGitDiffs(vscode, "/p", { path: "src/b.ts" });
		expect(text).toContain("B-DIFF");
		expect(text).not.toContain("A-DIFF");
	});

	it("truncates long diffs with a footer", async () => {
		const repo = makeRepo("/p", {
			workingTreeChanges: [{ uri: { fsPath: "/p/big.ts" }, status: 5 }],
			diffs: new Map([
				[
					"big.ts",
					Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
				],
			]),
		});
		const vscode = makeMockVscode({ folders: ["/p"], repos: [repo] });
		const text = await collectGitDiffs(vscode, "/p", { maxDiffLines: 10 });
		expect(text).toContain("… diff truncated to 10 lines …");
		expect(text.split("\n").length).toBeLessThan(30);
	});

	it("reports when git is unavailable", async () => {
		const vscode = makeMockVscode({ folders: ["/p"], gitExtension: false });
		const text = await collectGitDiffs(vscode, "/p");
		expect(text).toBe("(git unavailable)");
	});
});

// ── Recent-file tracker ─────────────────────────────────────

describe("trackContextEvents", () => {
	it("records switches, dedupes and caps", () => {
		let listener: (editor: any) => void = () => {};
		const vscode = makeMockVscode({
			activeTextEditorHandler: (l) => {
				listener = l;
			},
		});
		trackContextEvents(vscode);
		for (let i = 0; i < 10; i++) {
			listener({ document: { uri: { fsPath: `/p/r${i % 3}.ts` } } });
		}
		const recent = getRecentFiles();
		expect(recent[0]).toBe("/p/r0.ts"); // newest (deduped)
		expect(new Set(recent).size).toBe(recent.length);
		expect(recent.length).toBeLessThanOrEqual(6);
	});

	it("is idempotent — one subscription per module instance", () => {
		let count = 0;
		const vscode = makeMockVscode({
			activeTextEditorHandler: () => {
				count++;
			},
		});
		trackContextEvents(vscode);
		trackContextEvents(vscode);
		expect(count).toBe(1);
	});
});

// ── waitForEditorRestore ────────────────────────────────────

describe("waitForEditorRestore", () => {
	it("resolves immediately when editors are already present", async () => {
		const vscode = makeMockVscode({
			folders: ["/p"],
			tabs: [{ path: "/p/a.ts" }],
		});
		await expect(waitForEditorRestore(vscode)).resolves.toBeUndefined();
	});

	it("resolves when file documents appear during the poll", async () => {
		vi.useFakeTimers();
		try {
			const docs: any[] = [];
			const vscode = {
				window: { tabs: [], tabGroups: {} },
				workspace: { textDocuments: docs },
			};
			let resolved = false;
			const done = waitForEditorRestore(vscode, 1000, 25).then(() => {
				resolved = true;
			});
			// A restored document appears mid-poll (e.g. the window finishing
			// its layout restore) — the wait must end early.
			docs.push({ uri: { fsPath: "/p/x.ts", scheme: "file" } });
			await vi.advanceTimersByTimeAsync(50);
			await done;
			expect(resolved).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("gives up after the timeout when nothing appears", async () => {
		vi.useFakeTimers();
		try {
			const vscode = makeMockVscode({ folders: ["/p"] }); // no tabs, no docs
			let resolved = false;
			const done = waitForEditorRestore(vscode, 200, 25).then(() => {
				resolved = true;
			});
			await vi.advanceTimersByTimeAsync(RESTORE_WAIT_MS + 500);
			await done;
			expect(resolved).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ── renderSystemPromptSnapshot ──────────────────────────────

describe("renderSystemPromptSnapshot", () => {
	it("returns a snapshot block for a live window", async () => {
		const vscode = makeMockVscode({
			folders: ["/p"],
			active: { path: "/p/src/foo.ts" },
		});
		const text = await renderSystemPromptSnapshot(vscode, "/p");
		expect(text).toContain("<editor_context>");
		expect(text).toContain("active: src/foo.ts");
	});

	it("returns undefined when the API is unavailable", async () => {
		const text = await renderSystemPromptSnapshot(undefined, "/p");
		expect(text).toBeUndefined();
	});
});
