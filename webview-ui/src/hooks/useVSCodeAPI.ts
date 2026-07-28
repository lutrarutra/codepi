import { useEffect, useCallback } from "react";
import type { ExtensionMessage, WebviewMessage } from "../types";

export function useVSCodeAPI(onMessage: (msg: ExtensionMessage) => void) {
  useEffect(() => {
    const handler = (e: MessageEvent<ExtensionMessage>) => onMessage(e.data);
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onMessage]);

  const post = useCallback((msg: WebviewMessage) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).vscodeApi?.postMessage(msg);
  }, []);

  return { post };
}
