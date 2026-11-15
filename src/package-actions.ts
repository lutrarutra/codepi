/**
 * Install, remove and update pi packages from CodePi's Extensions view.
 *
 * pi manages packages with its CLI (pi install / remove / update / list),
 * which CodePi does not ship — it bundles pi as a library. These actions use
 * the same DefaultPackageManager the CLI uses, so settings.json `packages`,
 * the install locations under ~/.pi/agent and the update rules are pi's own.
 * Installs are user-scope (~/.pi/agent/settings.json); project packages
 * (.pi/settings.json) are listed and can be removed or updated.
 */
import type { PackageEntry } from "./shared/extensions-protocol";

type Sdk = typeof import("@earendil-works/pi-coding-agent");

export interface PackageContext {
	cwd: string;
	agentDir: string;
	/** Project trust of cwd: untrusted folders' .pi settings stay unread. */
	projectTrusted: boolean;
}

export type PackageAction =
	| { type: "install"; source: string }
	| { type: "remove"; source: string; scope: "user" | "project" }
	| { type: "update"; source?: string };

function packageManager(pi: Sdk, ctx: PackageContext) {
	const settingsManager = pi.SettingsManager.create(ctx.cwd, ctx.agentDir, {
		projectTrusted: ctx.projectTrusted,
	});
	return new pi.DefaultPackageManager({
		cwd: ctx.cwd,
		agentDir: ctx.agentDir,
		settingsManager,
	});
}

/** The packages pi would load for this folder. */
export function listPackages(pi: Sdk, ctx: PackageContext): PackageEntry[] {
	return packageManager(pi, ctx)
		.listConfiguredPackages()
		.map((p) => ({ source: p.source, scope: p.scope, installed: !!p.installedPath }));
}

/** Trim and check a package source typed by the user. */
export function normalizePackageSource(input: string): string {
	const source = String(input ?? "").trim();
	if (!source) throw new Error("Enter a package source, e.g. npm:@scope/name or git:github.com/owner/repo");
	if (/\s/.test(source)) throw new Error(`A package source has no spaces: "${source}"`);
	return source;
}

/**
 * Run one action. Progress messages (pi's own, e.g. `npm:foo 1.2.0 -> 1.3.0`)
 * go to `onProgress`. Returns a one-line summary for the user.
 */
export async function runPackageAction(
	pi: Sdk,
	ctx: PackageContext,
	action: PackageAction,
	onProgress: (message: string) => void = () => {},
): Promise<string> {
	const pm = packageManager(pi, ctx);
	const results: string[] = [];
	pm.setProgressCallback((event) => {
		if (event.message) onProgress(event.message);
		if (event.type === "result" && event.message) results.push(event.message);
	});
	try {
		switch (action.type) {
			case "install": {
				const source = normalizePackageSource(action.source);
				await pm.installAndPersist(source);
				return `Installed ${source}.`;
			}
			case "remove": {
				const removed = await pm.removeAndPersist(action.source, {
					local: action.scope === "project",
				});
				return removed
					? `Removed ${action.source}.`
					: `${action.source} was not in the ${action.scope} settings.`;
			}
			case "update": {
				await pm.update(action.source);
				if (results.length > 0) return `Updated: ${results.join("; ")}.`;
				return action.source
					? `${action.source} is up to date.`
					: "Packages are already up to date.";
			}
		}
	} finally {
		pm.setProgressCallback(undefined);
	}
}
