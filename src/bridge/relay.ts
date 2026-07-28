import type * as vscode from "vscode";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExtensionMessage } from "./protocol";

export class PiEventRelay {
	private webview: vscode.Webview | undefined;
	private unsubscribe: (() => void) | undefined;

	setWebview(webview: vscode.Webview): void {
		this.webview = webview;
	}

	attach(session: AgentSession): void {
		this.unsubscribe = session.subscribe((event) => {
			switch (event.type) {
				case "message_update": {
					const e = event.assistantMessageEvent;
					if (e.type === "text_delta" && "delta" in e) {
						this.post({
							command: "textDelta",
							delta: (e as { delta: string }).delta,
						});
					} else if (e.type === "thinking_delta" && "delta" in e) {
						this.post({
							command: "thinkingDelta",
							delta: (e as { delta: string }).delta,
						});
					} else if (e.type === "text_end") {
						this.post({ command: "textEnd" });
					} else if (e.type === "thinking_end") {
						this.post({ command: "thinkingEnd" });
					} else if (e.type === "toolcall_start" && "toolCall" in e) {
						const tc = (
							e as {
								toolCall: {
									id: string;
									name: string;
									arguments?: Record<string, unknown>;
								};
							}
						).toolCall;
						this.post({
							command: "toolCallStart",
							toolCallId: tc.id,
							toolName: tc.name,
							args: tc.arguments ?? {},
						});
					}
					break;
				}
				case "tool_execution_start":
					this.post({
						command: "toolCallStart",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: (event as { args?: Record<string, unknown> }).args ?? {},
					});
					break;
				case "tool_execution_update": {
					const content = (
						event.partialResult as
							| { content?: Array<{ text: string }> }
							| undefined
					)?.content;
					const text = content?.[0]?.text ?? "";
					this.post({
						command: "toolCallUpdate",
						toolCallId: event.toolCallId,
						text,
					});
					break;
				}
				case "tool_execution_end": {
					const content = (
						event.result as { content?: Array<{ text: string }> } | undefined
					)?.content;
					const text = content?.[0]?.text ?? "";
					this.post({
						command: "toolCallEnd",
						toolCallId: event.toolCallId,
						result: text,
						isError: event.isError,
					});
					break;
				}
				case "agent_start":
					this.post({ command: "agentStart" });
					break;
				case "agent_end":
					this.post({ command: "agentEnd", willRetry: event.willRetry });
					break;
			}
		});
	}

	detach(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private post(msg: ExtensionMessage): void {
		this.webview?.postMessage(msg);
	}
}
