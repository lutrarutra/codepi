import { useCallback } from "react";
import { useVSCodeAPI } from "./hooks/useVSCodeAPI";
import { useStreaming } from "./hooks/useStreaming";
import { ChatView } from "./components/ChatView";
import { InputArea } from "./components/InputArea";

export default function App() {
  const { state, handleExtensionMessage, addUserMessage } = useStreaming();
  const { post } = useVSCodeAPI(handleExtensionMessage);

  const handleSend = useCallback(
    (text: string) => {
      addUserMessage(text);
      post({ command: "prompt", text });
    },
    [post, addUserMessage],
  );

  const handleAbort = useCallback(() => {
    post({ command: "abort" });
  }, [post]);

  return (
    <div className="chat-container">
      <ChatView messages={state.messages} />
      <InputArea streaming={state.streaming} onSend={handleSend} onAbort={handleAbort} />
    </div>
  );
}
