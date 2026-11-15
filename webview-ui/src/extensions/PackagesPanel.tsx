import { useState } from "react";
import type { ExtensionsMessage, PackageEntry } from "./types";

/**
 * Install, update and remove pi packages (pi's `install` / `update` /
 * `remove`), backed by pi's own package manager in the extension host.
 */
export function PackagesPanel({
	packages,
	busy,
	status,
	post,
}: {
	packages: PackageEntry[];
	busy: boolean;
	status?: { ok: boolean; message: string };
	post: (msg: ExtensionsMessage) => void;
}) {
	const [source, setSource] = useState("");
	const install = () => {
		const value = source.trim();
		if (!value || busy) return;
		post({ type: "installPackage", source: value });
	};
	return (
		<section className="card pkg-panel" aria-labelledby="pkg-title">
			<div className="card-title">
				<span id="pkg-title" className="card-name">
					Packages
				</span>
				{packages.length > 0 && (
					<button
						className="pkg-link"
						disabled={busy}
						onClick={() => post({ type: "updatePackages" })}
						title="Update every installed package (pi update)"
					>
						Update all
					</button>
				)}
			</div>
			<div className="ext-controls">
				<input
					className="ext-search"
					type="text"
					placeholder="npm:@scope/name, git:github.com/owner/repo or a path"
					aria-label="Package source"
					value={source}
					disabled={busy}
					onChange={(e) => setSource(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") install();
					}}
				/>
				<button className="ext-refresh" disabled={busy || !source.trim()} onClick={install}>
					Install
				</button>
			</div>
			{status?.message && (
				<div className={status.ok ? "pkg-status" : "pkg-status pkg-status-error"} role="status">
					{status.message}
				</div>
			)}
			{packages.length === 0 ? (
				<div className="row-desc">
					No packages yet. Packages add extensions, skills, prompts and themes; find them on npm
					with the keyword pi-package.
				</div>
			) : (
				<ul className="pkg-list">
					{packages.map((p) => (
						<li key={`${p.scope}:${p.source}`} className="row pkg-row">
							<span className="pkg-source" title={p.source}>
								{p.source}
							</span>
							<span className="tag">{p.scope}</span>
							{!p.installed && <span className="tag tag-disabled">not installed</span>}
							<span className="pkg-actions">
								<button
									className="pkg-link"
									disabled={busy}
									onClick={() => post({ type: "updatePackages", source: p.source })}
								>
									Update
								</button>
								<button
									className="pkg-link pkg-danger"
									disabled={busy}
									onClick={() => post({ type: "removePackage", source: p.source, scope: p.scope })}
								>
									Remove
								</button>
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
