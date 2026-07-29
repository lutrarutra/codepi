import { useCallback } from "react";
import { useVSCodeAPI } from "./hooks/useVSCodeAPI";
import { useStreaming } from "./hooks/useStreaming";
import { ChatView } from "./components/ChatView";
import { InputArea } from "./components/InputArea";

function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

export default function App() {
	const { state, handleExtensionMessage, addUserMessage } = useStreaming();
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
						availableModels={state.availableModels}
						availableTools={state.availableTools}
					/>
				</div>

				{/* Input */}
				<InputArea
					streaming={state.streaming}
					onSend={handleSend}
					onAbort={handleAbort}
					modelName={state.modelInfo.modelId}
					availableModels={state.availableModels}
					onModelSelect={handleModelSelect}
				/>

				{/* Session stats footer */}
				{(si.tokensIn > 0 || si.totalCost > 0) && (
					<div className="stats-bar">
						<span className="stat-item stat-up">↑{fmt(si.tokensIn)}</span>
						<span className="stat-item stat-down">↓{fmt(si.tokensOut)}</span>
						{si.totalCost > 0 && <span className="stat-item stat-cost">${si.totalCost.toFixed(3)}</span>}
						{si.contextLimit > 0 && <span className="stat-item stat-ctx">{ctxPct}%/{fmt(ctxLimit)}</span>}
						{si.speed > 0 && <span className="stat-item stat-speed">{fmt(si.speed)} t/s</span>}
					</div>
				)}
			</div>
		</div>
	);
}
