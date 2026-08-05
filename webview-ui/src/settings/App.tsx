import type React from "react";
import { useCallback, useEffect, useState } from "react";
import type {
	AutoVerifyMode,
	BundledResourceRow,
	DashboardData,
	SettingsMessage,
	SettingsReply,
	TerminalPrefs,
} from "./types";

const vscode = acquireVsCodeApi();

function post(message: SettingsMessage): void {
	vscode.postMessage(message);
}

// Sidebar-wide tab switcher (Sessions | Extensions | Settings). Each webview
// view renders its own copy; the host switches views via codepi.*Tab commands.
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

function formatPackageSummary(packages: DashboardData["packages"]): string {
	if (packages.configured === 0) return "No Pi packages configured.";
	const installed = `${packages.installed} installed`;
	const missing = packages.missing > 0 ? `, ${packages.missing} missing` : "";
	return `${packages.configured} configured · ${installed}${missing}`;
}

function ResourceToggle({
	resource,
}: {
	resource: BundledResourceRow;
}): JSX.Element {
	const description =
		resource.kind === "theme"
			? "A CodePi-only theme bundled with the extension."
			: "An extension bundled with CodePi for new sessions.";

	return (
		<label className="settings-resource-row">
			<span className="settings-resource-copy">
				<span className="settings-resource-label">{resource.label}</span>
				<span className="settings-help">{description}</span>
			</span>
			<input
				type="checkbox"
				checked={resource.enabled}
				onChange={(event) =>
					post({
						command: "settings:setBundledResource",
						id: resource.id,
						enabled: event.currentTarget.checked,
					})
				}
				aria-label={`Enable ${resource.label}`}
			/>
		</label>
	);
}

function FileButton({
	file,
	label,
	exists,
}: {
	file: "settings" | "models" | "auth";
	label: string;
	exists: boolean;
}): JSX.Element {
	return (
		<div className="settings-file-row">
			<div>
				<strong>{label}</strong>
				<span className="settings-help">
					{exists ? "File exists" : "Created when opened"}
				</span>
			</div>
			<button
				className="settings-button settings-button-secondary"
				type="button"
				onClick={() => post({ command: "settings:openFile", file })}
			>
				Open in VS Code
			</button>
		</div>
	);
}

// Monospace fonts offered as suggestions in the terminal font-family field.
// Any value is allowed — these are just quick picks from a datalist.
const FONT_SUGGESTIONS = [
	"FiraCode Nerd Font",
	"monospace",
	"Menlo",
	"Monaco",
	"Consolas",
	"Cascadia Code",
	"JetBrains Mono",
	"Source Code Pro",
	"IBM Plex Mono",
];

function TerminalPrefsCard({ prefs }: { prefs: TerminalPrefs }): JSX.Element {
	const [fontFamily, setFontFamily] = useState(prefs.fontFamily);
	const [fontSize, setFontSize] = useState(String(prefs.fontSize));

	// Follow refresh cycles (the extension echoes saved values back).
	useEffect(() => {
		setFontFamily(prefs.fontFamily);
		setFontSize(String(prefs.fontSize));
	}, [prefs]);

	const save = (): void => {
		const family = fontFamily.trim() || "FiraCode Nerd Font";
		const size = Math.min(40, Math.max(8, Number.parseInt(fontSize, 10) || 14));
		setFontFamily(family);
		setFontSize(String(size));
		post({
			command: "settings:setTerminalPrefs",
			fontFamily: family,
			fontSize: size,
		});
	};
	const saveOnEnter = (event: React.KeyboardEvent<HTMLInputElement>): void => {
		if (event.key === "Enter") {
			event.preventDefault();
			event.currentTarget.blur();
		}
	};

	return (
		<section className="settings-card" aria-labelledby="terminal-title">
			<h2 id="terminal-title">Terminal</h2>
			<p className="settings-help">
				Font used in CodePi chat panels. Changes apply to new sessions.
			</p>
			<div className="settings-field-row">
				<label className="settings-field-label" htmlFor="terminal-font-family">
					Font family
				</label>
				<input
					id="terminal-font-family"
					className="settings-text-input"
					type="text"
					list="codepi-font-suggestions"
					value={fontFamily}
					spellCheck={false}
					onChange={(event) => setFontFamily(event.currentTarget.value)}
					onBlur={save}
					onKeyDown={saveOnEnter}
					aria-describedby="terminal-font-help"
				/>
				<datalist id="codepi-font-suggestions">
					{FONT_SUGGESTIONS.map((font) => (
						<option key={font} value={font} />
					))}
				</datalist>
			</div>
			<div className="settings-field-row">
				<label className="settings-field-label" htmlFor="terminal-font-size">
					Font size
				</label>
				<input
					id="terminal-font-size"
					className="settings-number-input"
					type="number"
					min={8}
					max={40}
					step={1}
					value={fontSize}
					onChange={(event) => setFontSize(event.currentTarget.value)}
					onBlur={save}
					onKeyDown={saveOnEnter}
					aria-describedby="terminal-font-help"
				/>
				<span className="settings-field-suffix" aria-hidden="true">
					px
				</span>
			</div>
			<p className="settings-help" id="terminal-font-help">
				A CSS font stack or any installed monospace font; 8–40 px.
			</p>
		</section>
	);
}

