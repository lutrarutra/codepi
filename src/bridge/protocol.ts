import type { Question, QuestionAnswer } from "../tools/ask-user-question";

// ── Extension → Webview messages ─────────────────────────────────

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
	| { command: "error"; text: string }
	// Session / model info
	| { command: "sessionInfo"; tokensIn: number; tokensOut: number; totalCost: number; contextUsed: number; contextLimit: number; speed: number; cacheRate: number }
	| { command: "modelInfo"; provider: string; modelId: string; thinkingLevel: string }
	| { command: "modelList"; models: Array<{ provider: string; modelId: string }> }
	| { command: "toolsInfo"; tools: string[] }
	| { command: "modeInfo"; mode: "ask" | "plan" | "agent" }
	| { command: "backendReady" }
	// Segment lifecycle — multiple segments within one message bubble
	| { command: "segmentStart" }
	| {
			command: "segmentEnd";
			tokensIn: number;
			tokensOut: number;
			thinkingTokens: number;
			totalCost: number;
			modelProvider: string;
			modelId: string;
			cacheHit: number;
			duration: number;
	  }
	// History restoration when opening existing session
	| { command: "restoreMessages"; messages: RestoredChatMessage[] }
	// Question flow — tool call pending user answers
	| { command: "askQuestion"; toolCallId: string; questions: Question[] };

// ── Webview → Extension messages ─────────────────────────────────

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
	| { command: "copyToClipboard"; text: string }
	// Question flow — user answers a pending question
	| { command: "answerQuestion"; toolCallId: string; answers: Record<string, QuestionAnswer> | null };

// ── Restored message format (for session history restoration) ──

export interface RestoredContentBlock {
	type: "text" | "thinking";
	content: string;
}

export interface RestoredChatMessage {
	id: string;
	role: "user" | "assistant";
	blocks: RestoredContentBlock[];
	toolCalls: Array<{
		toolCallId: string;
		toolName: string;
		args: Record<string, unknown>;
		output: string;
		isError: boolean;
	}>;
	timestamp: number;
}