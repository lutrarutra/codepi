import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const diagnosticListeners: ((e: { uris: unknown[] }) => void)[] = [];

vi.mock("vscode", () => {
	const file = (p: string) => ({
		fsPath: p,
		scheme: "file",
		path: p,
		toString: () => p,
	});
	return {
		Uri: {
			file: (p: string) => file(p),
			joinPath: (base: { fsPath: string }, ...parts: string[]) =>
				file([base.fsPath, ...parts].join("/")),
			parse: (s: string) => file(s),
		},
		workspace: {
			workspaceFolders: [{ uri: file("/ws") }],
			asRelativePath: (u: { fsPath: string }) =>
				u.fsPath.startsWith("/ws/") ? u.fsPath.slice("/ws/".length) : u.fsPath,
			openTextDocument: vi.fn(async (u: unknown) => ({
				uri: u,
				getText: () => "",
			})),
			fs: { readFile: vi.fn(async () => Promise.reject(new Error("not mocked"))) },
		},
		languages: {
			getDiagnostics: vi.fn(),
			onDidChangeDiagnostics: vi.fn(
				(l: (e: { uris: unknown[] }) => void) => {
					diagnosticListeners.push(l);
					return { dispose: vi.fn() };
				},
			),
		},
		window: { activeTextEditor: undefined },
	};
});

import * as vscode from "vscode";
import { getDiagnosticsTool } from "../tools/index";
import { disposeDiagnosticsCache } from "../tools/diagnostics";

const getDiagnostics = vscode.languages
	.getDiagnostics as unknown as ReturnType<typeof vi.fn>;
const openTextDocument = vscode.workspace
	.openTextDocument as unknown as ReturnType<typeof vi.fn>;

/** Build a minimal vscode.Diagnostic-shaped object. */
function diag(
	severity: number,
	line: number,
	col: number,
	message: string,
	source?: string,
	code?: unknown,
	tags?: number[],
): Record<string, unknown> {
	return {
		severity,
		message,
		range: {
			start: { line: line - 1, character: col - 1 },
			end: { line: line - 1, character: col - 1 },
		},
		source,
		code,
		tags,
	};
}

