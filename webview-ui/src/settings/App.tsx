import React, { useCallback, useEffect, useState } from "react";
import type {
	BundledResourceRow,
	DashboardData,
	SettingsMessage,
	SettingsReply,
} from "./types";

const vscode = acquireVsCodeApi();

function post(message: SettingsMessage): void {
	vscode.postMessage(message);
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
						`${message.resource} preference saved; applies to new sessions.`,
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
				<div>
					<h1>CodePi settings</h1>
					<p className="settings-help">
						Pi resources are shared with the Pi CLI on this computer; CodePi
						sessions remain computer-specific.
					</p>
				</div>
				<button
					className="settings-button settings-button-secondary"
					type="button"
					onClick={() => post({ command: "settings:openSessions" })}
				>
					Sessions
				</button>
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
