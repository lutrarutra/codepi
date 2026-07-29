import { useCallback } from "react";
import { useVSCodeAPI } from "./hooks/useVSCodeAPI";
import { useStreaming, type PendingQuestion } from "./hooks/useStreaming";
import { ChatView } from "./components/ChatView";
import { InputArea } from "./components/InputArea";
import { QuestionCarousel } from "./components/QuestionCarousel";
import { ErrorBoundary } from "./components/ErrorBoundary";

function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

export default function AppWithErrorBoundary() {
	return (
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	);
}

// ── Inner App ────────────────────────────────────────────────

function App() {
	const { state, handleExtensionMessage, addUserMessage, setMode, setThinkingLevel, clearPendingQuestion, addQuestionBlock } = useStreaming();
	const { post } = useVSCodeAPI(handleExtensionMessage);

	const handleSend = useCallback(
		(text: string) => {
			addUserMessage(text);
			post({ command: "prompt", text });
		},
		[post, addUserMessage],
	);

	const handleAbort = useCallback(() => {
		post({ command: "abort" });
	}, [post]);

	const handleModelSelect = useCallback(
		(provider: string, modelId: string) => {
			post({ command: "setModel", provider, modelId });
		},
		[post],
	);

	const handleModeChange = useCallback(
		(mode: "ask" | "plan" | "agent") => {
			setMode(mode);
			post({ command: "setMode", mode });
		},
		[post, setMode],
	);

	const handleThinkingLevelChange = useCallback(
		(level: string) => {
			setThinkingLevel(level);
			post({ command: "setThinkingLevel", level });
		},
		[post, setThinkingLevel],
	);

	const handleQuestionSubmit = useCallback(
		(toolCallId: string, answers: Record<string, any>) => {
			post({ command: "answerQuestion", toolCallId, answers });
			// Add Q&A block to the assistant message before clearing
			if (state.pendingQuestion) {
				addQuestionBlock(state.pendingQuestion.questions, answers);
			}
			clearPendingQuestion();
		},
		[post, clearPendingQuestion, addQuestionBlock, state.pendingQuestion],
	);

	const handleQuestionDismiss = useCallback(
		(toolCallId: string) => {
			post({ command: "answerQuestion", toolCallId, answers: null });
			clearPendingQuestion();
		},
		[post, clearPendingQuestion],
	);

	const si = state.sessionInfo;
	const ctxLimit = si.contextLimit || 200_000;
	const ctxPct = Math.min(100, Math.round((si.contextUsed / ctxLimit) * 100));

	if (!state.backendReady) {
		return (
			<div className="app">
				<div className="loading-screen">
					<div className="loading-spinner" />
					<p className="loading-text">Initializing agent...</p>
				</div>
			</div>
		);
	}

	return (
		<div className="app">
			{/* Main chat area */}
			<div className="chat-controls-container">
				<div className="interactive-session">
					<ChatView
						messages={state.messages}
						streaming={state.streaming}
						modelId={state.modelInfo.modelId}
						availableTools={state.availableTools}
						mode={state.mode}
					/>
					{state.pendingQuestion && (
						<QuestionCarousel
							questions={state.pendingQuestion.questions}
							toolCallId={state.pendingQuestion.toolCallId}
							onSubmit={handleQuestionSubmit}
							onDismiss={handleQuestionDismiss}
						/>
					)}
				</div>

				{/* Input — hidden while questions are pending */}
				{!state.pendingQuestion && (
					<InputArea
						streaming={state.streaming}
						onSend={handleSend}
						onAbort={handleAbort}
						modelName={state.modelInfo.modelId}
						availableModels={state.availableModels}
						onModelSelect={handleModelSelect}
						mode={state.mode}
						onModeChange={handleModeChange}
						thinkingLevel={state.thinkingLevel}
						onThinkingLevelChange={handleThinkingLevelChange}
					/>
				)}
				{(si.tokensIn > 0 || si.totalCost > 0) && (
					<div className="stats-bar">
						<span className="stat-item stat-up">↑{fmt(si.tokensIn)}</span>
						<span className="stat-item stat-down">↓{fmt(si.tokensOut)}</span>
						{si.totalCost > 0 && <span className="stat-item stat-cost">${si.totalCost.toFixed(3)}</span>}
						{si.contextLimit > 0 && <span className="stat-item stat-ctx">{ctxPct}%/{fmt(ctxLimit)}</span>}
						{si.speed > 0 && <span className="stat-item stat-speed">{fmt(si.speed)} t/s</span>}
						{si.cacheRate > 0 && <span className="stat-item stat-cache" data-tip={`Cache: ${(si.cacheRate * 100).toFixed(1)}%`}>
							<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
							{(si.cacheRate * 100).toFixed(0)}%
						</span>}
					</div>
				)}
			</div>
		</div>
	);
}
