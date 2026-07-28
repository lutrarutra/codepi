import { useRef, useEffect } from "react";
import type { ChatMessage } from "../types";
import { MessageBubble } from "./MessageBubble";

interface Props {
	messages: ChatMessage[];
}

export function ChatView({ messages }: Props) {
	const bottomRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	return (
		<div className="chat-messages">
			{messages.length === 0 && (
				<div className="chat-empty">
					<p>Ask CodePi anything about your codebase.</p>
				</div>
			)}
			{messages.map((msg) => (
				<MessageBubble key={msg.id} message={msg} />
			))}
			<div ref={bottomRef} />
		</div>
	);
}