// Nicer labels for saved-preferences status messages.
const RESOURCE_LABELS: Record<string, string> = {
	terminal: "Terminal",
	autoVerify: "Verification",
	askAllowedTools: "Ask-mode tools",
};

// Post-edit verification modes shown in the Settings view.
const AUTO_VERIFY_LABELS: Record<
	AutoVerifyMode,
	{ label: string; help: string }
> = {
	nextTurn: {
		label: "Remind on next prompt",
		help: "After a turn that edited files, CodePi lints the edited files and attaches problems as context on your next message — a quiet reminder.",
	},
	followUp: {
		label: "Auto-fix immediately",
		help: "Problems are sent to the agent right after the turn; it keeps working to fix them before you see the result.",
	},
	off: {
		label: "Off",
		help: "Only lint when the agent calls get_diagnostics itself.",
	},
};

function TldrModeCard({ enabled }: { enabled: boolean }): JSX.Element {
	return (
		<section className="settings-card" aria-labelledby="tldr-title">
			<h2 id="tldr-title">TL;DR Mode</h2>
			<p className="settings-help">
				Collapse everything but the agent&rsquo;s final response into a per-turn
				summary (tokens, tool calls, cost, live activity). Applies to new
				sessions; toggle per session with <code>/codepi-toggle-tldr</code>.
			</p>
			<div className="settings-field-row">
				<label className="settings-field-label" htmlFor="tldr-mode-toggle">
					Enabled
				</label>
				<input
					id="tldr-mode-toggle"
					className="settings-toggle"
					type="checkbox"
					checked={enabled}
					onChange={(event) =>
						post({
							command: "settings:setTldrMode",
							enabled: event.currentTarget.checked,
						})
					}
				/>
			</div>
		</section>
	);
}

function AutoVerifyCard({ mode }: { mode: AutoVerifyMode }): JSX.Element {
	return (
		<section className="settings-card" aria-labelledby="verify-title">
			<h2 id="verify-title">Verification</h2>
			<p className="settings-help">
				After each turn that edits files, CodePi lints exactly the files the
				agent touched (VS Code Problems panel) and feeds findings back to it.
			</p>
			<div className="settings-field-row">
				<label className="settings-field-label" htmlFor="auto-verify-mode">
					Mode
				</label>
				<select
					id="auto-verify-mode"
					className="settings-select"
					value={mode}
					onChange={(event) =>
						post({
							command: "settings:setAutoVerify",
							mode: event.currentTarget.value as AutoVerifyMode,
						})
					}
				>
					{(Object.keys(AUTO_VERIFY_LABELS) as AutoVerifyMode[]).map((m) => (
						<option key={m} value={m}>
							{AUTO_VERIFY_LABELS[m].label}
						</option>
					))}
				</select>
			</div>
			<p className="settings-help">{AUTO_VERIFY_LABELS[mode].help}</p>
		</section>
	);
}

function AskAllowedToolsCard({ tools }: { tools: string[] }): JSX.Element {
	const [value, setValue] = useState(tools.join(", "));

	// Follow refresh cycles (the extension echoes saved values back).
	useEffect(() => {
		setValue(tools.join(", "));
	}, [tools]);

	const save = (): void => {
		const cleaned = value
			.split(",")
			.map((t) => t.trim())
			.filter((t) => t !== "");
		setValue(cleaned.join(", "));
		post({
			command: "settings:setAskAllowedTools",
			tools: cleaned,
		});
	};
	const saveOnEnter = (event: React.KeyboardEvent<HTMLInputElement>): void => {
		if (event.key === "Enter") {
			event.preventDefault();
			event.currentTarget.blur();
		}
	};

	return (
		<section className="settings-card" aria-labelledby="ask-tools-title">
			<h2 id="ask-tools-title">Ask mode tools</h2>
			<p className="settings-help">
				Tools the agent may call in read-only (Ask) mode. Everything else —
				shell commands, edit/write, and other extension tools — is blocked.
				Comma-separated list; saved immediately (Ask-mode tool calls re-read the
				list from settings each time).
			</p>
			<div className="settings-field-row">
				<label className="settings-field-label" htmlFor="ask-allowed-tools">
					Allowed tools
				</label>
				<input
					id="ask-allowed-tools"
					className="settings-text-input"
					type="text"
					value={value}
					spellCheck={false}
					onChange={(event) => setValue(event.currentTarget.value)}
					onBlur={save}
					onKeyDown={saveOnEnter}
					aria-describedby="ask-tools-help"
				/>
			</div>
			<p className="settings-help" id="ask-tools-help">
				e.g. read, head, grep, find, ls, get_diagnostics,
				ask_user_question, web_search, fetch_content
			</p>
		</section>
	);
}

