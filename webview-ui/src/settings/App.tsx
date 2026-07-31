import React, { useCallback, useEffect, useMemo, useState } from "react";
import { SETTINGS_SCHEMA, validateSettings } from "../../../src/shared/pi-settings-schema";
import { FormSection } from "./components/FormSection";
import { AuthKeys } from "./components/AuthKeys";
import { ModelsEditor } from "./components/ModelsEditor";
import type { AuthEntry, SettingsMessage, SettingsRecord, SettingsReply } from "./types";

const vscode = acquireVsCodeApi();

const TAB_STRIP = [
	{ id: "sessions", label: "Sessions", active: false },
	{ id: "settings", label: "Settings", active: true },
];

export function SettingsApp(): JSX.Element {
	const [settings, setSettings] = useState<SettingsRecord | null>(null);
	const [auth, setAuth] = useState<AuthEntry[]>([]);
	const [models, setModels] = useState<unknown>({ providers: {} });
	const [modelsError, setModelsError] = useState<string | undefined>(undefined);
	const [catalog, setCatalog] = useState<Array<{ provider: string; modelId: string }>>([]);
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState<string>("");
	const [tab, setTab] = useState<"form" | "json">("form");
	const [loaded, setLoaded] = useState(false);
	const [jsonPrefill, setJsonPrefill] = useState<string | undefined>(undefined);

	const post = useCallback((m: SettingsMessage) => vscode.postMessage(m), []);

	useEffect(() => {
		const onMsg = (e: MessageEvent<SettingsReply>) => {
			const msg = e.data;
			switch (msg.command) {
				case "settings:data":
					setSettings(msg.settings ?? {});
					setAuth(msg.auth ?? []);
					setModels(msg.models ?? { providers: {} });
					setModelsError(msg.modelsError);
					setCatalog(msg.catalog ?? []);
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
					post({ command: "settings:get" });
					break;
			}
		};
		window.addEventListener("message", onMsg);
		post({ command: "settings:get" });
		return () => window.removeEventListener("message", onMsg);
	}, [post]);

	const onChange = useCallback((key: string, value: unknown) => {
		setSettings((prev) => {
			if (!prev) return prev;
			return { ...prev, [key]: value };
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
					<AuthKeys auth={auth} catalog={catalog} post={post} />
					<ModelsEditor
						models={models}
						modelsError={modelsError}
						post={post}
						openInJson={(provider) => {
							setJsonPrefill(provider);
							setTab("json");
						}}
					/>
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
						<button
							className="settings-save"
							onClick={() => {
								post({ command: "settings:get" });
								setDirty(false);
							}}
						>
							Reload
						</button>
						<span className="settings-status">{status}</span>
					</div>
					<p className="settings-note">
						Saved settings apply to new sessions. API keys apply to the next message.
					</p>
				</div>
			) : (
				<JsonEditor
					settings={settings}
					models={models}
					prefillProvider={jsonPrefill}
					post={post}
					status={status}
					setStatus={setStatus}
					onDirty={() => setDirty(true)}
				/>
			)}
		</div>
	);
}

function JsonEditor(props: {
	settings: SettingsRecord | null;
	models: unknown;
	prefillProvider?: string;
	post: (m: SettingsMessage) => void;
	status: string;
	setStatus: (s: string) => void;
	onDirty: () => void;
}): JSX.Element {
	const [file, setFile] = useState<"settings" | "models">("settings");
	const [text, setText] = useState("");
	const [modelsText, setModelsText] = useState("");
	const [error, setError] = useState("");

	useEffect(() => {
		setText(JSON.stringify(props.settings ?? {}, null, 2));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.settings]);
	useEffect(() => {
		if (props.prefillProvider) {
			const m = props.models as { providers?: Record<string, unknown> } | null;
			const cfg = m?.providers?.[props.prefillProvider];
			setModelsText(
				JSON.stringify(
					{ providers: { [props.prefillProvider]: cfg ?? { models: [] } } },
					null,
					2,
				),
			);
			setFile("models");
			props.setStatus(`Editing ${props.prefillProvider} in models.json`);
		} else if (props.prefillProvider === undefined) {
			setModelsText(JSON.stringify(props.models ?? { providers: {} }, null, 2));
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.models, props.prefillProvider]);

	const current = file === "settings" ? text : modelsText;
	const setCurrent = (v: string) => {
		props.onDirty();
		if (file === "settings") setText(v);
		else setModelsText(v);
		setError("");
	};

	return (
		<div className="settings-json">
			<div className="settings-inner-tabs">
				<select value={file} onChange={(e) => setFile(e.target.value as "settings" | "models")}>
					<option value="settings">settings.json</option>
					<option value="models">models.json</option>
				</select>
			</div>
			<textarea
				className="settings-json-text"
				value={current}
				spellCheck={false}
				onChange={(e) => setCurrent(e.target.value)}
			/>
			{error && (
				<p className="settings-help" style={{ color: "#d29922", whiteSpace: "pre-wrap" }}>{error}</p>
			)}
			<div className="settings-actions">
				<button
					className="settings-save"
					onClick={() => {
						try {
							JSON.parse(current);
						} catch (err) {
							setError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
							return;
						}
						props.post({ command: "settings:saveJson", file, text: current });
					}}
				>
					Validate &amp; Save
				</button>
				<span className="settings-status">{props.status}</span>
			</div>
		</div>
	);
}
