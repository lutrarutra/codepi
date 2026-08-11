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
	// Bundled pi extensions ship COMPILED in resources/extensions/dist/*.js
	// (see esbuild.mjs bundledExtensionsOptions): the raw sources reference
	// dev-tree paths (codepi-task imports src/tools/bash) that must never be
	// resolved from the installed package, so the runtime entry points are the
	// compiled outputs.
	const bundledExtensionPaths = [
		["codepi-footer", "codepi-footer.js"],
		["codepi-diff", "codepi-diff.js"],
		["codepi-modes", "codepi-modes.js"],
		["codepi-bash", "codepi-bash.js"],
		["codepi-context", "codepi-context.js"],
		["codepi-task", "codepi-task.js"],
	]
		.filter(([id]) =>
			enabledIds.has(
				id as
					| "codepi-footer"
					| "codepi-diff"
					| "codepi-modes"
					| "codepi-bash"
					| "codepi-context"
					| "codepi-task",
			),
		)
		.map(([, filename]) => join(extensionResourcesDir, "dist", filename));
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

/** A loaded SDK extension object, as seen by DefaultResourceLoader's
 * extensionsOverride — only the registration surfaces we care about. */
export interface LoadedExtensionLike {
	resolvedPath?: string;
	path?: string;
	commands?: Map<string, unknown> | { keys(): Iterable<string> };
	tools?: Map<string, unknown> | { keys(): Iterable<string> };
}

function registrationNames(ext: LoadedExtensionLike): string[] {
	const names: string[] = [];
	for (const table of [ext.commands, ext.tools]) {
		if (!table) continue;
		const keys =
			table instanceof Map
				? table.keys()
				: (table as { keys(): Iterable<string> }).keys();
		for (const name of keys) {
			if (typeof name === "string") names.push(name);
		}
	}
	return names;
}

/**
 * Drop user-installed extensions that collide with CodePi's bundled ones.
 *
 * The SDK keeps every loaded extension and disambiguates same-named
 * commands/tools by suffixing (`/filechanges-accept:1` / `:2`), so a
 * 3rd-party extension that ships the same feature as a bundled one (e.g.
 * codepi-diff) shows up as duplicate command-palette entries. CodePi's
 * bundled copy wins: any non-bundled extension registering a command or tool
 * name also registered by a bundled extension is removed, and the caller
 * should drop its loader diagnostics along with it.
 */
export function filterConflictingExtensions<T extends LoadedExtensionLike>(
	extensions: T[],
	bundledPaths: Iterable<string>,
): { extensions: T[]; droppedPaths: string[] } {
	const bundled = new Set(bundledPaths);
	const isBundled = (ext: LoadedExtensionLike) =>
		bundled.has(ext.resolvedPath ?? ext.path ?? "");

	const bundledNames = new Set<string>();
	for (const ext of extensions) {
		if (!isBundled(ext)) continue;
		for (const name of registrationNames(ext)) bundledNames.add(name);
	}

	const kept: T[] = [];
	const droppedPaths: string[] = [];
	for (const ext of extensions) {
		if (isBundled(ext)) {
			kept.push(ext);
			continue;
		}
		if (registrationNames(ext).some((name) => bundledNames.has(name))) {
			droppedPaths.push(ext.resolvedPath ?? ext.path ?? "");
			continue;
		}
		kept.push(ext);
	}
	return { extensions: kept, droppedPaths };
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
