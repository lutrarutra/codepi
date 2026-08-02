import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
	applyImplicitBundledTheme,
	buildPiResourceLoaderOptions,
	buildPiRuntimeResourcePaths,
} from "../pi-runtime-config";

describe("Pi runtime resource paths", () => {
	const extensionResources = "/extension/resources/extensions";
	const agentDir = "/home/user/.pi/agent";

	it("enables CodePi bundled resources by default", () => {
		const paths = buildPiRuntimeResourcePaths(extensionResources, agentDir, {});
		expect(paths.bundledExtensionPaths).toEqual([
			join(extensionResources, "custom-footer.ts"),
			join(extensionResources, "filechanges.ts"),
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

	it("removes explicitly disabled bundled resources", () => {
		const paths = buildPiRuntimeResourcePaths(extensionResources, agentDir, {
			codepi: {
				bundledExtensions: { "custom-footer": false },
				bundledThemes: { "nebula-pulse": false },
			},
		});
		expect(paths.bundledExtensionPaths).toEqual([
			join(extensionResources, "filechanges.ts"),
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

	it("does not override an explicit user theme", () => {
		let theme: string | undefined = "user-theme";
		const settingsManager = {
			getThemeSetting: () => theme,
			applyOverrides: (overrides: { theme: string }) => {
				theme = overrides.theme;
			},
		};

		applyImplicitBundledTheme(settingsManager, true);
		expect(theme).toBe("user-theme");
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
