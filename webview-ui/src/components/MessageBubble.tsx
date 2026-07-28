import { useState, useEffect } from "react";
import type { ChatMessage } from "../types";

interface Props {
	message: ChatMessage;
}

export function MessageBubble({ message }: Props) {
	const isUser = message.role === "user";
	const [thinkingExpanded, setThinkingExpanded] = useState(false);
	const thinkingLines = message.thinking
		? message.thinking.split("\n").length
		: 0;

	// Auto-expand while streaming, collapse when done if >10 lines
	useEffect(() => {
		if (message.complete && thinkingLines > 10) {
			setThinkingExpanded(false);
		} else if (!message.complete) {
			setThinkingExpanded(true);
		}
	}, [message.complete, thinkingLines]);

	const hasContent = message.text || message.toolCalls.length > 0;

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

			{/* Thinking block — shown when thinking but no text output yet */}
			{message.thinking && !hasContent && (
				<div className="chat-thinking-block">
					<div
						className="chat-thinking-header"
						onClick={() =>
							message.complete && setThinkingExpanded(!thinkingExpanded)
						}
					>
						{!message.complete
							? "🧠 Thinking…"
							: `🧠 Thought for a bit (${thinkingLines} lines)`}
						{message.complete && (
							<span className="chat-thinking-toggle">
								{thinkingExpanded ? "▲" : "▼"}
							</span>
						)}
					</div>
					{thinkingExpanded && (
						<pre className="chat-thinking-content">
							{message.thinking.slice(-3000)}
						</pre>
					)}
				</div>
			)}

			{/* Main text content */}
			{message.text && (
				<div className="chat-bubble-text">
					{message.text}
					{!message.complete && <span className="chat-typing-cursor">▊</span>}
				</div>
			)}

			{/* Loading indicator when nothing at all yet */}
			{!message.complete && !message.text && !message.thinking && (
				<div className="chat-loading">
					<span className="chat-typing-cursor">▊</span> Waiting for response…
				</div>
			)}

			{/* Empty complete message */}
			{message.complete &&
				!message.text &&
				!message.thinking &&
				message.toolCalls.length === 0 && (
					<div className="chat-bubble-text">(no response)</div>
				)}

			{/* Tool calls */}
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
