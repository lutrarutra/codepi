import React, { useCallback, useEffect, useMemo, useState } from "react";
import { SETTINGS_SCHEMA, validateSettings } from "../../../src/shared/pi-settings-schema";
import { FormSection } from "./components/FormSection";
import type { SettingsMessage, SettingsRecord, SettingsReply } from "./types";

const vscode = acquireVsCodeApi();

const TAB_STRIP = [
	{ id: "sessions", label: "Sessions", active: false },
	{ id: "settings", label: "Settings", active: true },
];

export function SettingsApp(): JSX.Element {
	const [settings, setSettings] = useState<SettingsRecord | null>(null);
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState<string>("");
	const [tab, setTab] = useState<"form" | "json">("form");
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		const onMsg = (e: MessageEvent<SettingsReply>) => {
			const msg = e.data;
			switch (msg.command) {
				case "settings:data":
					setSettings(msg.settings ?? {});
					setLoaded(true);
					setStatus("");
					break;
				case "settings:saved":
					setDirty(false);
					setStatus(`Saved ${msg.file ?? ""}`.trim());
					break;
				case "settings:error":
					setStatus(`Error: ${msg.message}`);
					break;
				case "settings:importResult":
					setStatus(`Imported: ${msg.message || "nothing new"}`);
					setLoaded(true);
					break;
			}
		};
		window.addEventListener("message", onMsg);
		post({ command: "settings:get" });
		return () => window.removeEventListener("message", onMsg);
	}, []);

	const post = useCallback((m: SettingsMessage) => vscode.postMessage(m), []);

	const onChange = useCallback((key: string, value: unknown) => {
		setSettings((prev) => {
			if (!prev) return prev;
			const next = { ...prev, [key]: value };
			return next;
		});
		setDirty(true);
	}, []);

	const save = useCallback(() => {
		if (!settings) return;
		const errors = validateSettings(settings);
		if (errors.length > 0) {
			setStatus(`Validation: ${errors.join("; ")}`);
			return;
		}
		post({ command: "settings:saveSettings", settings });
	}, [settings, post]);

	const generalSection = useMemo(
		() => SETTINGS_SCHEMA.find((s) => s.id === "general"),
		[],
	);
	const advancedSections = useMemo(
		() => SETTINGS_SCHEMA.filter((s) => s.id !== "general"),
		[],
	);

	if (!loaded) {
		return (
			<div className="settings-page">
				<div className="settings-loading">Loading settings…</div>
			</div>
		);
	}

	return (
		<div className="settings-page">
			<div className="settings-tabstrip">
				{TAB_STRIP.map((t) => (
					<button
						key={t.id}
						className={`settings-tab ${t.active ? "settings-tab-active" : ""}`}
						onClick={() => t.id === "sessions" && post({ command: "settings:openSessions" })}
					>
						{t.label}
					</button>
				))}
			</div>
			<div className="settings-inner-tabs">
				<button
					className={`settings-inner-tab ${tab === "form" ? "settings-inner-tab-active" : ""}`}
					onClick={() => setTab("form")}
				>
					Form
				</button>
				<button
					className={`settings-inner-tab ${tab === "json" ? "settings-inner-tab-active" : ""}`}
					onClick={() => setTab("json")}
				>
					JSON editor
				</button>
			</div>
			{tab === "form" ? (
				<div className="settings-form">
					{generalSection && (
						<FormSection
							title={generalSection.title}
							fields={generalSection.fields}
							settings={settings ?? {}}
							onChange={onChange}
						/>
					)}
					{advancedSections.map((s) => (
						<FormSection
							key={s.id}
							title={s.title}
							fields={s.fields}
							settings={settings ?? {}}
							onChange={onChange}
						/>
					))}
					<div className="settings-actions">
						<button className="settings-save" onClick={save} disabled={!dirty}>
							Save settings
						</button>
						<span className="settings-status">{status}</span>
					</div>
					<p className="settings-note">
						Saved settings apply to new sessions. API keys apply to the next message.
					</p>
				</div>
			) : (
				<JsonEditorShell
					key="json"
					settings={settings}
					post={post}
					status={status}
					setStatus={setStatus}
					onDirty={() => setDirty(true)}
				/>
			)}
		</div>
	);
}

// Minimal JSON editor shell (full editor in Task 6).
function JsonEditorShell(props: {
	settings: SettingsRecord | null;
	post: (m: SettingsMessage) => void;
	status: string;
	setStatus: (s: string) => void;
	onDirty: () => void;
}): JSX.Element {
	const [file, setFile] = useState<"settings" | "models">("settings");
	const [text, setText] = useState("");
	const [modelsText, setModelsText] = useState("");
	useEffect(() => {
		setText(JSON.stringify(props.settings ?? {}, null, 2));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	return (
		<div className="settings-json">
			<select value={file} onChange={(e) => setFile(e.target.value as "settings" | "models")}>
				<option value="settings">settings.json</option>
				<option value="models">models.json</option>
			</select>
			<textarea
				className="settings-json-text"
				rows={16}
				value={file === "settings" ? text : modelsText}
				onChange={(e) => {
					props.onDirty();
					if (file === "settings") setText(e.target.value);
					else setModelsText(e.target.value);
				}}
			/>
			<button
				className="settings-save"
				onClick={() => {
					props.post({
						command: "settings:saveJson",
						file,
						text: file === "settings" ? text : modelsText,
					});
				}}
			>
				Validate &amp; Save
			</button>
			<span className="settings-status">{props.status}</span>
		</div>
	);
}
