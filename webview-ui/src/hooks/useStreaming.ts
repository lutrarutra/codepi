import { useReducer, useCallback } from "react";
import type { ChatMessage, ContentBlock, ExtensionMessage, SessionStats, ModelOption, RestoredChatMessage } from "../types";

export interface PendingQuestion {
	toolCallId: string;
	questions: import("../types").Question[];
}

export interface ChatState {
	messages: ChatMessage[];
	streaming: boolean;
	backendReady: boolean;
	sessionInfo: SessionStats;
	modelInfo: { provider: string; modelId: string; thinkingLevel: string };
	availableModels: ModelOption[];
	availableTools: string[];
	mode: "ask" | "plan" | "agent";
	thinkingLevel: string;
	error: string | null;
	/** Pending question carousel awaiting user answers */
	pendingQuestion: PendingQuestion | null;
}

type Action =
	| { type: "addUserMessage"; text: string }
	| { type: "startAssistantMessage" }
	| { type: "segmentStart" }
	| { type: "textDelta"; delta: string }
	| { type: "thinkingDelta"; delta: string }
	| { type: "thinkingEnd" }
	| { type: "toolCallStart"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| { type: "toolCallUpdate"; toolCallId: string; text: string }
	| { type: "toolCallEnd"; toolCallId: string; result: string; isError: boolean }
	| { type: "segmentEnd"; tokensIn: number; tokensOut: number; thinkingTokens: number; totalCost: number; modelProvider: string; modelId: string; cacheHit: number; duration: number }
	| { type: "agentEnd" }
	| { type: "error"; text: string }
	| { type: "sessionInfo"; info: SessionStats }
	| { type: "modelInfo"; provider: string; modelId: string; thinkingLevel: string }
	| { type: "toolsInfo"; tools: string[] }
	| { type: "modelList"; models: ModelOption[] }
	| { type: "setMode"; mode: "ask" | "plan" | "agent" }
	| { type: "setThinkingLevel"; level: string }
	| { type: "pendingQuestion"; toolCallId: string; questions: import("../types").Question[] }
	| { type: "addQuestionBlock"; questions: import("../types").Question[]; answers: Record<string, import("../types").QuestionAnswer> }
	| { type: "clearPendingQuestion" }
	| { type: "backendReady" }
	| { type: "restoreMessages"; messages: RestoredChatMessage[] };

let nextId = 1;

function newMsg(role: "user" | "assistant", text = ""): ChatMessage {
	const blocks: ContentBlock[] = text ? [{ type: "text", content: text }] : [];
	return { id: `msg-${nextId++}`, role, blocks, toolCalls: [], complete: role === "user", timestamp: Date.now() };
}

// Save current block (if any) and start a new one
function finalizeBlock(msg: ChatMessage): ChatMessage {
	const blocks = [...msg.blocks];
	if (blocks.length > 0) {
		const last = blocks[blocks.length - 1];
		if (last.type === "thinking" || (last.type === "text" && last.content === "")) {
			// Remove empty text or save the block as-is
			if (last.content === "") blocks.pop();
		}
	}
	return { ...msg, blocks };
}

function chatReducer(state: ChatState, action: Action): ChatState {
	switch (action.type) {
		case "addUserMessage":
			return { ...state, streaming: true, messages: [...state.messages, newMsg("user", action.text)] };

		case "startAssistantMessage":
			return { ...state, messages: [...state.messages, newMsg("assistant")] };

		case "segmentStart": {
			const msgs = [...state.messages];
			const m = msgs[msgs.length - 1];
			if (m && m.role === "assistant" && !m.complete) msgs[msgs.length - 1] = finalizeBlock(m);
			return { ...state, messages: msgs };
		}

		case "textDelta": {
			const msgs = [...state.messages];
			const m = msgs[msgs.length - 1];
			if (!m || m.role !== "assistant" || m.complete) return state;
			const blocks = [...m.blocks];
			const last = blocks[blocks.length - 1];
			if (last?.type === "text") {
				blocks[blocks.length - 1] = { type: "text", content: last.content + action.delta };
			} else {
				blocks.push({ type: "text", content: action.delta });
			}
			msgs[msgs.length - 1] = { ...m, blocks };
			return { ...state, messages: msgs };
		}

		case "thinkingDelta": {
			const msgs = [...state.messages];
			const m = msgs[msgs.length - 1];
			if (!m || m.role !== "assistant" || m.complete) return state;
			const blocks = [...m.blocks];
			const last = blocks[blocks.length - 1];
			if (last?.type === "thinking") {
				blocks[blocks.length - 1] = { type: "thinking", content: last.content + action.delta };
			} else {
				blocks.push({ type: "thinking", content: action.delta });
			}
			msgs[msgs.length - 1] = { ...m, blocks };
			return { ...state, messages: msgs };
		}

		case "thinkingEnd": {
			const msgs = [...state.messages];
			const m = msgs[msgs.length - 1];
			if (m && m.role === "assistant" && !m.complete) msgs[msgs.length - 1] = finalizeBlock(m);
			return { ...state, messages: msgs };
		}

		case "toolCallStart": {
			const msgs = [...state.messages];
			const m = msgs[msgs.length - 1];
			if (m && m.role === "assistant" && !m.complete) {
				msgs[msgs.length - 1] = { ...m, toolCalls: [...m.toolCalls, { toolCallId: action.toolCallId, toolName: action.toolName, args: action.args, output: "", isError: false, running: true }] };
			}
			return { ...state, messages: msgs };
		}

		case "toolCallUpdate": {
			const msgs = [...state.messages];
			const m = msgs[msgs.length - 1];
			if (m && m.role === "assistant" && !m.complete) {
				msgs[msgs.length - 1] = { ...m, toolCalls: m.toolCalls.map(tc => tc.toolCallId === action.toolCallId ? { ...tc, output: tc.output + action.text } : tc) };
			}
			return { ...state, messages: msgs };
		}

		case "toolCallEnd": {
			const msgs = [...state.messages];
			const m = msgs[msgs.length - 1];
			if (m && m.role === "assistant" && !m.complete) {
				msgs[msgs.length - 1] = { ...m, toolCalls: m.toolCalls.map(tc => tc.toolCallId === action.toolCallId ? { ...tc, output: action.result, isError: action.isError, running: false } : tc) };
			}
			return { ...state, messages: msgs };
		}

		case "segmentEnd": {
			const msgs = [...state.messages];
			const m = msgs[msgs.length - 1];
			if (m && m.role === "assistant" && !m.complete) {
				msgs[msgs.length - 1] = {
					...(finalizeBlock(m)),
					interaction: {
						interactionId: `int-${nextId}`,
						tokensIn: action.tokensIn,
						tokensOut: action.tokensOut,
						thinkingTokens: action.thinkingTokens,
						responseTokens: action.tokensOut,
						totalCost: action.totalCost,
						modelProvider: action.modelProvider,
						modelId: action.modelId,
						cacheHit: action.cacheHit,
						duration: action.duration,
					},
				};
			}
			return { ...state, messages: msgs };
		}

		case "agentEnd":
			return {
				...state,
				streaming: false,
				messages: state.messages.map(m => m.role === "assistant" && !m.complete ? { ...m, complete: true } : m),
			};

		case "error":
			return { ...state, streaming: false, error: action.text, messages: [...state.messages, newMsg("assistant", `Error: ${action.text}`)] };

		case "sessionInfo": return { ...state, sessionInfo: action.info };
		case "modelInfo": return { ...state, modelInfo: { provider: action.provider, modelId: action.modelId, thinkingLevel: action.thinkingLevel } };
		case "modelList": return { ...state, availableModels: action.models };
		case "toolsInfo": return { ...state, availableTools: action.tools };
		case "backendReady": return { ...state, backendReady: true };
		case "setMode": return { ...state, mode: action.mode };
		case "setThinkingLevel": return { ...state, thinkingLevel: action.level };
		case "pendingQuestion": return { ...state, pendingQuestion: { toolCallId: action.toolCallId, questions: action.questions } };
		case "addQuestionBlock": {
			const msgs = [...state.messages];
			const m = msgs[msgs.length - 1];
			if (m && m.role === "assistant") {
				msgs[msgs.length - 1] = {
					...m,
					blocks: [
						...m.blocks,
						{ type: "qa_block", questions: action.questions, answers: action.answers } as any,
					],
				};
			}
			return { ...state, messages: msgs };
		}
		case "clearPendingQuestion": return { ...state, pendingQuestion: null };
		case "restoreMessages":
			return {
				...state,
				messages: action.messages.map((m) => ({
					id: m.id,
					role: m.role,
					blocks: m.blocks,
					toolCalls: m.toolCalls.map((tc) => ({ ...tc, running: false })),
					complete: true,
					timestamp: m.timestamp,
				})),
			};
	}
}

export function useStreaming() {
	const [state, dispatch] = useReducer(chatReducer, {
		messages: [],
		streaming: false,
		backendReady: false,
		sessionInfo: { tokensIn: 0, tokensOut: 0, totalCost: 0, contextUsed: 0, contextLimit: 0, speed: 0, cacheRate: 0 },
		modelInfo: { provider: "", modelId: "", thinkingLevel: "medium" },
		availableModels: [],
		availableTools: [],
		mode: "agent",
		thinkingLevel: "medium",
		pendingQuestion: null,
		error: null,
	});

	const handleExtensionMessage = useCallback((msg: ExtensionMessage) => {
		switch (msg.command) {
			case "agentStart": dispatch({ type: "startAssistantMessage" }); break;
			case "segmentStart": dispatch({ type: "segmentStart" }); break;
			case "textDelta": dispatch({ type: "textDelta", delta: msg.delta }); break;
			case "thinkingDelta": dispatch({ type: "thinkingDelta", delta: msg.delta }); break;
			case "thinkingEnd": dispatch({ type: "thinkingEnd" }); break;
			case "toolCallStart": dispatch({ type: "toolCallStart", toolCallId: msg.toolCallId, toolName: msg.toolName, args: msg.args }); break;
			case "toolCallUpdate": dispatch({ type: "toolCallUpdate", toolCallId: msg.toolCallId, text: msg.text }); break;
			case "toolCallEnd": dispatch({ type: "toolCallEnd", toolCallId: msg.toolCallId, result: msg.result, isError: msg.isError }); break;
			case "segmentEnd": dispatch({ type: "segmentEnd", tokensIn: msg.tokensIn, tokensOut: msg.tokensOut, thinkingTokens: msg.thinkingTokens, totalCost: msg.totalCost, modelProvider: msg.modelProvider, modelId: msg.modelId, cacheHit: msg.cacheHit, duration: msg.duration }); break;
			case "agentSettled":
			case "agentEnd": dispatch({ type: "agentEnd" }); break;
			case "error": dispatch({ type: "error", text: msg.text }); break;
			case "sessionInfo": dispatch({ type: "sessionInfo", info: { tokensIn: msg.tokensIn, tokensOut: msg.tokensOut, totalCost: (msg as any).totalCost ?? 0, contextUsed: msg.contextUsed, contextLimit: msg.contextLimit, speed: msg.speed, cacheRate: msg.cacheRate } }); break;
			case "modelInfo": dispatch({ type: "modelInfo", provider: msg.provider, modelId: msg.modelId, thinkingLevel: msg.thinkingLevel }); dispatch({ type: "setThinkingLevel", level: msg.thinkingLevel }); break;
			case "toolsInfo": dispatch({ type: "toolsInfo", tools: msg.tools }); break;
			case "askQuestion": dispatch({ type: "pendingQuestion", toolCallId: msg.toolCallId, questions: msg.questions }); break;
			case "modeInfo": dispatch({ type: "setMode", mode: msg.mode }); break;
			case "modelList": dispatch({ type: "modelList", models: msg.models }); break;
			case "backendReady": dispatch({ type: "backendReady" }); break;
			case "restoreMessages": dispatch({ type: "restoreMessages", messages: msg.messages }); break;
		}
	}, []);

	const addUserMessage = useCallback((text: string) => { dispatch({ type: "addUserMessage", text }); }, []);
	const setMode = useCallback((mode: "ask" | "plan" | "agent") => { dispatch({ type: "setMode", mode }); }, []);
	const setThinkingLevel = useCallback((level: string) => { dispatch({ type: "setThinkingLevel", level }); }, []);
	const clearPendingQuestion = useCallback(() => { dispatch({ type: "clearPendingQuestion" }); }, []);
	const addQuestionBlock = useCallback(
		(questions: import("../types").Question[], answers: Record<string, import("../types").QuestionAnswer>) => {
			dispatch({ type: "addQuestionBlock", questions, answers });
		},
		[],
	);

	return { state, handleExtensionMessage, addUserMessage, setMode, setThinkingLevel, clearPendingQuestion, addQuestionBlock };
}
