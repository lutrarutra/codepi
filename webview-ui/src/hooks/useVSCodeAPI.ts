import { useEffect, useCallback, useRef } from "react";
import type { ExtensionMessage, WebviewMessage } from "../types";

// VSCode injects acquireVsCodeApi() globally — get it once at module level
const vscodeApi =
	typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;

export function useVSCodeAPI(onMessage: (msg: ExtensionMessage) => void) {
	const onMessageRef = useRef(onMessage);
	onMessageRef.current = onMessage;

	useEffect(() => {
		const handler = (e: MessageEvent<ExtensionMessage>) => {
			console.log("[CodePi Webview] received message:", JSON.stringify(e.data));
			onMessageRef.current(e.data);
		};
		window.addEventListener("message", handler);
		return () => window.removeEventListener("message", handler);
	}, []);

	const post = useCallback((msg: WebviewMessage) => {
		console.log("[CodePi Webview] post:", msg.command);
		vscodeApi?.postMessage(msg);
	}, []);

	return { post };
}
