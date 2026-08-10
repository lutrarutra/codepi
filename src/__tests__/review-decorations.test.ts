import { describe, expect, it, vi } from "vitest";
import type { EditHunk } from "../review/types";

const vscodeMock = vi.hoisted(() => ({
	registeredProvider: undefined as any,
	decorationOptions: [] as any[],
	createDecorationType: vi.fn(),
}));

vi.mock("vscode", () => {
	class Position {
		constructor(
			public readonly line: number,
			public readonly character: number,
		) {}
	}
	class Range {
		public readonly start: any;
		public readonly end: any;
		constructor(startOrStartLine: any, endOrStartChar: any, endLine?: any, endChar?: any) {
			if (typeof startOrStartLine === "number") {
				this.start = new Position(startOrStartLine, endOrStartChar);
				this.end = new Position(endLine ?? 0, endChar ?? 0);
			} else {
				this.start = startOrStartLine;
				this.end = endOrStartChar;
			}
		}
	}
	class CodeLens {
		constructor(
			public readonly range: any,
			public readonly command: any,
		) {}
	}
	return {
		Position,
		Range,
		CodeLens,
		ThemeColor: class ThemeColor {
			constructor(public readonly id: string) {}
		},
		OverviewRulerLane: { Left: 1 },
		Uri: { parse: (value: string) => ({ toString: () => value }) },
		window: {
			visibleTextEditors: [],
			onDidChangeActiveTextEditor: () => ({ dispose: vi.fn() }),
			onDidChangeVisibleTextEditors: () => ({ dispose: vi.fn() }),
			createTextEditorDecorationType: (options: unknown) => {
				vscodeMock.decorationOptions.push(options);
				return { dispose: vi.fn() };
			},
		},
		workspace: {
			onDidCloseTextDocument: () => ({ dispose: vi.fn() }),
			onDidChangeTextDocument: () => ({ dispose: vi.fn() }),
		},
		languages: {
			registerCodeLensProvider: (_selector: unknown, provider: unknown) => {
				vscodeMock.registeredProvider = provider;
				return { dispose: vi.fn() };
			},
		},
	};
});

import { ReviewDecorations, computeDecorationRanges } from "../review/decorations";

function proposal(hunks: EditHunk[] = []) {
	return {
		proposalId: "p1",
		toolCallId: "t1",
		uri: "file:///workspace/a.ts",
		path: "a.ts",
		originalContent: "old\n",
		proposedContent: "new\n",
		proposedHash: "hash",
		createdAt: 1,
		status: "pending" as const,
		hunks,
	};
}

function hunk(overrides: Partial<EditHunk> & { oldText: string; newText: string }): EditHunk {
	return {
		hunkId: "h1",
		originalStartLine: 0,
		originalEndLine: 0,
		modifiedStartLine: 0,
		modifiedEndLine: 0,
		status: "pending",
		...overrides,
	};
}

describe("ReviewDecorations", () => {
	it("creates whole-line decoration types for added and removed lines", () => {
		const review = new ReviewDecorations();
		expect(vscodeMock.decorationOptions).toHaveLength(2);
		for (const options of vscodeMock.decorationOptions) {
			expect(options.isWholeLine).toBe(true);
			expect(options.backgroundColor).toBeInstanceOf(Object);
			expect(options.backgroundColor.id).toMatch(/^diffEditor\./);
			expect(options.overviewRulerLane).toBe(1);
		}
		review.dispose();
	});

	it("keeps file-level accept/reject CodeLens actions", () => {
		const review = new ReviewDecorations();
		review.setProposal(
			proposal([
				hunk({
					originalStartLine: 1,
					originalEndLine: 1,
					modifiedStartLine: 1,
					modifiedEndLine: 1,
					oldText: "old",
					newText: "new",
				}),
			]),
		);

		const provider = vscodeMock.registeredProvider;
		const lenses = provider.provideCodeLenses({
			uri: { toString: () => "file:///workspace/a.ts" },
		});

		expect(lenses).toHaveLength(2);
		expect(lenses.map((lens: any) => lens.command.command)).toEqual([
			"codepi.acceptFile",
			"codepi.rejectFile",
		]);
		review.dispose();
	});
});

