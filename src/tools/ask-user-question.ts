import type { VscodeTool } from "./index";

// ── Pending Questions Map ────────────────────────────────────

/**
 * Module-level pending questions, keyed by toolCallId.
 * When the tool's execute is called, it stores a promise here.
 * The extension resolves it when the webview sends back answers.
 */

type PendingEntry = {
	resolve: (value: unknown) => void;
	reject: (err: unknown) => void;
	questions: Question[];
};

const pending = new Map<string, PendingEntry>();

/** Resolve a pending question (called from extension when webview answers). */
export function resolveQuestion(
	toolCallId: string,
	answers: Record<string, QuestionAnswer>,
): void {
	const entry = pending.get(toolCallId);
	if (entry) {
		pending.delete(toolCallId);
		entry.resolve(answers ?? {});
	}
}

/** Reject a pending question (called from extension on abort/timeout). */
export function rejectQuestion(toolCallId: string, error: string): void {
	const entry = pending.get(toolCallId);
	if (entry) {
		pending.delete(toolCallId);
		entry.reject(new Error(error));
	}
}

export function getPendingQuestions(toolCallId: string): Question[] | undefined {
	return pending.get(toolCallId)?.questions;
}

// ── Types ────────────────────────────────────────────────────

export interface QuestionOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface Question {
	header: string;
	question: string;
	multiSelect?: boolean;
	allowFreeformInput?: boolean;
	options?: QuestionOption[];
}

export interface QuestionAnswer {
	selected: string[];
	freeText: string | null;
	skipped: boolean;
}

export interface AskQuestionsParams {
	questions: Question[];
}

// ── Tool Definition ──────────────────────────────────────────

export const askUserQuestionTool: VscodeTool = {
	name: "ask_user_question",
	label: "Ask User Question",
	description:
		"Ask the user structured clarifying questions before proceeding. " +
		"Provide questions with concise headers and clear prompts. " +
		"Use options for fixed choices, set multiSelect when multiple selections " +
		"are allowed. The user can always provide a freeform text answer alongside " +
		"options unless allowFreeformInput is set to false.",
	parameters: {
		type: "object",
		properties: {
			questions: {
				type: "array",
				description: "List of questions to ask the user. Order is preserved.",
				items: {
					type: "object",
					properties: {
						header: {
							type: "string",
							maxLength: 16,
							description:
								"Short label/tag shown next to the question (max 16 chars).",
						},
						question: {
							type: "string",
							maxLength: 200,
							description:
								"The question text to display to the user. Keep it concise.",
						},
						multiSelect: {
							type: "boolean",
							description:
								"Allow selecting multiple options. If false or omitted, only one option can be selected.",
						},
						allowFreeformInput: {
							type: "boolean",
							description:
								"Allow freeform text answers in addition to option selection. " +
								"Defaults to true; set to false to restrict to predefined options only.",
						},
						options: {
							type: "array",
							description:
								"Optional list of selectable answer choices. " +
								"If omitted, the question is free text.",
							items: {
								type: "object",
								properties: {
									label: {
										type: "string",
										maxLength: 60,
										description: "Display label and value for the option.",
									},
									description: {
										type: "string",
										description:
											"Optional secondary text shown with the option.",
									},
									preview: {
										type: "string",
										description:
											"Optional markdown preview when this option is focused.",
									},
								},
								required: ["label"],
							},
						},
					},
					required: ["header", "question"],
				},
				minItems: 1,
			},
		},
		required: ["questions"],
	},
	async execute(toolCallId, params) {
		const { questions } = params as AskQuestionsParams;
		if (!questions || questions.length === 0) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							answers: {},
						}),
					},
				],
				isError: true,
				details: {},
			};
		}

		// Store pending promise — extension/relay will resolve it when
		// the webview sends back answers.
		const result = await new Promise<Record<string, QuestionAnswer>>(
			(resolve, reject) => {
				// Wrap to create properly formatted tool result
				const wrappedResolve = (answers: Record<string, QuestionAnswer>) => {
					resolve(answers);
				};
				pending.set(toolCallId, {
					resolve: wrappedResolve,
					reject,
					questions,
				});
			},
		);

		return {
			content: [
				{ type: "text" as const, text: JSON.stringify({ answers: result }) },
			],
			details: {},
		};
	},
};
