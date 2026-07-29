export type ExtensionMessage =
	| { command: "textDelta"; delta: string }
	| { command: "textEnd" }
	| { command: "thinkingDelta"; delta: string }
	| { command: "thinkingEnd" }
	| { command: "toolCallStart"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { command: "toolCallUpdate"; toolCallId: string; text: string }
	| { command: "toolCallEnd"; toolCallId: string; result: string; isError: boolean }
	| { command: "agentStart" }
	| { command: "agentEnd"; willRetry: boolean }
	| { command: "agentSettled" }
	| { command: "error"; text: string }
	| { command: "sessionInfo"; tokensIn: number; tokensOut: number; totalCost: number; contextUsed: number; contextLimit: number; speed: number }
	| { command: "modelInfo"; provider: string; modelId: string; thinkingLevel: string }
	| { command: "modelList"; models: Array<{ provider: string; modelId: string }> }
	| { command: "toolsInfo"; tools: string[] }
	| { command: "backendReady" }
	| { command: "segmentStart" }
	| { command: "segmentEnd"; tokensIn: number; tokensOut: number; thinkingTokens: number; totalCost: number; modelProvider: string; modelId: string; cacheHit: number; duration: number };

export type WebviewMessage =
	| { command: "prompt"; text: string }
	| { command: "steer"; text: string }
	| { command: "followUp"; text: string }
	| { command: "abort" }
	| { command: "setModel"; provider: string; modelId: string }
	| { command: "setThinkingLevel"; level: string }
	| { command: "setMode"; mode: "ask" | "plan" | "agent" }
	| { command: "newSession" }
	| { command: "resumeSession"; id: string }
	| { command: "listModels" }
	| { command: "listSessions" }
	| { command: "copyToClipboard"; text: string };

export interface ToolCallState {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	output: string;
	isError: boolean;
	running: boolean;
}

export interface InteractionStats {
	interactionId: string;
	tokensIn: number;
	tokensOut: number;
	thinkingTokens: number;
	responseTokens: number;
	totalCost: number;
	modelProvider: string;
	modelId: string;
	cacheHit: number;
	duration: number;
}

export type ContentBlock =
	| { type: "thinking"; content: string }
	| { type: "text"; content: string };

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	blocks: ContentBlock[];
	toolCalls: ToolCallState[];
	interaction?: InteractionStats;
	complete: boolean;
	timestamp: number;
}

export interface SessionStats {
	tokensIn: number;
	tokensOut: number;
	totalCost: number;
	contextUsed: number;
	contextLimit: number;
	speed: number;
}

export interface ModelOption {
	provider: string;
	modelId: string;
}
