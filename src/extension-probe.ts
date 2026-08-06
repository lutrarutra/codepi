/** Extension probe: load installed pi extensions via the SDK's public loader
 * APIs WITHOUT creating a session. vscode-free so it can run in vitest.
 * The snapshot builder (extension-snapshot.ts) consumes its result. */
import { existsSync } from "node:fs";
import {
	buildCurrentPiRuntimeResourcePaths,
	buildPiResourceLoaderOptions,
	filterConflictingExtensions,
} from "./pi-runtime-config";
import type {
	Extension,
	LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import type { LoadedExtensionRich } from "./extension-snapshot";

let sdkPromise:
	| Promise<typeof import("@earendil-works/pi-coding-agent")>
	| undefined;
function getSdk(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
	if (!sdkPromise) sdkPromise = import("@earendil-works/pi-coding-agent");
	return sdkPromise;
}

export interface ProbeOptions {
	cwd: string;
	agentDir: string;
	extensionResourcesDir: string;
	readSettings: () => unknown;
}

export interface ProbeResult {
	extensions: LoadedExtensionRich[];
	loadErrors: Array<{ path: string; error: string }>;
	skills: Array<{ name: string; description?: string }>;
	prompts: Array<{ name: string; description?: string }>;
}

/**
 * Load extensions exactly like a fresh session would (same loader options,
 * same bundled-path construction, same conflict filtering) but WITHOUT
 * creating a session. Uses public SDK loader APIs only.
 */
export async function probeExtensions(
	opts: ProbeOptions,
): Promise<ProbeResult> {
	const pi = await getSdk();
	const settingsManager = pi.SettingsManager.create(opts.cwd, opts.agentDir);
	const resourcePaths = buildCurrentPiRuntimeResourcePaths(
		opts.extensionResourcesDir,
		opts.agentDir,
		opts.readSettings,
	);
	const bundledExtensions = resourcePaths.bundledExtensionPaths.filter(
		(p: string) => existsSync(p),
	);
	// The runtime factory also appends the rpiv-todo package extension when
	// present — mirror it so the probe shows exactly what a session loads.
	if (existsSync(resourcePaths.rpivTodoPath)) {
		bundledExtensions.push(resourcePaths.rpivTodoPath);
	}
	const bundledThemes = resourcePaths.bundledThemePaths.filter((p: string) =>
		existsSync(p),
	);
	const loader = new pi.DefaultResourceLoader({
		...buildPiResourceLoaderOptions(opts.cwd, opts.agentDir, {
			...resourcePaths,
			bundledExtensionPaths: bundledExtensions,
			bundledThemePaths: bundledThemes,
		}),
		settingsManager,
		extensionsOverride: (base: LoadExtensionsResult) => {
			// Same "bundled copy wins" conflict filtering the runtime factory
			// applies (extension.ts), so the probe mirrors a real session.
			const { extensions, droppedPaths } = filterConflictingExtensions(
				base.extensions,
				bundledExtensions,
			);
			const dropped = new Set(droppedPaths);
			return {
				...base,
				extensions,
				errors: base.errors.filter((error) => !dropped.has(error.path)),
			};
		},
	});
	await loader.reload();
	const result = loader.getExtensions();
	let skills: ProbeResult["skills"] = [];
	try {
		skills = loader.getSkills().skills.map((s) => ({
			name: s.name ?? "?",
			...(s.description ? { description: s.description } : {}),
		}));
	} catch {
		skills = [];
	}
	let prompts: ProbeResult["prompts"] = [];
	try {
		prompts = loader.getPrompts().prompts.map((p) => ({
			name: p.name ?? "?",
			...(p.description ? { description: p.description } : {}),
		}));
	} catch {
		prompts = [];
	}
	return {
		extensions: result.extensions as LoadedExtensionRich[],
		loadErrors: result.errors.map((e) => ({
			path: e.path,
			error: e.error,
		})),
		skills,
		prompts,
	};
}
