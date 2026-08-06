import { describe, expect, it, vi } from "vitest";

const vscodeMock = vi.hoisted(() => ({
	registeredProvider: undefined as any,
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
		constructor(
			public readonly start: any,
			public readonly end: any,
		) {}
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
		Uri: { parse: (value: string) => ({ toString: () => value }) },
		window: {
			visibleTextEditors: [],
			onDidChangeActiveTextEditor: () => ({ dispose: vi.fn() }),
			onDidChangeVisibleTextEditors: () => ({ dispose: vi.fn() }),
			createTextEditorDecorationType: vscodeMock.createDecorationType,
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

import { ReviewDecorations } from "../review/decorations";

function proposal() {
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
		hunks: [
			{
				hunkId: "h1",
				originalStartLine: 1,
				originalEndLine: 1,
				modifiedStartLine: 1,
				modifiedEndLine: 1,
				oldText: "old",
				newText: "new",
				status: "pending" as const,
			},
		],
	};
}

describe("ReviewDecorations", () => {
	it("keeps only file-level accept/reject actions, not snippet decorations", () => {
		const review = new ReviewDecorations();
		review.setProposal(proposal());

		const provider = vscodeMock.registeredProvider;
		const lenses = provider.provideCodeLenses({
			uri: { toString: () => "file:///workspace/a.ts" },
		});

		expect(vscodeMock.createDecorationType).not.toHaveBeenCalled();
		expect(lenses).toHaveLength(2);
		expect(lenses.map((lens: any) => lens.command.command)).toEqual([
			"codepi.acceptFile",
			"codepi.rejectFile",
		]);
		review.dispose();
	});
});
