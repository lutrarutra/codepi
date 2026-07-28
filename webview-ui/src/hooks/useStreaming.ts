import { useReducer, useCallback } from "react";
import type { ChatMessage, ExtensionMessage } from "../types";

interface ChatState {
	messages: ChatMessage[];
	streaming: boolean;
}

type Action =
	| { type: "addUserMessage"; text: string }
	| { type: "startAssistantMessage" }
	| { type: "textDelta"; delta: string }
	| { type: "thinkingDelta"; delta: string }
	| { type: "textEnd" }
	| { type: "thinkingEnd" }
	| {
			type: "toolCallStart";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
	  }
	| { type: "toolCallUpdate"; toolCallId: string; text: string }
	| {
			type: "toolCallEnd";
			toolCallId: string;
			result: string;
			isError: boolean;
	  }
	| { type: "agentSettled" }
	| { type: "error"; text: string };

let nextId = 1;

function chatReducer(state: ChatState, action: Action): ChatState {
	switch (action.type) {
		case "addUserMessage":
			return {
				...state,
				streaming: true,
				messages: [
					...state.messages,
					{
						id: nextId++,
						role: "user",
						text: action.text,
						thinking: "",
						toolCalls: [],
						complete: true,
						timestamp: Date.now(),
					},
				],
			};

		case "startAssistantMessage":
			return {
				...state,
				messages: [
					...state.messages,
					{
						id: nextId++,
						role: "assistant",
						text: "",
						thinking: "",
						toolCalls: [],
						complete: false,
						timestamp: Date.now(),
					},
				],
			};

		case "textDelta": {
			const msgs = [...state.messages];
			const last = msgs[msgs.length - 1];
			if (last && last.role === "assistant" && !last.complete) {
				msgs[msgs.length - 1] = { ...last, text: last.text + action.delta };
			}
			return { ...state, messages: msgs };
		}

		case "thinkingDelta": {
			const msgs = [...state.messages];
			const last = msgs[msgs.length - 1];
			if (last && last.role === "assistant" && !last.complete) {
				msgs[msgs.length - 1] = {
					...last,
					thinking: last.thinking + action.delta,
				};
			}
			return { ...state, messages: msgs };
		}

		case "toolCallStart": {
			const msgs = [...state.messages];
			const last = msgs[msgs.length - 1];
			if (last && last.role === "assistant" && !last.complete) {
				const toolCalls = [
					...last.toolCalls,
					{
						toolCallId: action.toolCallId,
						toolName: action.toolName,
						args: action.args,
						output: "",
						isError: false,
						running: true,
					},
				];
				msgs[msgs.length - 1] = { ...last, toolCalls };
			}
			return { ...state, messages: msgs };
		}

		case "toolCallUpdate": {
			const msgs = [...state.messages];
			const last = msgs[msgs.length - 1];
			if (last && last.role === "assistant" && !last.complete) {
				const toolCalls = last.toolCalls.map((tc) =>
					tc.toolCallId === action.toolCallId
						? { ...tc, output: tc.output + action.text }
						: tc,
				);
				msgs[msgs.length - 1] = { ...last, toolCalls };
			}
			return { ...state, messages: msgs };
		}

		case "toolCallEnd": {
			const msgs = [...state.messages];
			const last = msgs[msgs.length - 1];
			if (last && last.role === "assistant" && !last.complete) {
				const toolCalls = last.toolCalls.map((tc) =>
					tc.toolCallId === action.toolCallId
						? {
								...tc,
								output: action.result,
								isError: action.isError,
								running: false,
							}
						: tc,
				);
				msgs[msgs.length - 1] = { ...last, toolCalls };
			}
			return { ...state, messages: msgs };
		}

		case "agentSettled":
			return {
				...state,
				streaming: false,
				messages: state.messages.map((m) =>
					m.role === "assistant" && !m.complete ? { ...m, complete: true } : m,
				),
			};

		case "error":
			return {
				...state,
				streaming: false,
				messages: [
					...state.messages,
					{
						id: nextId++,
						role: "assistant",
						text: `Error: ${action.text}`,
						thinking: "",
						toolCalls: [],
						complete: true,
						timestamp: Date.now(),
					},
				],
			};

		default:
			return state;
	}
}

export function useStreaming() {
	const [state, dispatch] = useReducer(chatReducer, {
		messages: [],
		streaming: false,
	});

	const handleExtensionMessage = useCallback((msg: ExtensionMessage) => {
		console.log("[CodePi Webview] dispatching:", msg.command);
		switch (msg.command) {
			case "agentStart":
				console.log("[CodePi Webview] → creating new assistant message bubble");
				dispatch({ type: "startAssistantMessage" });
				break;
			case "textDelta":
				dispatch({ type: "textDelta", delta: msg.delta });
				break;
			case "thinkingDelta":
				dispatch({ type: "thinkingDelta", delta: msg.delta });
				break;
			case "toolCallStart":
				console.log("[CodePi Webview] → tool call start:", msg.toolName);
				dispatch({
					type: "toolCallStart",
					toolCallId: msg.toolCallId,
					toolName: msg.toolName,
					args: msg.args,
				});
				break;
			case "toolCallUpdate":
				dispatch({
					type: "toolCallUpdate",
					toolCallId: msg.toolCallId,
					text: msg.text,
				});
				break;
			case "toolCallEnd":
				dispatch({
					type: "toolCallEnd",
					toolCallId: msg.toolCallId,
					result: msg.result,
					isError: msg.isError,
				});
				break;
			case "agentSettled":
			case "agentEnd":
				console.log(
					"[CodePi Webview] → agent settled — marking message complete",
				);
				dispatch({ type: "agentSettled" });
				break;
			case "error":
				console.log("[CodePi Webview] → showing error:", msg.text);
				dispatch({ type: "error", text: msg.text });
				break;
			default:
				console.log(
					"[CodePi Webview] ⚠️ UNHANDLED command:",
					(msg as { command: string }).command,
				);
				break;
		}
	}, []);

	const addUserMessage = useCallback((text: string) => {
		dispatch({ type: "addUserMessage", text });
	}, []);

	return { state, handleExtensionMessage, addUserMessage };
}