describe("computeDecorationRanges", () => {
	it("highlights inserted lines as added", () => {
		const hunks: EditHunk[] = [
			hunk({
				modifiedStartLine: 2,
				modifiedEndLine: 3,
				oldText: "",
				newText: "x\ny",
			}),
		];
		const { added, removed } = computeDecorationRanges(
			"a\n",
			"a\nx\ny\n",
			hunks,
			4,
		);
		expect(added).toHaveLength(1);
		expect(added[0].start.line).toBe(1); // 0-based: lines 2-3 → 1-2
		expect(added[0].end.line).toBe(2);
		expect(removed).toHaveLength(0);
	});

	it("highlights modified lines as added", () => {
		const hunks: EditHunk[] = [
			hunk({
				originalStartLine: 2,
				originalEndLine: 2,
				modifiedStartLine: 2,
				modifiedEndLine: 2,
				oldText: "b",
				newText: "B",
			}),
		];
		const { added, removed } = computeDecorationRanges(
			"a\nb\nc\n",
			"a\nB\nc\n",
			hunks,
			3,
		);
		expect(added).toHaveLength(1);
		expect(added[0].start.line).toBe(1);
		expect(removed).toHaveLength(0);
	});

	it("marks the anchor line after a pure deletion as removed", () => {
		const hunks: EditHunk[] = [
			hunk({
				originalStartLine: 2,
				originalEndLine: 2,
				modifiedStartLine: 2,
				modifiedEndLine: 0,
				oldText: "b",
				newText: "",
			}),
		];
		const { added, removed } = computeDecorationRanges(
			"a\nb\nc\n",
			"a\nc\n",
			hunks,
			2,
		);
		expect(added).toHaveLength(0);
		expect(removed).toHaveLength(1);
		expect(removed[0].start.line).toBe(1); // line "c" (0-based 1)
	});

	it("skips deletions at EOF when no line follows to paint", () => {
		const hunks: EditHunk[] = [
			hunk({
				originalStartLine: 2,
				originalEndLine: 2,
				modifiedStartLine: 2,
				modifiedEndLine: 0,
				oldText: "b",
				newText: "",
			}),
		];
		const { added, removed } = computeDecorationRanges("a\nb", "a", hunks, 1);
		expect(added).toHaveLength(0);
		expect(removed).toHaveLength(0);
	});

	it("does not highlight accepted or rejected hunks", () => {
		const hunks: EditHunk[] = [
			hunk({
				originalStartLine: 2,
				originalEndLine: 2,
				modifiedStartLine: 2,
				modifiedEndLine: 2,
				oldText: "b",
				newText: "B",
				status: "accepted",
			}),
			hunk({
				hunkId: "h2",
				originalStartLine: 4,
				originalEndLine: 4,
				modifiedStartLine: 4,
				modifiedEndLine: 4,
				oldText: "d",
				newText: "D",
			}),
		];
		const { added } = computeDecorationRanges(
			"a\nb\nc\nd\n",
			"a\nB\nc\nD\n",
			hunks,
			4,
		);
		expect(added).toHaveLength(1);
		expect(added[0].start.line).toBe(3); // only the pending "D" line
	});

	it("recomputes positions after a partial reject shifted line numbers", () => {
		// Agent inserted "x" after line 1 and "y" after line 3. The user
		// rejected the first hunk, so the file now only contains the "y"
		// change — which moved from line 5 to line 4. The stored hunk
		// positions are stale; the recompute must highlight the new spot.
		const hunks: EditHunk[] = [
			hunk({
				hunkId: "h-rejected",
				modifiedStartLine: 2,
				modifiedEndLine: 2,
				oldText: "",
				newText: "x",
				status: "rejected",
			}),
			hunk({
				hunkId: "h-pending",
				modifiedStartLine: 5,
				modifiedEndLine: 5,
				oldText: "",
				newText: "y",
			}),
		];
		const { added } = computeDecorationRanges(
			"a\nb\nc\n",
			"a\nb\nc\ny\n",
			hunks,
			4,
		);
		expect(added).toHaveLength(1);
		expect(added[0].start.line).toBe(3); // 0-based line 4, not the stale 5
	});

	it("returns nothing when no hunks are pending", () => {
		const hunks: EditHunk[] = [
			hunk({
				oldText: "b",
				newText: "B",
				status: "accepted",
			}),
		];
		const { added, removed } = computeDecorationRanges(
			"a\nb\n",
			"a\nB\n",
			hunks,
			2,
		);
		expect(added).toHaveLength(0);
		expect(removed).toHaveLength(0);
	});

	it("skips recomputation for huge files (quadratic-diff guard)", () => {
		const big = "y\n".repeat(20_001);
		const hunks: EditHunk[] = [
			hunk({
				originalStartLine: 1,
				originalEndLine: 1,
				modifiedStartLine: 1,
				modifiedEndLine: 1,
				oldText: "x",
				newText: "y",
			}),
		];
		const { added, removed } = computeDecorationRanges(
			"x\n".repeat(20_001),
			big,
			hunks,
			20_001,
		);
		expect(added).toHaveLength(0);
		expect(removed).toHaveLength(0);
	});
});
