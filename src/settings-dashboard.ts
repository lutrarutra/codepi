import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	ASK_MODE_DEFAULT_ALLOWED_TOOLS,
	BUNDLED_RESOURCES,
	getEnabledBundledResources,
	readAskModeAllowedTools,
	readAutoVerifyMode,
	readTldrMode,
	readTerminalPrefs,
} from "./pi-store";
import type {
	DashboardData,
	PackageStatusEntry,
} from "./shared/settings-protocol";

export interface DashboardFileStatus {
	settings: boolean;
	models: boolean;
	auth: boolean;
}

export interface ConfiguredPackageStatusInput {
	source: string;
	scope: "user" | "project";
	installedPath?: string;
}

/**
 * Collect package status using the SDK's read-only package listing API.
 * This deliberately does not call resolve/install, so dashboard refresh never
 * performs network work merely to display status.
 */
export function collectConfiguredPackageStatus(
	sdk: Pick<
		typeof import("@earendil-works/pi-coding-agent"),
		"SettingsManager" | "DefaultPackageManager"
	>,
	cwd: string,
	agentDir: string,
): PackageStatusEntry[] {
	const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
	const packageManager = new sdk.DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager,
	});
	return mapConfiguredPackageStatus(packageManager.listConfiguredPackages());
}

/** Convert SDK package-manager entries into the credential-free dashboard shape. */
export function mapConfiguredPackageStatus(
	packages: ConfiguredPackageStatusInput[],
): PackageStatusEntry[] {
	return packages.map(({ source, scope, installedPath }) => ({
		source,
		scope,
		installed: installedPath !== undefined,
	}));
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
		terminalPrefs: readTerminalPrefs(settings),
		autoVerify: readAutoVerifyMode(settings),
		tldrMode: readTldrMode(settings),
		// Effective allowlist: the settings value when present, else the
		// seeded defaults (mirrors the extension's runtime fallback).
		askAllowedTools: [
			...(readAskModeAllowedTools(settings) ?? ASK_MODE_DEFAULT_ALLOWED_TOOLS),
		],
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
