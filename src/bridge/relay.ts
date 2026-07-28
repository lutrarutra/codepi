import type * as vscode from "vscode";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExtensionMessage } from "./protocol";

export class PiEventRelay {
	private webview: vscode.Webview | undefined;
	private unsubscribe: (() => void) | undefined;

	setWebview(webview: vscode.Webview): void {
		this.webview = webview;
	}

	/** Subscribe to PI SDK events (only used by the direct SDK approach) */
	attach(session: AgentSession): void {
		this.unsubscribe = session.subscribe((event) => {
			switch (event.type) {
				case "message_update":
					this._handleMessageUpdate(event);
					break;
				case "tool_execution_start":
					this.post({
						command: "toolCallStart",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: (event as { args?: Record<string, unknown> }).args ?? {},
					});
					break;
				case "tool_execution_update": {
					const text = (event as any).partialResult?.content?.[0]?.text ?? "";
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
					break;
				}
				case "message_start": {
					const msg = (
						event as {
							message?: {
								role?: string;
								content?: Array<{ type: string; thinking?: string }>;
							};
						}
					).message;
					if (msg?.role === "assistant" && msg.content) {
						for (const block of msg.content) {
							if (block.type === "thinking" && block.thinking) {
								this.post({ command: "thinkingDelta", delta: block.thinking });
							}
						}
					}
					break;
				}
				case "message_end": {
					const msg = (
						event as {
							message?: {
								role?: string;
								content?: Array<{
									type: string;
									text?: string;
									thinking?: string;
									id?: string;
									name?: string;
									arguments?: Record<string, unknown>;
									input?: Record<string, unknown>;
								}>;
							};
						}
					).message;
					if (msg?.role === "assistant" && msg.content) {
						for (const block of msg.content) {
							if (block.type === "thinking" && block.thinking) {
								this.post({ command: "thinkingDelta", delta: block.thinking });
								this.post({ command: "thinkingEnd" });
							} else if (block.type === "text" && block.text) {
								this.post({ command: "textDelta", delta: block.text });
								this.post({ command: "textEnd" });
							} else if (
								(block.type === "toolCall" || block.type === "tool_use") &&
								block.id &&
								block.name
							) {
								this.post({
									command: "toolCallStart",
									toolCallId: block.id,
									toolName: block.name,
									args: block.arguments ?? block.input ?? {},
								});
							}
						}
					}
					break;
				}
				case "agent_start":
					this.post({ command: "agentStart" });
					break;
				case "agent_end":
					console.log("[CodePi] Prompt completed");
					this.post({ command: "agentEnd", willRetry: event.willRetry });
					break;
			}
		});
	}

	detach(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	/** Forward a message to the webview */
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
