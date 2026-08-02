/** Pure runtime resource-path construction for the embedded Pi SDK. */
import { join } from "node:path";
import {
	getEnabledBundledResources,
	type BundledResourceConfig,
} from "./pi-store";

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
	]
		.filter(([id]) => enabledIds.has(id as "custom-footer" | "filechanges"))
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

/** Return a copy of the default policy for callers that need its type. */
export function defaultRuntimeResourceConfig(): BundledResourceConfig {
	return {
		bundledExtensions: { "custom-footer": true, filechanges: true },
		bundledThemes: { "nebula-pulse": true },
	};
}
