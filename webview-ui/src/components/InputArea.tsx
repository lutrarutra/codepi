import { useState, useRef, type KeyboardEvent } from "react";

interface Props {
  streaming: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}

export function InputArea({ streaming, onSend, onAbort }: Props) {
  const [input, setInput] = useState("");

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;
    onSend(trimmed);
    setInput("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === "Escape" && streaming) {
      onAbort();
    }
  }

  return (
    <div className="chat-input-area">
      <textarea
        className="chat-input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          streaming
            ? "CodePi is thinking... (Esc to abort)"
            : "Type a message... (Enter to send, Shift+Enter for new line)"
        }
        rows={2}
        disabled={streaming}
      />
      {streaming ? (
        <button className="chat-abort-btn" onClick={onAbort}>Stop</button>
      ) : (
        <button className="chat-send-btn" onClick={handleSend} disabled={!input.trim()}>Send</button>
      )}
    </div>
  );
}
