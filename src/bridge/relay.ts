import type * as vscode from "vscode";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExtensionMessage } from "./protocol";

export class PiEventRelay {
	private webview: vscode.Webview | undefined;
	private unsubscribe: (() => void) | undefined;
	private _session: AgentSession | undefined;

	// Tracking stats
	private tokensIn = 0;
	private tokensOut = 0;
	private totalCost = 0;
	private speed = 0;
	private lastAssistantStart = 0;
	private contextUsed = 0;
	private lastMsgId = 0;
	private interactionStart = 0;
	private cacheRateSum = 0; // sum of cacheHitRate × outputTokens (weighted)
	private cacheRateWeight = 0; // total output tokens for cache rate weights

	setWebview(webview: vscode.Webview): void {
		this.webview = webview;
	}

	/** Subscribe to PI SDK events. */
	attach(session: AgentSession): void {
		this._session = session;
		this.unsubscribe = session.subscribe((event) => {
			switch (event.type) {
				case "message_update":
					this._handleMessageUpdate(event);
					break;
				case "message_start": {
					const msg = (event as any).message;
					if (msg?.role === "assistant") {
						this.interactionStart = Date.now();
						this.lastAssistantStart = Date.now();
						// Signal a new segment within this interaction
						this.post({ command: "segmentStart" });
						// Emit pre-existing thinking blocks for restored sessions
						if (msg.content) {
							for (const block of msg.content) {
								if (block.type === "thinking" && block.thinking) {
									this.post({ command: "thinkingDelta", delta: block.thinking });
								}
							}
						}
					}
					break;
				}
				case "message_end": {
					const msg = (event as any).message;
					if (msg?.role === "assistant") {
						if (msg.usage) {
							this.tokensIn += msg.usage.input ?? 0;
							this.tokensOut += msg.usage.output ?? 0;
							this.totalCost += msg.usage.cost?.total ?? 0;
							this.contextUsed = msg.usage.totalTokens ?? this.contextUsed;
							const input = msg.usage.input ?? 0;
							const cacheHit = msg.usage.cacheHitRate ?? 0;
							if (input > 0) {
								this.cacheRateSum += cacheHit * input;
								this.cacheRateWeight += input;
							}
							const elapsed = this.lastAssistantStart > 0 ? (Date.now() - this.lastAssistantStart) / 1000 : 1;
							this.speed = elapsed > 0.5 && msg.usage.output > 0 ? Math.round(msg.usage.output / elapsed) : this.speed;
						}
						this._emitSessionInfo();

						// Finalize current segment and emit per-turn stats
						const interactionId = `int-${++this.lastMsgId}`;
						const duration = this.interactionStart > 0 ? (Date.now() - this.interactionStart) / 1000 : 0;
						this.post({
							command: "segmentEnd",
							tokensIn: msg.usage?.input ?? 0,
							tokensOut: msg.usage?.output ?? 0,
							thinkingTokens: msg.usage?.thinking ?? 0,
							totalCost: msg.usage?.cost?.total ?? 0,
							modelProvider: String(this._session?.model?.provider ?? ""),
							modelId: String(this._session?.model?.id ?? ""),
							cacheHit: msg.usage?.cacheHitRate ?? 0,
							duration,
						});
					}
					break;
				}
				case "tool_execution_start":
					// toolCallStart already posted via _handleMessageUpdate's toolcall_start
					if (event.toolName === "ask_user_question") {
						const args = (event as any).args ?? {};
						if (args.questions && args.questions.length > 0) {
							this.post({
								command: "askQuestion",
								toolCallId: event.toolCallId,
								questions: args.questions,
							});
						}
					}
					// For todo tool, sync the full list from args to webview
					if (event.toolName === "todo") {
						const args = (event as any).args ?? {};
						if (args.todoList && Array.isArray(args.todoList)) {
							this.post({
								command: "todoUpdate",
								todos: args.todoList,
							});
						}
					}
					break;
				case "tool_execution_update": {
					const text =
						(event as any).partialResult?.content?.[0]?.text ?? "";
					this.post({
						command: "toolCallUpdate",
						toolCallId: event.toolCallId,
						text,
					});
					break;
				}
				case "tool_execution_end": {
					const text = (event as any).result?.content?.[0]?.text ?? "";
					this.post({
						command: "toolCallEnd",
						toolCallId: event.toolCallId,
						result: text,
						isError: event.isError,
					});
					// For todo tool, sync the confirmed list from result details
					if (event.toolName === "todo") {
						const details = (event as any).result?.details;
						if (details?.todoList && Array.isArray(details.todoList)) {
							this.post({
								command: "todoUpdate",
								todos: details.todoList,
							});
						}
					}
					break;
				}
				case "agent_start":
					this.post({ command: "agentStart" });
					break;
				case "agent_end":
					console.log("[CodePi] Prompt completed");
					this.post({
						command: "agentEnd",
						willRetry: event.willRetry,
					});
					break;
			}
		});

		// Emit initial model info and session info
		this._emitModelInfo(session);
	}

	detach(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this._session = undefined;
	}

	/** Emit model info on demand (e.g. after model switch). */
	emitModelInfo(): void {
		if (this._session) {
			this._emitModelInfo(this._session);
		}
	}

	/** Emit session info on demand. */
	emitSessionInfo(): void {
		this._emitSessionInfo();
	}

	/** Forward a message to the webview. */
	postMessageSilent(msg: ExtensionMessage): void {
		try {
			this.webview?.postMessage(msg);
		} catch {
			/* ignore */
		}
	}

	private post(msg: ExtensionMessage): void {
		this.postMessageSilent(msg);
	}

	private _emitModelInfo(session: AgentSession): void {
		if (session.model) {
			this.post({
				command: "modelInfo",
				provider: session.model.provider ?? "",
				modelId: session.model.id ?? "",
				thinkingLevel: session.thinkingLevel ?? "medium",
			});
		}
	}

	private _emitSessionInfo(): void {
		const avgCacheRate = this.cacheRateWeight > 0 ? this.cacheRateSum / this.cacheRateWeight : 0;
		this.post({
			command: "sessionInfo",
			tokensIn: this.tokensIn,
			tokensOut: this.tokensOut,
			totalCost: this.totalCost,
			contextUsed: this.contextUsed,
			contextLimit: this._session?.model?.contextWindow ?? 0,
			speed: this.speed,
			cacheRate: avgCacheRate,
		});
	}

	private _handleMessageUpdate(event: any): void {
		const e = event.assistantMessageEvent;
		if (e.type === "text_delta" && "delta" in e) {
			this.post({ command: "textDelta", delta: e.delta });
		} else if (e.type === "thinking_delta" && "delta" in e) {
			this.post({ command: "thinkingDelta", delta: e.delta });
		} else if (e.type === "text_end") {
			this.post({ command: "textEnd" });
		} else if (e.type === "thinking_end") {
			this.post({ command: "thinkingEnd" });
		} else if (e.type === "toolcall_start" && "toolCall" in e) {
			this.post({
				command: "toolCallStart",
				toolCallId: e.toolCall.id,
				toolName: e.toolCall.name,
				args: e.toolCall.arguments ?? {},
			});
		}
	}
}
