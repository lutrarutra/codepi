import type { ChatMessage } from "../types";

interface Props {
	message: ChatMessage;
}

export function MessageBubble({ message }: Props) {
	const isUser = message.role === "user";

	return (
		<div className={`chat-bubble ${isUser ? "user" : "assistant"}`}>
			<div className="chat-bubble-header">
				{isUser ? "You" : "CodePi"}
				<span className="chat-bubble-time">
					{new Date(message.timestamp).toLocaleTimeString([], {
						hour: "2-digit",
						minute: "2-digit",
					})}
				</span>
			</div>
			<div className="chat-bubble-text">
				{message.text || (!message.complete ? "..." : "")}
				{!message.complete && <span className="chat-typing-cursor">▊</span>}
			</div>
			{message.toolCalls.length > 0 && (
				<div className="chat-tool-calls">
					{message.toolCalls.map((tc) => (
						<div
							key={tc.toolCallId}
							className={`chat-tool-call ${tc.isError ? "error" : ""}`}
						>
							<div className="chat-tool-call-name">
								{tc.running ? "⏳" : tc.isError ? "❌" : "✅"} {tc.toolName}
							</div>
							{tc.output && (
								<pre className="chat-tool-call-output">
									{tc.output.slice(0, 2000)}
									{tc.output.length > 2000 ? "\n... (truncated)" : ""}
								</pre>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
