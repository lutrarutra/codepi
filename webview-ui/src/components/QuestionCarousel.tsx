import { useState, useCallback, useRef, useReducer } from "react";
import type { Question, QuestionAnswer } from "../types";

interface Props {
	questions: Question[];
	toolCallId: string;
	onSubmit: (toolCallId: string, answers: Record<string, QuestionAnswer>) => void;
	onDismiss: (toolCallId: string) => void;
}

interface AnswerEntry {
	selected: Set<string>;
	freeText: string;
	skipped: boolean;
}

type AnswersState = Record<string, AnswerEntry>;

type AnswersAction =
	| { type: "select"; header: string; label: string; multiSelect: boolean }
	| { type: "freeText"; header: string; text: string };

function answersReducer(state: AnswersState, action: AnswersAction): AnswersState {
	switch (action.type) {
		case "select": {
			const entry = state[action.header];
			if (!entry) return state;
			const next = new Set(entry.selected);
			if (action.multiSelect) {
				if (next.has(action.label)) next.delete(action.label);
				else next.add(action.label);
			} else {
				next.clear();
				next.add(action.label);
			}
			return { ...state, [action.header]: { ...entry, selected: next } };
		}
		case "freeText": {
			const entry = state[action.header];
			if (!entry) return state;
			return { ...state, [action.header]: { ...entry, freeText: action.text } };
		}
	}
}

/** Safe .has() on a potentially-undefined Set. */
function safeHas(s: Set<string> | undefined, v: string): boolean {
	return s ? s.has(v) : false;
}

export function QuestionCarousel({
	questions,
	toolCallId,
	onSubmit,
	onDismiss,
}: Props) {
	const [currentIndex, setCurrentIndex] = useState(0);

	// Store callbacks in refs to avoid stale closures in the reducer callbacks
	const onSubmitRef = useRef(onSubmit);
	onSubmitRef.current = onSubmit;
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;
	const questionsRef = useRef(questions);
	questionsRef.current = questions;

	const [answers, dispatch] = useReducer(answersReducer, null, () => {
		const initial: AnswersState = {};
		for (const q of questions) {
			initial[q.header] = {
				selected: new Set<string>(),
				freeText: "",
				skipped: false,
			};
		}
		return initial;
	});

	const total = questions.length;
	const current = currentIndex < total ? questions[currentIndex] : null;

	const handleNext = useCallback(() => {
		setCurrentIndex((i) => (i < total - 1 ? i + 1 : i));
	}, [total]);

	const handlePrev = useCallback(() => {
		setCurrentIndex((i) => (i > 0 ? i - 1 : i));
	}, []);

	const handleSelect = useCallback(
		(header: string, label: string, multiSelect: boolean) => {
			dispatch({ type: "select", header, label, multiSelect });
		},
		[],
	);

	const handleFreeText = useCallback(
		(header: string, text: string) => {
			dispatch({ type: "freeText", header, text });
		},
		[],
	);

	const handleSubmit = useCallback(() => {
		// Read latest answers state from ref to avoid stale closure
		const currentAnswers = answers; // This IS the latest from useReducer
		const result: Record<string, QuestionAnswer> = {};
		for (const q of questionsRef.current) {
			const a = currentAnswers[q.header];
			result[q.header] = a
				? {
						selected: Array.from(a.selected),
						freeText: a.freeText || null,
						skipped: a.skipped,
				  }
				: { selected: [], freeText: null, skipped: true };
		}
		onSubmitRef.current(toolCallId, result);
	}, [answers, toolCallId]);

	const handleSkip = useCallback(() => {
		onDismissRef.current(toolCallId);
	}, [toolCallId]);

	const handleFooterClick = useCallback(() => {
		if (currentIndex === total - 1) {
			handleSubmit();
		} else {
			handleNext();
		}
	}, [currentIndex, total, handleSubmit, handleNext]);

	if (!current) return null;

	return (
		<div className="question-carousel">
			{/* Header */}
			<div className="question-carousel-header">
				<span className="question-step-indicator">
					{currentIndex + 1}/{total}
				</span>
				{total > 1 && (
					<div className="question-carousel-nav">
						<button
							className="question-nav-btn"
							disabled={currentIndex === 0}
							onClick={handlePrev}
							title="Previous question"
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<polyline points="15 18 9 12 15 6" />
							</svg>
						</button>
						<button
							className="question-nav-btn"
							disabled={currentIndex === total - 1}
							onClick={handleNext}
							title="Next question"
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<polyline points="9 18 15 12 9 6" />
							</svg>
						</button>
					</div>
				)}
				<button className="question-skip-btn" onClick={handleSkip} title="Skip all questions">
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>
			</div>

			{/* Question */}
			<div className="question-carousel-body">
				<div className="question-header-tag">{current.header}</div>
				<div className="question-text">{current.question}</div>

				{current.options && current.options.length > 0 && (
					<div className="question-options">
						{current.options.map((opt) => {
							const isSelected = safeHas(
								answers[current.header]?.selected,
								opt.label,
							);
							return (
								<button
									key={opt.label}
									className={`question-option-btn ${isSelected ? "selected" : ""}`}
									onClick={() =>
										handleSelect(
											current.header,
											opt.label,
											current.multiSelect ?? false,
										)
									}
								>
									<span className="question-option-marker">
										{isSelected
											? (current.multiSelect ? "☑" : "●")
											: (current.multiSelect ? "□" : "○")}
									</span>
									<span className="question-option-content">
										<span className="question-option-label">
											{opt.label}
										</span>
										{opt.description && (
											<span className="question-option-desc">
												{opt.description}
											</span>
										)}
									</span>
								</button>
							);
						})}
					</div>
				)}

				{current.allowFreeformInput !== false && (
					<textarea
						className="question-freeform-input"
						placeholder={
							current.options && current.options.length > 0
								? "Or type a custom answer..."
								: "Type your answer..."
						}
						rows={2}
						value={answers[current.header]?.freeText ?? ""}
						onChange={(e) =>
							handleFreeText(current.header, e.target.value)
						}
					/>
				)}
			</div>

			{/* Footer */}
			<div className="question-carousel-footer">
				<span className="question-submit-hint">
					{currentIndex === total - 1
						? "⏎ to submit"
						: "⏎ for next question"}
				</span>
				<button
					className="question-submit-btn"
					onClick={handleFooterClick}
				>
					{currentIndex === total - 1 ? "Submit" : "Next →"}
				</button>
			</div>
		</div>
	);
}
