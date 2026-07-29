import { useRef, useEffect, useState, useCallback } from "react";
import type { ChatMessage, ModelOption } from "../types";
import { MessageBubble } from "./MessageBubble";

interface Props {
	messages: ChatMessage[];
	streaming: boolean;
	modelId: string;
	availableModels: ModelOption[];
	availableTools: string[];
}

function groupInteractions(msgs: ChatMessage[]): ChatMessage[][] {
	const groups: ChatMessage[][] = [];
	let i = 0;
	while (i < msgs.length) {
		if (msgs[i].role === "user") {
			const group = [msgs[i]];
			i++;
			while (i < msgs.length && msgs[i].role === "assistant") { group.push(msgs[i]); i++; }
			groups.push(group);
		} else { groups.push([msgs[i]]); i++; }
	}
	return groups;
}

/** Extract first line of text from message blocks */
function firstTextLine(msg: ChatMessage): string {
	for (const b of msg.blocks) {
		if (b.type === "text" && b.content.trim()) return b.content.split("\n")[0];
	}
	return "(message)";
}

/** Format timestamp to short time string */
function formatTimestamp(ts?: number): string {
	if (!ts) return "";
	const d = new Date(ts);
	return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Get model label from a group's assistant message stats */
function modelLabel(group: ChatMessage[]): string {
	for (const m of group) {
		if (m.role === "assistant" && m.interaction?.modelId) {
			return m.interaction.modelId.split(".").pop() || m.interaction.modelId;
		}
	}
	return "";
}

export function ChatView({ messages, streaming, modelId, availableModels, availableTools }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [userScrolledUp, setUserScrolledUp] = useState(false);
	const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
	const interactions = groupInteractions(messages);

	useEffect(() => {
		if (interactions.length > 1) {
			setCollapsed(prev => {
				const next = new Set(prev);
				for (let i = 0; i < interactions.length - 2; i++) next.add(i);
				if (streaming && interactions.length >= 2) next.add(interactions.length - 2);
				else next.delete(interactions.length - 1);
				return next;
			});
		}
	}, [interactions.length, streaming]);

	const handleScroll = useCallback(() => {
		const el = containerRef.current;
		if (!el) return;
		const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
		if (!isAtBottom && streaming) setUserScrolledUp(true);
		else if (isAtBottom) setUserScrolledUp(false);
	}, [streaming]);

	useEffect(() => {
		if (!userScrolledUp) requestAnimationFrame(() => { if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight; });
	}, [messages, userScrolledUp]);

	const scrollToBottom = useCallback(() => {
		if (containerRef.current) { containerRef.current.scrollTop = containerRef.current.scrollHeight; setUserScrolledUp(false); }
	}, []);

	const shortModel = modelId.split(".").pop() || modelId;

	return (
		<div className="chat-messages" ref={containerRef} onScroll={handleScroll}>
			{messages.length === 0 && (
				<div className="chat-empty">
					<div className="chat-empty-content">
                        <svg className="pi-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800">
                            <path fill="#fff" fill-rule="evenodd" d="
                                M165.29 165.29
                                H517.36
                                V400
                                H400
                                V517.36
                                H282.65
                                V634.72
                                H165.29
                                Z
                                M282.65 282.65
                                V400
                                H400
                                V282.65
                                Z
                            "/>
                            <path fill="#fff" d="M517.36 400 H634.72 V634.72 H517.36 Z"/>
                        </svg>
						<div className="welcome-info">
							<div className="welcome-info-item">
								<span className="welcome-info-key">model</span>
								<span className="welcome-info-val">{shortModel}</span>
							</div>
							{availableModels.length > 0 && (
								<div className="welcome-info-item">
									<span className="welcome-info-key">models</span>
									<span className="welcome-info-val">{availableModels.length}</span>
								</div>
							)}
							{availableTools.length > 0 && (
								<div className="welcome-info-item">
									<span className="welcome-info-key">tools</span>
									<span className="welcome-info-val">{availableTools.join(", ")}</span>
								</div>
							)}
						</div>
						<p className="welcome-hint">Your favourite agent meets your favourite editor.</p>
					</div>
				</div>
			)}
			{interactions.map((group, gi) => {
				const isCollapsed = collapsed.has(gi);
				const userMsg = group.find(m => m.role === "user");
				return (
					<div key={group[0]?.id || gi} className={`interaction-group ${isCollapsed ? "collapsed" : ""}`}>
						<button className="interaction-toggle" onClick={() => setCollapsed(prev => {
							const next = new Set(prev);
							if (next.has(gi)) next.delete(gi); else next.add(gi);
							return next;
						})}>
							{isCollapsed ? (
								<span className="interaction-collapsed-line">
									<span className="interaction-collapsed-dot" />
									<span className="interaction-collapsed-text">{firstTextLine(userMsg || group[0])}</span>
									<span className="interaction-collapsed-arrow">
										<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
									</span>
								</span>
							) : (
								<span className="interaction-expanded-line">
									<span className="interaction-expanded-dot" />
									{formatTimestamp(userMsg?.timestamp) ? (
										<span className="interaction-expanded-ts" suppressHydrationWarning>{formatTimestamp(userMsg?.timestamp)}</span>
									) : null}
									{modelLabel(group) && <span className="interaction-expanded-model">{modelLabel(group)}</span>}
									<span className="interaction-expanded-arrow">
										<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
									</span>
								</span>
							)}
						</button>
						{!isCollapsed && group.map(msg => (
							<div key={msg.id} className={`interactive-item-container ${msg.role === "user" ? "user" : "assistant"}`}>
								<div className="value"><MessageBubble message={msg} /></div>
							</div>
						))}
					</div>
				);
			})}
			{userScrolledUp && streaming && (
				<button className="scroll-bottom-btn" onClick={scrollToBottom} title="Jump to bottom">↓</button>
			)}
		</div>
	);
}