beforeEach(() => {
	getDiagnostics.mockReset();
	openTextDocument.mockClear();
	diagnosticListeners.length = 0;
	disposeDiagnosticsCache();
	(vscode.window as { activeTextEditor?: unknown }).activeTextEditor = undefined;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("getDiagnosticsTool", () => {
	it("reports problems grouped by file with counts and positions", async () => {
		getDiagnostics.mockReturnValue([
			[
				vscode.Uri.file("/ws/app.py"),
				[
					diag(0, 5, 3, "Undefined name 'foo'", "python"),
					diag(1, 9, 1, "Line too long", "pylint"),
				],
			],
			[
				vscode.Uri.file("/ws/lib/util.ts"),
				[diag(2, 2, 4, "Unused variable 'x'", "typescript")],
			],
		]);

		const res = await getDiagnosticsTool.execute("t1", {});
		const text = res.content[0].text as string;

		expect(text).toContain("Problems: 1 error, 1 warning, 1 info in 2 files");
		expect(text).toContain("app.py:");
		expect(text).toContain("error   5:3  Undefined name 'foo' (python)");
		expect(text).toContain("warning 9:1  Line too long (pylint)");
		expect(text).toContain("lib/util.ts:");
		expect(text).toContain("info    2:4  Unused variable 'x' (typescript)");
		expect(res.details).toMatchObject({
			errors: 1,
			warnings: 1,
			infos: 1,
			files: 2,
			total: 3,
		});
	});

	it("filters to a minimum severity", async () => {
		getDiagnostics.mockReturnValue([
			[
				vscode.Uri.file("/ws/app.py"),
				[
					diag(0, 1, 1, "Fatal", "python"),
					diag(1, 2, 1, "Suspicious", "python"),
					diag(2, 3, 1, "Informational", "python"),
				],
			],
		]);

		const res = await getDiagnosticsTool.execute("t2", { severity: "error" });
		const text = res.content[0].text as string;
		expect(text).toContain("Problems: 1 error in 1 file");
		expect(text).toContain("Fatal");
		expect(text).not.toContain("Suspicious");
		expect(text).not.toContain("Informational");
	});

	it("includes hints when severity is hint", async () => {
		getDiagnostics.mockReturnValue([
			[
				vscode.Uri.file("/ws/app.py"),
				[diag(0, 1, 1, "Hard error", "python"), diag(3, 2, 1, "Tiny hint", "python")],
			],
		]);

		const res = await getDiagnosticsTool.execute("t3", { severity: "hint" });
		const text = res.content[0].text as string;
		expect(text).toContain("1 error, 1 hint in 1 file");
		expect(text).toContain("Tiny hint");
	});

	it("scopes to a path and opens the document to trigger analysis", async () => {
		getDiagnostics.mockImplementation((uri?: { fsPath?: string }) =>
			uri && uri.fsPath === "/ws/src/app.py"
				? [diag(0, 3, 7, "Syntax error", "python")]
				: [],
		);

		const res = await getDiagnosticsTool.execute("t4", { path: "src/app.py" });
		const text = res.content[0].text as string;

		expect(openTextDocument).toHaveBeenCalledTimes(1);
		expect(openTextDocument.mock.calls[0][0].fsPath).toBe("/ws/src/app.py");
		expect(text).toContain("src/app.py:");
		expect(text).toContain("error   3:7  Syntax error (python)");
		expect(res.details).toMatchObject({ settled: true, staleBuffer: false });
	});

	it("reports a clean bill when there are no problems", async () => {
		getDiagnostics.mockReturnValue([]);
		const res = await getDiagnosticsTool.execute("t5", {});
		expect(res.content[0].text as string).toContain("No problems found");
		expect(res.details).toMatchObject({ files: 0, errors: 0, warnings: 0 });
	});

	it("reports a soft note when the language server stays silent", async () => {
		vi.useFakeTimers();
		getDiagnostics.mockReturnValue([]);
		const pending = getDiagnosticsTool.execute("t6", { path: "src/app.py" });
		await vi.advanceTimersByTimeAsync(6000);
		const res = await pending;
		expect(res.content[0].text as string).toContain(
			"No problems found in src/app.py",
		);
		// The server never reported anything, so the tool must not claim a
		// confident "clean" — it softens the claim instead of asserting the
		// file is final.
		expect(res.content[0].text as string).toContain(
			"no language server reported problems",
		);
		expect(res.details).toMatchObject({ settled: false });
	});

	it("confirms clean when the server publishes an empty update", async () => {
		vi.useFakeTimers();
		getDiagnostics.mockReturnValue([]);
		// The server signals it analyzed the file by publishing (an empty set
		// clears earlier markers). The tool should accept that as a confirmed
		// "no problems" after a longer confirmation window — no scary note.
		const before = diagnosticListeners.length;
		const pending = getDiagnosticsTool.execute("t6e", {
			path: "src/app.py",
		});
		await vi.advanceTimersByTimeAsync(100);
		for (const l of diagnosticListeners.slice(before)) {
			l({ uris: [vscode.Uri.file("/ws/src/app.py")] });
		}
		await vi.advanceTimersByTimeAsync(6000);
		const res = await pending;

		const text = res.content[0].text as string;
		expect(text).toContain("No problems found");
		expect(text).not.toContain("no language server reported problems");
		expect(res.details).toMatchObject({ settled: true });
	});

	it("re-runs of an unchanged file are instant and stop nagging", async () => {
		vi.useFakeTimers();
		getDiagnostics.mockReturnValue([]);

		// First check: server silent → full wait, soft note.
		const first = getDiagnosticsTool.execute("t6f", { path: "src/app.py" });
		await vi.advanceTimersByTimeAsync(6000);
		const firstRes = await first;
		expect(firstRes.content[0].text as string).toContain(
			"no language server reported problems",
		);
		expect(firstRes.details).toMatchObject({ settled: false });

		// Second check, same file, nothing changed: verdict reused instantly
		// (no timers advanced), and the note is gone — re-running was the
		// confirmation, it shouldn't nag forever.
		const second = getDiagnosticsTool.execute("t6f", { path: "src/app.py" });
		const secondRes = await second;
		expect(secondRes.content[0].text as string).toContain("No problems found");
		expect(secondRes.content[0].text as string).not.toContain(
			"no language server reported problems",
		);
		expect(secondRes.details).toMatchObject({ settled: false });

		// The server publishes something new → cache invalidated → the next
		// check must wait again instead of trusting the old verdict. (The
		// invalidator is the first listener each test registers; disposed
		// per-wait listeners harmlessly no-op on the event.)
		for (const l of diagnosticListeners) {
			l({ uris: [vscode.Uri.file("/ws/src/app.py")] });
		}
		const callsBefore = getDiagnostics.mock.calls.length;
		const third = getDiagnosticsTool.execute("t6f", { path: "src/app.py" });
		for (let i = 0; i < 10; i++) await Promise.resolve();
		// Not resolved from the cache: the fresh check already consulted the
		// diagnostics mirror instead of returning the stale verdict.
		expect(getDiagnostics.mock.calls.length).toBeGreaterThan(callsBefore);
		await vi.advanceTimersByTimeAsync(6000);
		const thirdDone = await third;
		expect(thirdDone.details).toMatchObject({ settled: false });
	});

	it("keeps the note when the server churns without settling", async () => {
		vi.useFakeTimers();
		let flip = false;
		getDiagnostics.mockImplementation(() =>
			flip
				? [diag(0, 1, 1, "Error A", "python")]
				: [diag(0, 2, 1, "Error B", "python")],
		);
		const interval = setInterval(() => {
			flip = !flip;
		}, 200);

		const pending = getDiagnosticsTool.execute("t6g", { path: "src/app.py" });
		await vi.advanceTimersByTimeAsync(6000);
		clearInterval(interval);
		const res = await pending;

		const text = res.content[0].text as string;
		expect(text).toContain("never settled on a final state");
		expect(res.details).toMatchObject({ settled: false });
	});

	it("waits for a late language-server push to settle", async () => {
		vi.useFakeTimers();
		let current: unknown[] = [];
		getDiagnostics.mockImplementation(() => current);
		// The server takes ~1s to analyze, then publishes the errors.
		setTimeout(() => {
			current = [diag(0, 8, 37, '"(" was not closed', "python")];
		}, 1000);

		const pending = getDiagnosticsTool.execute("t6b", { path: "src/app.py" });
		await vi.advanceTimersByTimeAsync(6000);
		const res = await pending;

		const text = res.content[0].text as string;
		expect(text).toContain('error   8:37  "(" was not closed (python)');
		expect(text).not.toContain("never settled on a final state");
		expect(res.details).toMatchObject({ settled: true, errors: 1 });
	});

	it("flags when the open editor buffer differs from the disk", async () => {
		vi.useFakeTimers();
		// The file is already open in an editor with a stale buffer (the agent
		// wrote to disk via workspace.fs but the document hasn't reloaded).
		getDiagnostics.mockReturnValue([]);
		openTextDocument.mockImplementation(async (u: unknown) => ({
			uri: u,
			getText: () => "old buffer content",
		}));
		(vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
			new TextEncoder().encode("new disk content"),
		);

		const pending = getDiagnosticsTool.execute("t6c", {
			path: "src/app.py",
		});
		await vi.advanceTimersByTimeAsync(8000);
		const res = await pending;
		const text = res.content[0].text as string;
		expect(text).toContain("editor buffer differs from the file on disk");
		expect(res.details).toMatchObject({ staleBuffer: true });
	});

	it("waits for a stale buffer to reload so the lint reflects the saved file", async () => {
		vi.useFakeTimers();
		// Open, non-dirty document that VS Code reloads from disk ~500ms after
		// the agent's write; the server then publishes errors for the new
		// content. The tool must wait for the reload instead of linting the
		// stale buffer (and must NOT raise the stale-buffer flag afterwards).
		let buffer = "old buffer content";
		openTextDocument.mockImplementation(async (u: unknown) => ({
			uri: u,
			getText: () => buffer,
			isDirty: false,
		}));
		(vscode.workspace.fs.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
			new TextEncoder().encode("new disk content"),
		);
		let current: unknown[] = [];
		getDiagnostics.mockImplementation(() => current);
		setTimeout(() => {
			buffer = "new disk content";
		}, 500);
		setTimeout(() => {
			current = [diag(0, 9, 2, "New content error", "python")];
		}, 900);

		const pending = getDiagnosticsTool.execute("t6d", {
			path: "src/app.py",
		});
		await vi.advanceTimersByTimeAsync(8000);
		const res = await pending;

		const text = res.content[0].text as string;
		expect(text).toContain("New content error");
		expect(text).not.toContain("editor buffer differs");
		expect(res.details).toMatchObject({ staleBuffer: false, settled: true });
	});

	it("rejects an invalid severity", async () => {
		const res = await getDiagnosticsTool.execute("t7", {
			severity: "critical",
		});
		expect(res.isError).toBe(true);
		expect(res.content[0].text as string).toContain("Invalid severity");
	});

	it("respects the limit and reports the remainder", async () => {
		getDiagnostics.mockReturnValue([
			[
				vscode.Uri.file("/ws/app.py"),
				[
					diag(0, 1, 1, "One", "python"),
					diag(0, 2, 1, "Two", "python"),
					diag(0, 3, 1, "Three", "python"),
				],
			],
		]);

		const res = await getDiagnosticsTool.execute("t8", { limit: 2 });
		const text = res.content[0].text as string;
		expect(text).toContain("One");
		expect(text).toContain("Two");
		expect(text).not.toContain("Three");
		expect(text).toContain("... and 1 more");
		expect(res.details).toMatchObject({ truncatedTo: 2, total: 3 });
	});

	it("formats source, code and diagnostic tags", async () => {
		getDiagnostics.mockReturnValue([
			[
				vscode.Uri.file("/ws/app.py"),
				[
					diag(1, 4, 1, "Unused variable 'y'", "eslint", "no-unused-vars", [1]),
					diag(0, 6, 2, "Legacy call", "deprecated-api", { value: "oldFn" }, [2]),
				],
			],
		]);

		const res = await getDiagnosticsTool.execute("t9", {});
		const text = res.content[0].text as string;
		expect(text).toContain(
			"warning 4:1  Unused variable 'y' (eslint, no-unused-vars, unnecessary)",
		);
		expect(text).toContain("error   6:2  Legacy call (deprecated-api, oldFn, deprecated)");
	});

	it("prioritizes the active editor file", async () => {
		(vscode.window as { activeTextEditor?: unknown }).activeTextEditor = {
			document: { uri: vscode.Uri.file("/ws/b.py") },
		};
		getDiagnostics.mockReturnValue([
			[vscode.Uri.file("/ws/a.py"), [diag(0, 1, 1, "In a", "python")]],
			[vscode.Uri.file("/ws/b.py"), [diag(1, 2, 1, "In b", "python")]],
		]);

		const res = await getDiagnosticsTool.execute("t10", {});
		const text = res.content[0].text as string;
		expect(text.indexOf("b.py:")).toBeLessThan(text.indexOf("a.py:"));
	});
});
