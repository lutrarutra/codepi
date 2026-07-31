import React, { useMemo, useState } from "react";
import type { AuthEntry, CatalogEntry, SettingsMessage } from "../types";

interface Props {
	auth: AuthEntry[];
	catalog: CatalogEntry[];
	post: (m: SettingsMessage) => void;
}

export function AuthKeys({ auth, catalog, post }: Props): JSX.Element {
	const [provider, setProvider] = useState("");
	const [keyValue, setKeyValue] = useState("");
	const [editing, setEditing] = useState<Record<string, string>>({});

	const availableProviders = useMemo(() => {
		const configured = new Set(auth.map((a) => a.provider));
		return catalog
			.map((c) => c.provider)
			.filter((p, i, arr) => arr.indexOf(p) === i && !configured.has(p))
			.sort();
	}, [auth, catalog]);

	const saveKey = (prov: string) => {
		const k = (editing[prov] ?? "").trim();
		if (!k) return;
		post({ command: "settings:saveAuth", provider: prov, key: k });
		setEditing((prev) => ({ ...prev, [prov]: "" }));
	};

	return (
		<section className="settings-section">
			<h3 className="settings-section-title">Provider API keys</h3>
			{auth.length === 0 && <p className="settings-help">No stored credentials yet.</p>}
			{auth.map((entry) => (
				<div className="settings-row" key={entry.provider}>
					<label className="settings-label">
						{entry.provider}{" "}
						{entry.type === "oauth" ? "(OAuth — managed by pi login)" : ""}
					</label>
					<div className="settings-control">
						{entry.type === "api_key" ? (
							<>
								<input
									type="password"
									placeholder={entry.hasKey ? "•••••• (unchanged)" : "API key"}
									value={editing[entry.provider] ?? ""}
									onChange={(e) =>
										setEditing((prev) => ({ ...prev, [entry.provider]: e.target.value }))
									}
								/>
								<div className="settings-actions">
									<button
										className="settings-save"
										disabled={!(editing[entry.provider] ?? "").trim()}
										onClick={() => saveKey(entry.provider)}
									>
										Save key
									</button>
									<button
										className="settings-save"
										onClick={() =>
											post({ command: "settings:saveAuth", provider: entry.provider, remove: true })
										}
									>
										Remove
									</button>
								</div>
							</>
						) : (
							<p className="settings-help">Logged in via OAuth; tokens are not shown.</p>
						)}
					</div>
				</div>
			))}
			{availableProviders.length > 0 && (
				<div className="settings-row">
					<label className="settings-label">Add provider</label>
					<div className="settings-control">
						<select value={provider} onChange={(e) => setProvider(e.target.value)}>
							<option value="">Select…</option>
							{availableProviders.map((p) => (
								<option key={p} value={p}>{p}</option>
							))}
						</select>
						<input
							type="password"
							placeholder="API key"
							value={keyValue}
							onChange={(e) => setKeyValue(e.target.value)}
						/>
						<button
							className="settings-save"
							disabled={!provider || !keyValue.trim()}
							onClick={() => {
								post({ command: "settings:saveAuth", provider, key: keyValue.trim() });
								setKeyValue("");
								setProvider("");
							}}
						>
							Add
						</button>
					</div>
				</div>
			)}
		</section>
	);
}