export function SettingsApp(): JSX.Element {
	const [data, setData] = useState<DashboardData | null>(null);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");

	const reload = useCallback(() => {
		setError("");
		post({ command: "settings:refresh" });
	}, []);

	useEffect(() => {
		const onMessage = (event: MessageEvent<SettingsReply>) => {
			const message = event.data;
			switch (message.command) {
				case "settings:data":
					setData(message.data);
					setError("");
					break;
				case "settings:saved":
					setStatus(
						`${RESOURCE_LABELS[message.resource] ?? message.resource} preference saved; applies to new sessions.`,
					);
					break;
				case "settings:opened":
					setStatus(`Opened ${message.file}.json in VS Code.`);
					break;
				case "settings:error":
					setError(message.message);
					break;
			}
		};
		window.addEventListener("message", onMessage);
		post({ command: "settings:get" });
		return () => window.removeEventListener("message", onMessage);
	}, []);

	if (!data) {
		if (error) {
			return (
				<div className="settings-page settings-loading">
					<div className="settings-alert settings-alert-error" role="alert">
						{error}
					</div>
					<button
						className="settings-button settings-button-secondary"
						type="button"
						onClick={reload}
					>
						Retry
					</button>
				</div>
			);
		}
		return (
			<div className="settings-page settings-loading" role="status">
				Loading CodePi settings…
			</div>
		);
	}

	return (
		<div className="settings-page">
			<header className="settings-header">
				<SidebarTabs
					active="settings"
					onSelect={(tab) => {
						if (tab === "sessions") post({ command: "settings:openSessions" });
						if (tab === "extensions")
							post({ command: "settings:openExtensions" });
					}}
				/>
				<div>
					<h1>CodePi settings</h1>
					<p className="settings-help">
						Pi resources are shared with the Pi CLI on this computer; CodePi
						sessions remain computer-specific.
					</p>
				</div>
			</header>

			{error && (
				<div className="settings-alert settings-alert-error" role="alert">
					{error}
				</div>
			)}
			{status && (
				<div className="settings-alert settings-alert-status" role="status">
					{status}
				</div>
			)}

			<section className="settings-card" aria-labelledby="resources-title">
				<div className="settings-card-heading">
					<div>
						<h2 id="resources-title">Pi resources</h2>
						<p className="settings-help">
							The canonical resource directory for this computer.
						</p>
					</div>
					<button
						className="settings-button settings-button-secondary"
						type="button"
						onClick={reload}
					>
						Refresh
					</button>
				</div>
				<code className="settings-path">{data.agentDir}</code>
				<p className="settings-summary">
					{formatPackageSummary(data.packages)}
				</p>
				{data.packages.missing > 0 && (
					<div className="settings-package-list">
						{data.packages.entries
							.filter((entry) => !entry.installed)
							.map((entry) => (
								<div
									className="settings-package-missing"
									key={`${entry.scope}:${entry.source}`}
								>
									<span>{entry.source}</span>
									<span>{entry.scope} package missing</span>
								</div>
							))}
					</div>
				)}
				<p className="settings-help">
					CodePi sessions are stored separately at{" "}
					<code>{data.sessionDir}</code>.
				</p>
			</section>

			<section className="settings-card" aria-labelledby="defaults-title">
				<h2 id="defaults-title">CodePi defaults</h2>
				<p className="settings-help">
					These resources ship with CodePi and are not installed into the Pi
					CLI. Changes apply to new sessions.
				</p>
				<div className="settings-resource-list">
					{data.bundledResources.map((resource) => (
						<ResourceToggle key={resource.id} resource={resource} />
					))}
				</div>
			</section>

			<TerminalPrefsCard prefs={data.terminalPrefs} />

			<TldrModeCard enabled={data.tldrMode} />

			<AutoVerifyCard mode={data.autoVerify} />

			<AskAllowedToolsCard tools={data.askAllowedTools} />

			<section className="settings-card" aria-labelledby="files-title">
				<h2 id="files-title">Pi files</h2>
				<p className="settings-help">
					Edit the real Pi files with VS Code’s JSON language service and
					diagnostics.
				</p>
				<div className="settings-file-list">
					<FileButton
						file="settings"
						label="settings.json"
						exists={data.files.settings.exists}
					/>
					<FileButton
						file="models"
						label="models.json"
						exists={data.files.models.exists}
					/>
					<FileButton
						file="auth"
						label="auth.json"
						exists={data.files.auth.exists}
					/>
				</div>
			</section>

			<footer className="settings-footer">
				Settings and packages are per execution machine. With Remote-SSH, use
				the remote computer’s Pi directory and session storage.
			</footer>
		</div>
	);
}
