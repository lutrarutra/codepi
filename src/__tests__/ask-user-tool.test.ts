import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
	window: {
		showQuickPick: vi.fn(),
		showInputBox: vi.fn(),
	},
}));

import * as vscode from "vscode";
import { askUserQuestionTool } from "../tools/ask-user-question";

const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;
const showInputBox = vscode.window.showInputBox as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
	showQuickPick.mockReset();
	showInputBox.mockReset();
});

describe("askUserQuestionTool", () => {
	it("maps single-pick choices to labels", async () => {
		showQuickPick.mockResolvedValue({ label: "Option B" });
		const res = await askUserQuestionTool.execute("t1", {
			questions: [{ question: "Pick one", options: [{ label: "Option A" }, { label: "Option B" }] }],
		});
		const text = res.content[0].text as string;
		expect(text).toContain('"Pick one": "Option B"');
	});

	it("maps multi-select choices to label arrays", async () => {
		showQuickPick.mockResolvedValue([{ label: "A" }, { label: "C" }]);
		const res = await askUserQuestionTool.execute("t2", {
			questions: [{ question: "Pick many", options: [{ label: "A" }, { label: "B" }, { label: "C" }], multiSelect: true }],
		});
		const text = res.content[0].text as string;
		expect(text).toContain('"Pick many": [');
		expect(text).toContain('"A"');
		expect(text).toContain('"C"');
	});

	it("uses the input box for free-text questions", async () => {
		showInputBox.mockResolvedValue("hello");
		const res = await askUserQuestionTool.execute("t3", {
			questions: [{ question: "Say something", default: "" }],
		});
		expect(res.content[0].text as string).toContain('"Say something": "hello"');
	});

	it("reports dismissal", async () => {
		showQuickPick.mockResolvedValue(undefined);
		const res = await askUserQuestionTool.execute("t4", {
			questions: [{ question: "Pick one", options: [{ label: "A" }] }],
		});
		expect(res.content[0].text as string).toContain("dismissed");
	});
});
