import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED_RESOURCES, getEnabledBundledResources } from "./pi-store";
import type {
	DashboardData,
	PackageStatusEntry,
} from "./shared/settings-protocol";

export interface DashboardFileStatus {
	settings: boolean;
	models: boolean;
	auth: boolean;
}

/**
 * Return only filesystem metadata for the Pi JSON files.
 * In particular, auth.json is never read or parsed here.
 */
export function getDashboardFileStatus(agentDir: string): DashboardFileStatus {
	const fileExists = (name: string): boolean => {
		const filePath = join(agentDir, name);
		try {
			return existsSync(filePath) && statSync(filePath).isFile();
		} catch {
			return false;
		}
	};
	return {
		settings: fileExists("settings.json"),
		models: fileExists("models.json"),
		auth: fileExists("auth.json"),
	};
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
			settings: {
				path: join(agentDir, "settings.json"),
				exists: files.settings,
			},
			models: { path: join(agentDir, "models.json"), exists: files.models },
			auth: { path: join(agentDir, "auth.json"), exists: files.auth },
		},
	};
}
