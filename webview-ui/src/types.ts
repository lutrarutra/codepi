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
	| {
			command: "sessionInfo";
			tokensIn: number;
			tokensOut: number;
			totalCost: number;
			contextUsed: number;
			contextLimit: number;
			speed: number;
			cacheRate: number;
	  }
	| {
			command: "modelInfo";
			provider: string;
			modelId: string;
			thinkingLevel: string;
	  }
	| {
			command: "modelList";
			models: Array<{ provider: string; modelId: string }>;
	  }
	| { command: "toolsInfo"; tools: string[] }
	| { command: "modeInfo"; mode: "ask" | "plan" | "agent" }
	| { command: "backendReady" }
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
	// Question flow — tool call pending user answers
	| { command: "askQuestion"; toolCallId: string; questions: Question[] }
	// Todo list updates from extension
	| { command: "todoUpdate"; todos: TodoItem[] }
	// Replay events for session history (same pipeline as live chat)
	| { command: "replayEvents"; events: ReplayEvent[] };

/** Subset of ExtensionMessage used in replay — excludes replayEvents itself to avoid circular types. */
export type ReplayEvent =
	| { command: "agentStart" }
	| { command: "segmentStart" }
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
	| { command: "agentEnd"; willRetry: boolean }
	| { command: "error"; text: string }
	| {
			command: "sessionInfo";
			tokensIn: number;
			tokensOut: number;
			totalCost: number;
			contextUsed: number;
			contextLimit: number;
			speed: number;
			cacheRate: number;
	  }
	| {
			command: "modelInfo";
			provider: string;
			modelId: string;
			thinkingLevel: string;
	  }
	| { command: "toolsInfo"; tools: string[] }
	| { command: "modeInfo"; mode: "ask" | "plan" | "agent" };

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
	| {
			command: "answerQuestion";
			toolCallId: string;
			answers: Record<string, QuestionAnswer> | null;
	  }
	// Todo list user interactions
	| { command: "todoChange"; todos: TodoItem[] };

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
	| { type: "text"; content: string }
	| {
			type: "qa_block";
			questions: Question[];
			answers: Record<string, QuestionAnswer>;
	  };

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
	cacheRate: number;
}

export interface ModelOption {
	provider: string;
	modelId: string;
}

// ── Question/Answer types (for ask_user_question tool) ───────────

export interface QuestionOption {
	label: string;
	description?: string;
	preview?: string;
}

export interface Question {
	header: string;
	question: string;
	multiSelect?: boolean;
	allowFreeformInput?: boolean;
	options?: QuestionOption[];
}

export interface QuestionAnswer {
	selected: string[];
	freeText: string | null;
	skipped: boolean;
}

// ── Todo types ───────────────────────────────────────────────

export interface TodoItem {
	id: number;
	title: string;
	status: "not-started" | "in-progress" | "completed";
}
