/** Pure runtime resource-path construction for the embedded Pi SDK. */
import { join } from "node:path";
import { getEnabledBundledResources } from "./pi-store";

export interface PiRuntimeResourcePaths {
	/** CodePi-shipped extension entry points selected by user policy. */
	bundledExtensionPaths: string[];
	/** CodePi-shipped theme entry points selected by user policy. */
	bundledThemePaths: string[];
	/** User-installed rpiv-todo entry point, if present on disk. */
	rpivTodoPath: string;
}

export interface PiResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	noExtensions: false;
	additionalExtensionPaths: string[];
	additionalThemePaths: string[];
}

/**
 * Construct CodePi's additional SDK resource paths without touching VS Code or
 * the filesystem. The caller decides which paths exist before loading them.
 */
export function buildPiRuntimeResourcePaths(
	extensionResourcesDir: string,
	agentDir: string,
	settings: unknown,
): PiRuntimeResourcePaths {
	const enabled = getEnabledBundledResources(settings);
	const enabledIds = new Set(enabled.map((resource) => resource.id));
	const bundledExtensionPaths = [
		["custom-footer", "custom-footer.ts"],
		["filechanges", "filechanges.ts"],
		["codepi-modes", "codepi-modes.ts"],
		["codepi-bash", "codepi-bash.ts"],
		["codepi-context", "codepi-context.ts"],
	]
		.filter(([id]) =>
			enabledIds.has(
				id as
					| "custom-footer"
					| "filechanges"
					| "codepi-modes"
					| "codepi-bash"
					| "codepi-context",
			),
		)
		.map(([, filename]) => join(extensionResourcesDir, filename));
	const bundledThemePaths = enabledIds.has("nebula-pulse")
		? [join(extensionResourcesDir, "..", "themes", "nebula-pulse.json")]
		: [];

	return {
		bundledExtensionPaths,
		bundledThemePaths,
		rpivTodoPath: join(
			agentDir,
			"npm",
			"node_modules",
			"@juicesharp",
			"rpiv-todo",
			"index.ts",
		),
	};
}

/**
 * Build resource paths from settings read at call time. Runtime factories use
 * this wrapper so each newly created session observes current toggles rather
 * than an activation-time settings snapshot.
 */
export function buildCurrentPiRuntimeResourcePaths(
	extensionResourcesDir: string,
	agentDir: string,
	readSettings: () => unknown,
): PiRuntimeResourcePaths {
	return buildPiRuntimeResourcePaths(
		extensionResourcesDir,
		agentDir,
		readSettings(),
	);
}

export function buildPiResourceLoaderOptions(
	cwd: string,
	agentDir: string,
	resourcePaths: PiRuntimeResourcePaths,
): PiResourceLoaderOptions {
	return {
		cwd,
		agentDir,
		noExtensions: false,
		additionalExtensionPaths: [...resourcePaths.bundledExtensionPaths],
		additionalThemePaths: [...resourcePaths.bundledThemePaths],
	};
}

/**
 * Apply CodePi's implicit bundled theme without persisting it to settings.json.
 * Call this after any SDK reload, because SettingsManager.reload() replaces
 * in-memory overrides with values read from disk.
 */
export interface ReloadablePiSession {
	reload(options?: {
		beforeSessionStart?: () => Promise<void> | void;
	}): Promise<void>;
}

/**
 * Keep the implicit bundled theme effective across Pi's AgentSession.reload().
 * AgentSession.reload() reloads SettingsManager and ResourceLoader before it
 * invokes beforeSessionStart, so compose that supported hook rather than
 * patching the SDK internals or persisting a CodePi-only setting.
 */
export function installImplicitBundledThemeReload(
	session: ReloadablePiSession,
	settingsManager: {
		getThemeSetting(): unknown;
		applyOverrides(overrides: { theme: string }): void;
	},
	isBundledThemeEnabled: () => boolean,
): void {
	const reload = session.reload.bind(session);
	session.reload = async (options = {}) => {
		const beforeSessionStart = options.beforeSessionStart;
		return reload({
			...options,
			beforeSessionStart: async () => {
				applyImplicitBundledTheme(settingsManager, isBundledThemeEnabled());
				await beforeSessionStart?.();
			},
		});
	};
}

export function applyImplicitBundledTheme(
	settingsManager: {
		getThemeSetting(): unknown;
		applyOverrides(overrides: { theme: string }): void;
	},
	bundledThemeEnabled: boolean,
): void {
	if (bundledThemeEnabled && settingsManager.getThemeSetting() === undefined) {
		settingsManager.applyOverrides({ theme: "nebula-pulse" });
	}
}
