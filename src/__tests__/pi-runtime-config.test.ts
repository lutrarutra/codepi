import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
	applyImplicitBundledTheme,
	buildCurrentPiRuntimeResourcePaths,
	buildPiResourceLoaderOptions,
	buildPiRuntimeResourcePaths,
	extensionRegistersName,
	filterConflictingExtensions,
	installImplicitBundledThemeReload,
} from "../pi-runtime-config";

describe("Pi runtime resource paths", () => {
	const extensionResources = "/extension/resources/extensions";
	const agentDir = "/home/user/.pi/agent";

	it("enables CodePi bundled resources by default", () => {
		const paths = buildPiRuntimeResourcePaths(extensionResources, agentDir, {});
		expect(paths.bundledExtensionPaths).toEqual([
			join(extensionResources, "dist", "codepi-footer.js"),
			join(extensionResources, "dist", "codepi-diff.js"),
			join(extensionResources, "dist", "codepi-modes.js"),
			join(extensionResources, "dist", "codepi-bash.js"),
			join(extensionResources, "dist", "codepi-context.js"),
			join(extensionResources, "dist", "codepi-task.js"),
		]);
		expect(paths.bundledThemePaths).toEqual([
			join(extensionResources, "..", "themes", "nebula-pulse.json"),
		]);
		expect(paths.rpivTodoPath).toBe(
			join(
				agentDir,
				"npm",
				"node_modules",
				"@juicesharp",
				"rpiv-todo",
				"index.ts",
			),
		);
	});

	it("rereads settings for each new runtime resource factory call", () => {
		let settings: unknown = {};
		const readSettings = () => settings;
		const first = buildCurrentPiRuntimeResourcePaths(
			extensionResources,
			agentDir,
			readSettings,
		);
		expect(first.bundledExtensionPaths).toContain(
			join(extensionResources, "dist", "codepi-footer.js"),
		);
		settings = { codepi: { bundledExtensions: { "codepi-footer": false } } };
		const second = buildCurrentPiRuntimeResourcePaths(
			extensionResources,
			agentDir,
			readSettings,
		);
		expect(second.bundledExtensionPaths).not.toContain(
			join(extensionResources, "dist", "codepi-footer.js"),
		);
		expect(second.bundledExtensionPaths).toContain(
			join(extensionResources, "dist", "codepi-diff.js"),
		);
	});

	it("removes explicitly disabled bundled resources", () => {
		const paths = buildPiRuntimeResourcePaths(extensionResources, agentDir, {
			codepi: {
				bundledExtensions: { "codepi-footer": false },
				bundledThemes: { "nebula-pulse": false },
			},
		});
		expect(paths.bundledExtensionPaths).toEqual([
			join(extensionResources, "dist", "codepi-diff.js"),
			join(extensionResources, "dist", "codepi-modes.js"),
			join(extensionResources, "dist", "codepi-bash.js"),
			join(extensionResources, "dist", "codepi-context.js"),
			join(extensionResources, "dist", "codepi-task.js"),
		]);
		expect(paths.bundledThemePaths).toEqual([]);
	});

	it("reapplies the implicit theme after a loader reload boundary", () => {
		let theme: string | undefined;
		const settingsManager = {
			getThemeSetting: () => theme,
			applyOverrides: (overrides: { theme: string }) => {
				theme = overrides.theme;
			},
		};
		const loaderReload = () => {
			// Mirrors SettingsManager.reload(): disk settings replace in-memory overrides.
			theme = undefined;
		};

		applyImplicitBundledTheme(settingsManager, true);
		expect(theme).toBe("nebula-pulse");
		loaderReload();
		expect(theme).toBeUndefined();
		applyImplicitBundledTheme(settingsManager, true);
		expect(theme).toBe("nebula-pulse");
	});

	it("reapplies the theme through the later AgentSession.reload hook", async () => {
		let theme: string | undefined;
		let reloadCalls = 0;
		const settingsManager = {
			getThemeSetting: () => theme,
			applyOverrides: (overrides: { theme: string }) => {
				theme = overrides.theme;
			},
		};
		const session = {
			reload: async (options?: {
				beforeSessionStart?: () => void | Promise<void>;
			}) => {
				reloadCalls++;
				theme = undefined;
				await options?.beforeSessionStart?.();
			},
		};

		installImplicitBundledThemeReload(session, settingsManager, () => true);
		await session.reload();
		expect(reloadCalls).toBe(1);
		expect(theme).toBe("nebula-pulse");
	});

	it("does not reapply a disabled bundled theme or override an explicit user theme", async () => {
		const makeSettingsManager = (persistedTheme?: string) => {
			let theme = persistedTheme;
			return {
				settingsManager: {
					getThemeSetting: () => theme,
					applyOverrides: (overrides: { theme: string }) => {
						theme = overrides.theme;
					},
				},
				getTheme: () => theme,
				resetFromDisk: () => {
					theme = persistedTheme;
				},
			};
		};
		const makeSession = (resetFromDisk: () => void) => ({
			reload: async (options?: {
				beforeSessionStart?: () => void | Promise<void>;
			}) => {
				resetFromDisk();
				await options?.beforeSessionStart?.();
			},
		});

		const disabled = makeSettingsManager();
		const disabledSession = makeSession(disabled.resetFromDisk);
		installImplicitBundledThemeReload(
			disabledSession,
			disabled.settingsManager,
			() => false,
		);
		await disabledSession.reload();
		expect(disabled.getTheme()).toBeUndefined();

		const explicit = makeSettingsManager("user-theme");
		const explicitSession = makeSession(explicit.resetFromDisk);
		installImplicitBundledThemeReload(
			explicitSession,
			explicit.settingsManager,
			() => true,
		);
		await explicitSession.reload();
		expect(explicit.getTheme()).toBe("user-theme");
	});

	it("builds a canonical loader configuration with extensions enabled", () => {
		const resources = buildPiRuntimeResourcePaths(
			extensionResources,
			agentDir,
			{},
		);
		expect(
			buildPiResourceLoaderOptions("/workspace", agentDir, resources),
		).toEqual({
			cwd: "/workspace",
			agentDir,
			noExtensions: false,
			additionalExtensionPaths: resources.bundledExtensionPaths,
			additionalThemePaths: resources.bundledThemePaths,
		});
	});
});

