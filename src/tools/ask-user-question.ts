import * as vscode from "vscode";
import type { VscodeTool } from "./index";

// ── Types ────────────────────────────────────────────────────

export interface QuestionOption {
	label: string;
	description?: string;
	detail?: string;
}

export interface Question {
	question: string;
	options?: QuestionOption[];
	multiSelect?: boolean;
	default?: string;
}

export type QuestionAnswer = string | string[] | undefined;

export interface AskQuestionsParams {
	questions: Question[];
}

// ── Tool ─────────────────────────────────────────────────────

/**
 * ask_user — asks the user one or more questions using native VS Code UI
 * (QuickPick for options, input box for free text). Self-contained: the answer
 * is resolved here, so it works under the native TUI where no chat webview
 * exists to round-trip answers.
 */
export const askUserQuestionTool: VscodeTool = {
	name: "ask_user_question",
	label: "Ask User",
	description:
		"Ask the user one or more questions. For each question, provide a list of options when possible; the user picks one (or several when multiSelect is true). Free-text questions are fine too.",
	parameters: {
		type: "object",
		properties: {
			questions: {
				type: "array",
				description: "One or more questions to ask sequentially.",
				items: {
					type: "object",
					properties: {
						question: { type: "string" },
						options: {
							type: "array",
							items: {
								type: "object",
								properties: {
									label: { type: "string" },
									description: { type: "string" },
									detail: { type: "string" },
								},
								required: ["label"],
							},
						},
						multiSelect: { type: "boolean" },
						default: { type: "string" },
					},
					required: ["question"],
				},
			},
		},
		required: ["questions"],
	},
	async execute(_toolCallId, params) {
		const { questions } = params as unknown as AskQuestionsParams;
		const answers: Record<string, QuestionAnswer> = {};
		for (const q of questions ?? []) {
			if (q.options && q.options.length > 0) {
				const picked = (await vscode.window.showQuickPick(q.options, {
					title: q.question,
					placeHolder: q.question,
					canPickMany: q.multiSelect === true,
					ignoreFocusOut: false,
				})) as QuestionOption | QuestionOption[] | undefined;
				if (!picked) {
					continue; // dismissed — not recorded, reported as dismissal
				}
				answers[q.question] = Array.isArray(picked)
					? picked.map((p) => p.label)
					: picked.label;
			} else {
				const text = await vscode.window.showInputBox({
					title: q.question,
					prompt: q.question,
					value: q.default ?? "",
					ignoreFocusOut: false,
				});
				if (text !== undefined) answers[q.question] = text;
			}
		}
		return {
			content: [
				{
					type: "text" as const,
					text:
						Object.keys(answers).length === 0
							? "The user dismissed the questions without answering."
							: JSON.stringify(answers, null, 2),
				},
			],
			details: { answers },
		};
	},
};
