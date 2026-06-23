import { useState, useEffect, useRef } from "react";

const vscode = acquireVsCodeApi();

interface Message {
  id: number;
  text: string;
  sender: "user" | "extension";
  timestamp: number;
  complete?: boolean;
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Listen for messages from the extension
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      switch (msg.command) {
        case "response":
          // Append streaming text to the last extension message
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.sender === "extension" && !last.complete) {
              return [
                ...prev.slice(0, -1),
                { ...last, text: last.text + msg.text },
              ];
            }
            return [
              ...prev,
              {
                id: Date.now(),
                text: msg.text,
                sender: "extension",
                timestamp: Date.now(),
                complete: false,
              },
            ];
          });
          break;
        case "responseEnd":
          setStreaming(false);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.sender === "extension") {
              return [...prev.slice(0, -1), { ...last, complete: true }];
            }
            return prev;
          });
          break;
        case "error":
          setStreaming(false);
          addMessage(`Error: ${msg.text}`, "extension");
          break;
        case "fileList":
          addMessage(
            msg.files.length
              ? `Workspace files:\n${msg.files.join("\n")}`
              : "No files found.",
            "extension"
          );
          break;
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  function addMessage(text: string, sender: "user" | "extension") {
    setMessages((prev) => [
      ...prev,
      { id: Date.now(), text, sender, timestamp: Date.now(), complete: true },
    ]);
  }

  function sendMessage() {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;

    addMessage(trimmed, "user");
    setInput("");
    setStreaming(true);

    // Send to extension backend (pi agent)
    vscode.postMessage({ command: "chat", text: trimmed });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function formatTime(ts: number) {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return (
    <div className="chat-container">
      {/* Messages area */}
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Ask CodePi anything about your codebase.</p>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-bubble ${msg.sender}`}>
            <div className="chat-bubble-text">{msg.text}</div>
            <div className="chat-bubble-time">
              {formatTime(msg.timestamp)}
              {msg.sender === "extension" && !msg.complete && (
                <span className="chat-typing-cursor">▊</span>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="chat-input-area">
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            streaming
              ? "CodePi is thinking..."
              : "Type a message... (Enter to send, Shift+Enter for new line)"
          }
          rows={2}
          disabled={streaming}
        />
        <button
          className="chat-send-btn"
          onClick={sendMessage}
          disabled={streaming}
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default App;