// ── filterConflictingExtensions ─────────────────────────────

describe("extensionRegistersName", () => {
	const bundledContext = "/ext/resources/extensions/dist/codepi-context.js";

	function ext(
		path: string,
		commands: string[] = [],
		tools: string[] = [],
	): any {
		return {
			path,
			resolvedPath: path,
			commands: new Map(commands.map((name) => [name, { name }])),
			tools: new Map(tools.map((name) => [name, { name }])),
		};
	}

	it("detects a bundled extension by its registered tools (compiled .js path)", () => {
		// Regression: the host used to test the "codepi-context.ts" path suffix,
		// which never matched bundled extensions shipped as dist/*.js — so the
		// host fallback registered duplicate get_editor_context/get_git_diff
		// tools and warned on every session.
		expect(
			extensionRegistersName(
				ext(bundledContext, [], ["get_editor_context", "get_git_diff"]),
				"get_editor_context",
			),
		).toBe(true);
	});

	it("reads command registrations as well", () => {
		expect(
			extensionRegistersName(
				ext(bundledContext, ["filechanges"]),
				"filechanges",
			),
		).toBe(true);
	});

	it("is false for other names, no registrations and plain key tables", () => {
		expect(
			extensionRegistersName(ext(bundledContext), "get_editor_context"),
		).toBe(false);
		expect(
			extensionRegistersName(
				ext(bundledContext, ["status"], ["head"]),
				"get_editor_context",
			),
		).toBe(false);
		const plainTables = {
			path: bundledContext,
			commands: { keys: () => ["filechanges"][Symbol.iterator]() },
		};
		expect(extensionRegistersName(plainTables, "filechanges")).toBe(true);
	});
});

describe("filterConflictingExtensions", () => {
	const bundledDiff = "/ext/resources/extensions/dist/codepi-diff.js";
	const bundledBash = "/ext/resources/extensions/dist/codepi-bash.js";
	const thirdPartyDiff = "/home/user/.pi/agent/extensions/filechanges/index.ts";
	const unrelated = "/home/user/.pi/agent/extensions/local-models.ts";

	function ext(
		path: string,
		commands: string[] = [],
		tools: string[] = [],
	): any {
		return {
			path,
			resolvedPath: path,
			commands: new Map(commands.map((name) => [name, { name }])),
			tools: new Map(tools.map((name) => [name, { name }])),
		};
	}

	it("drops a 3rd-party extension registering the same commands as a bundled one", () => {
		const { extensions, droppedPaths } = filterConflictingExtensions(
			[
				ext(thirdPartyDiff, [
					"filechanges",
					"filechanges-accept",
					"filechanges-decline",
				]),
				ext(unrelated, ["local-models"]),
				ext(bundledDiff, [
					"filechanges",
					"filechanges-accept",
					"filechanges-decline",
				]),
			],
			[bundledDiff],
		);
		expect(droppedPaths).toEqual([thirdPartyDiff]);
		expect(extensions.map((e) => e.path)).toEqual([unrelated, bundledDiff]);
	});

	it("keeps non-bundled extensions that do not collide", () => {
		const { extensions, droppedPaths } = filterConflictingExtensions(
			[
				ext(unrelated, ["local-models"]),
				ext(bundledDiff, ["filechanges-accept"]),
			],
			[bundledDiff],
		);
		expect(droppedPaths).toEqual([]);
		expect(extensions.map((e) => e.path)).toEqual([unrelated, bundledDiff]);
	});

	it("also drops on tool-name collisions (e.g. a 3rd-party bash tool)", () => {
		const thirdPartyBash = "/home/user/.pi/agent/extensions/bash/index.ts";
		const { droppedPaths, extensions } = filterConflictingExtensions(
			[ext(thirdPartyBash, [], ["bash"]), ext(bundledBash, [], ["bash"])],
			[bundledBash],
		);
		expect(droppedPaths).toEqual([thirdPartyBash]);
		expect(extensions.map((e) => e.path)).toEqual([bundledBash]);
	});

	it("keeps the standalone extension when the bundled copy is not loaded", () => {
		// e.g. codepi's bundled codepi-diff disabled in Settings — the
		// 3rd-party one is then the only copy and must be kept.
		const { extensions, droppedPaths } = filterConflictingExtensions(
			[ext(thirdPartyDiff, ["filechanges-accept"])],
			[bundledDiff],
		);
		expect(droppedPaths).toEqual([]);
		expect(extensions).toHaveLength(1);
	});
});
