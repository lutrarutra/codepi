import React, { useMemo, useState } from "react";
import type { SettingsMessage } from "../types";

interface ProviderConfig {
	models?: unknown[];
	[key: string]: unknown;
}
interface ModelsFile {
	providers?: Record<string, ProviderConfig>;
}

interface Props {
	models: unknown;
	modelsError?: string;
	post: (m: SettingsMessage) => void;
	openInJson: (provider: string) => void;
}

export function ModelsEditor({ models, modelsError, post, openInJson }: Props): JSX.Element {
	const [newProvider, setNewProvider] = useState("");
	const file = useMemo<ModelsFile>(() => {
		const m = models as ModelsFile | null;
		return m && typeof m === "object" ? m : {};
	}, [models]);
	const providers = Object.entries(file.providers ?? {});

	const update = (next: ModelsFile) => post({ command: "settings:saveModels", models: next });

	return (
		<section className="settings-section">
			<h3 className="settings-section-title">Custom models</h3>
			{modelsError && <p className="settings-help" style={{ color: "#d29922" }}>models.json error: {modelsError}</p>}
			{providers.length === 0 && <p className="settings-help">No custom models yet — add a provider below.</p>}
			{providers.map(([name, cfg]) => (
				<div className="settings-row" key={name}>
					<label className="settings-label">{name} ({Array.isArray(cfg.models) ? cfg.models.length : 0} models)</label>
					<div className="settings-control">
						<button className="settings-save" onClick={() => openInJson(name)}>Edit JSON</button>
						<button
							className="settings-save"
							onClick={() => {
								const next = { ...file, providers: { ...file.providers } };
								delete next.providers![name];
								update(next);
							}}
						>
							Remove provider
						</button>
					</div>
				</div>
			))}
			<div className="settings-row">
				<label className="settings-label">Add provider</label>
				<div className="settings-control">
					<input
						type="text"
						placeholder="provider id (e.g. mycorp)"
						value={newProvider}
						onChange={(e) => setNewProvider(e.target.value)}
					/>
					<button
						className="settings-save"
						disabled={!newProvider.trim()}
						onClick={() => {
							const next = {
								...file,
								providers: {
									...(file.providers ?? {}),
									[newProvider.trim()]: { models: [] },
								},
							};
							update(next);
							setNewProvider("");
						}}
					>
						Add provider
					</button>
				</div>
			</div>
			<p className="settings-help">
				Provider configs (models, baseUrl, headers, modelOverrides…) are edited as JSON —
				pi validates models.json on load and its errors are shown above.
			</p>
		</section>
	);
}
