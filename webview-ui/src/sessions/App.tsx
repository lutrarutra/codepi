import { useCallback, useEffect, useState } from "react";
import type { SessionEntry, SessionsMessage, SessionsReply } from "./types";

declare global {
	interface Window {
		acquireVsCodeApi(): { postMessage(msg: unknown): void };
	}
}

const vscode = window.acquireVsCodeApi();

function post(message: SessionsMessage): void {
	vscode.postMessage(message);
}

// Sidebar-wide tab switcher (Sessions | Extensions | Settings) — same markup
// as the settings and extensions views; the host switches via codepi.*Tab.
function SidebarTabs({
	active,
	onSelect,
}: {
	active: "sessions" | "extensions" | "settings";
	onSelect: (tab: "sessions" | "extensions" | "settings") => void;
}): JSX.Element {
	const tabs = [
		{ id: "sessions", label: "Sessions" },
		{ id: "extensions", label: "Extensions" },
		{ id: "settings", label: "Settings" },
	] as const;
	return (
		<nav className="sidebar-tabs" role="tablist" aria-label="CodePi sidebar">
			{tabs.map((tab) => (
				<button
					key={tab.id}
					type="button"
					role="tab"
					aria-selected={active === tab.id}
					className={`sidebar-tab${active === tab.id ? " sidebar-tab-active" : ""}`}
					onClick={() => onSelect(tab.id)}
				>
					{tab.label}
				</button>
			))}
		</nav>
	);
}

function sessionTitle(session: SessionEntry): string {
	return session.name || session.firstMessage || "(empty session)";
}

function SessionRow({ session }: { session: SessionEntry }): JSX.Element {
	return (
		<li className="sessions-row">
			<button
				type="button"
				className="sessions-row-main"
				title={session.path}
				onClick={() => post({ type: "open", path: session.path })}
			>
				<span className="sessions-row-title">{sessionTitle(session)}</span>
				<span className="sessions-row-meta">
					<span className="sessions-row-date">{session.dateLabel}</span>
					<span className="sessions-row-count">{session.messageCount} msg</span>
				</span>
			</button>
			<span className="sessions-row-actions">
				<button
					type="button"
					className="sessions-action"
					title="Rename session"
					onClick={() => post({ type: "rename", path: session.path })}
				>
					Rename
				</button>
				<button
					type="button"
					className="sessions-action sessions-action-danger"
					title="Delete session"
					onClick={() => post({ type: "delete", path: session.path })}
				>
					Delete
				</button>
			</span>
		</li>
	);
}

export function SessionsApp(): JSX.Element {
	const [sessions, setSessions] = useState<SessionEntry[] | undefined>();
	const [hasWorkspace, setHasWorkspace] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		const onMessage = (event: MessageEvent<SessionsReply>) => {
			const message = event.data;
			if (message.type === "list") {
				setSessions(message.sessions);
				setHasWorkspace(message.hasWorkspace);
				setError("");
			} else if (message.type === "error") {
				setError(message.message);
			}
			setBusy(false);
		};
		window.addEventListener("message", onMessage);
		post({ type: "get" });
		return () => window.removeEventListener("message", onMessage);
	}, []);

	const refresh = useCallback(() => {
		setBusy(true);
		post({ type: "refresh" });
	}, []);

	return (
		<div className="sessions-root">
			<SidebarTabs
				active="sessions"
				onSelect={(tab) => {
					if (tab === "extensions") post({ type: "openExtensions" });
					if (tab === "settings") post({ type: "openSettings" });
				}}
			/>
			<div className="sessions-header">
				<h1>Sessions</h1>
				<div className="sessions-header-actions">
					<button
						type="button"
						className="sessions-button"
						onClick={() => post({ type: "new" })}
					>
						+ New session
					</button>
					<button
						type="button"
						className="sessions-button"
						onClick={refresh}
						disabled={busy}
					>
						{busy ? "Refreshing…" : "↻ Refresh"}
					</button>
				</div>
			</div>

			{error && (
				<div className="sessions-alert" role="alert">
					<span>{error}</span>
					<button type="button" className="sessions-button" onClick={refresh}>
						Retry
					</button>
				</div>
			)}
			{busy && sessions === undefined && (
				<div className="sessions-loading" role="status">
					<span className="loading-spinner" aria-hidden="true" />
					<span>Loading sessions…</span>
				</div>
			)}
			{sessions !== undefined && sessions.length === 0 && (
				<p className="sessions-hint">
					{hasWorkspace
						? "No sessions yet — start one with “+ New session”."
						: "Open a workspace folder to see its sessions."}
				</p>
			)}
			{sessions !== undefined && sessions.length > 0 && (
				<ul className="sessions-list">
					{sessions.map((session) => (
						<SessionRow key={session.id} session={session} />
					))}
				</ul>
			)}
		</div>
	);
}
