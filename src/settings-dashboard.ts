import { BUNDLED_RESOURCES, getEnabledBundledResources } from "./pi-store";
import type { DashboardData, PackageStatusEntry } from "./shared/settings-protocol";

export interface DashboardFileStatus {
	settings: boolean;
	models: boolean;
	auth: boolean;
}

/** Build credential-free dashboard data for the settings webview. */
export function buildDashboardData(
	agentDir: string,
	sessionDir: string,
	settings: unknown,
	packages: PackageStatusEntry[],
	files: DashboardFileStatus = { settings: false, models: false, auth: false },
): DashboardData {
	const enabledIds = new Set(
		getEnabledBundledResources(settings).map((resource) => resource.id),
	);
	return {
		agentDir,
		sessionDir,
		bundledResources: BUNDLED_RESOURCES.map((resource) => ({
			...resource,
			enabled: enabledIds.has(resource.id),
		})),
		packages: {
			configured: packages.length,
			installed: packages.filter((entry) => entry.installed).length,
			missing: packages.filter((entry) => !entry.installed).length,
			entries: packages,
		},
		files: {
			settings: { path: joinPath(agentDir, "settings.json"), exists: files.settings },
			models: { path: joinPath(agentDir, "models.json"), exists: files.models },
			auth: { path: joinPath(agentDir, "auth.json"), exists: files.auth },
		},
	};
}

function joinPath(dir: string, filename: string): string {
	return `${dir.replace(/[\\/]$/, "")}/${filename}`;
}
