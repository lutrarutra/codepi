export type ExtensionMessage =
	| { command: "textDelta"; delta: string }
	| { command: "textEnd" }
	| { command: "thinkingDelta"; delta: string }
	| { command: "thinkingEnd" }
	| {
			command: "toolCallStart";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
	  }
	| { command: "toolCallUpdate"; toolCallId: string; text: string }
	| {
			command: "toolCallEnd";
			toolCallId: string;
			result: string;
			isError: boolean;
	  }
	| { command: "agentStart" }
	| { command: "agentEnd"; willRetry: boolean }
	| { command: "agentSettled" }
	| { command: "error"; text: string };

export type WebviewMessage =
	| { command: "prompt"; text: string }
	| { command: "steer"; text: string }
	| { command: "followUp"; text: string }
	| { command: "abort" }
	| { command: "setModel"; provider: string; modelId: string }
	| { command: "setThinkingLevel"; level: string }
	| { command: "newSession" }
	| { command: "resumeSession"; id: string }
	| { command: "listModels" }
	| { command: "listSessions" };

export interface ChatMessage {
	id: number;
	role: "user" | "assistant";
	text: string;
	thinking: string;
	toolCalls: ToolCallState[];
	complete: boolean;
	timestamp: number;
}

export interface ToolCallState {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	output: string;
	isError: boolean;
	running: boolean;
}
