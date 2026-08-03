import { useCallback, useEffect, useMemo, useState } from "react";
import { SnapshotTree } from "./SnapshotTree";
import type { ExtensionsMessage, ExtensionsReply, ExtensionsSnapshot } from "./types";

declare global {
	interface Window {
		acquireVsCodeApi(): { postMessage(msg: unknown): void };
	}
}

const vscode = window.acquireVsCodeApi();

function modeLabel(snapshot: ExtensionsSnapshot): { text: string; tone: string } {
	const { mode } = snapshot;
	if (!mode.active) return { text: "No active session — showing policy", tone: "dim" };
	switch (mode.current) {
		case "ask":
			return { text: "Ask mode active — 🔒 tools are blocked", tone: "warning" };
		case "plan":
			return { text: "Plan mode active — no read-only restriction", tone: "ok" };
		case "implement":
			return { text: "Implement mode active — no read-only restriction", tone: "ok" };
		default:
			return { text: "Session active — mode unknown", tone: "dim" };
	}
}

export function ExtensionsApp() {
	const [snapshot, setSnapshot] = useState<ExtensionsSnapshot | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(true);

	useEffect(() => {
		const listener = (event: MessageEvent<ExtensionsReply>) => {
			const msg = event.data;
			if (msg.type === "snapshot") {
				setSnapshot(msg.snapshot);
				setError(undefined);
			} else if (msg.type === "error") {
				setError(msg.message);
			}
			setBusy(false);
		};
		window.addEventListener("message", listener);
		vscode.postMessage({ type: "getSnapshot" } satisfies ExtensionsMessage);
		return () => window.removeEventListener("message", listener);
	}, []);

	const refresh = useCallback(() => {
		setBusy(true);
		vscode.postMessage({ type: "refresh" } satisfies ExtensionsMessage);
	}, []);

	const header = snapshot ? modeLabel(snapshot) : { text: "", tone: "dim" };

	return (
		<div className="ext-root">
			{snapshot && (
				<div className="ext-header">
					<div className={`ext-mode ext-mode-${header.tone}`}>{header.text}</div>
					<div className="ext-legend">
						<span className="chip chip-safe">✓ read-only safe</span>
						<span className="chip chip-whitelisted">★ whitelisted (user)</span>
						<span className="chip chip-blocked">🔒 blocked in Ask mode</span>
					</div>
					<div className="ext-controls">
						<input
							className="ext-search"
							type="text"
							placeholder="Search extensions, commands, tools…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
						/>
						<button className="ext-refresh" onClick={refresh} disabled={busy}>
							{busy ? "Scanning…" : "↻ Refresh"}
						</button>
					</div>
					<div className="ext-meta">
						Scanned {new Date(snapshot.generatedAt).toLocaleTimeString()} ·{" "}
						{snapshot.loadErrors.length > 0
							? `${snapshot.loadErrors.length} load error(s)`
							: "no load errors"}
					</div>
				</div>
			)}
			{error && (
				<div className="ext-error">
					<span>{error}</span>
					<button onClick={refresh}>Retry</button>
				</div>
			)}
			{busy && !snapshot && <div className="ext-busy">Scanning extensions…</div>}
			{snapshot && <SnapshotTree snapshot={snapshot} query={query.trim().toLowerCase()} />}
		</div>
	);
}
