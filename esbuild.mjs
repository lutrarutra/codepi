import * as esbuild from "esbuild";

const isProduction = process.argv.includes("--production");
const isWatch = process.argv.includes("--watch");
// By default both bundles are built. `--main` / `--bundled` select a single
// bundle (used by the Makefile's build-extension / build-bundled targets).
const buildMain = !process.argv.includes("--bundled");
const buildBundled = !process.argv.includes("--main");

/**
 * Reports bundle errors in a format the esbuild problem matcher picks up
 * (needs the `connor4312.esbuild-problem-matchers` extension for the
 * Problems panel). Mirrors the VS Code extension-authoring sample.
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: "esbuild-problem-matcher",

	setup(build) {
		build.onStart(() => {
			console.log("[watch] build started");
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				if (location == null) return;
				console.error(
					`    ${location.file}:${location.line}:${location.column}:`,
				);
			});
			console.log("[watch] build finished");
		});
	},
};

const sharedOptions = {
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	sourcemap: !isProduction,
	sourcesContent: false,
	minify: isProduction,
	plugins: [esbuildProblemMatcherPlugin],
};

// The extension host bundle: src/extension.ts and everything it imports
// (including resources/extensions/bash-bridge, which is inlined here).
const mainOptions = {
	...sharedOptions,
	entryPoints: ["src/extension.ts"],
	outfile: "dist/extension.js",
	external: [
		"vscode",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
		"@vscode/ripgrep-universal",
	],
};

/**
 * The bundled pi extensions (resources/extensions/codepi-*.ts) ship compiled
 * to resources/extensions/dist/*.js. At runtime pi's extension loader (jiti)
 * resolves the @earendil-works packages, typebox and vscode via its own alias
 * map — exactly the specifiers the raw sources import today — so those stay
 * external and every *relative* import (including codepi-task's dependency on
 * src/tools/bash) is inlined into a self-contained artifact that no longer
 * needs the dev tree's `src/` directory. See resources/extensions/__tests__/
 * smoke-load.mjs for the mirror of pi's alias map.
 *
 * Format must be ESM: pi's loader calls jiti.import(path, { default: true })
 * and requires the factory function back. jiti treats files with import/export
 * syntax as ESM (returning the default export) but returns the raw module.exports
 * object for CJS output (esbuild would put the factory at exports.default).
 */
const bundledExtensionsOptions = {
	...sharedOptions,
	entryPoints: [
		"resources/extensions/codepi-footer.ts",
		"resources/extensions/codepi-diff.ts",
		"resources/extensions/codepi-modes.ts",
		"resources/extensions/codepi-bash.ts",
		"resources/extensions/codepi-context.ts",
		"resources/extensions/codepi-task.ts",
	],
	outdir: "resources/extensions/dist",
	format: "esm",
	external: [
		"vscode",
		"@earendil-works/*",
		"@mariozechner/*",
		"typebox*",
		"@sinclair/typebox*",
	],
};

const contexts = [];
if (buildMain)
	contexts.push(["extension host", await esbuild.context(mainOptions)]);
if (buildBundled)
	contexts.push([
		"bundled extensions",
		await esbuild.context(bundledExtensionsOptions),
	]);

if (isWatch) {
	const settled = await Promise.all(contexts.map(async ([label, ctx]) => {
		await ctx.watch();
		return label;
	}));
	console.log(`watching for changes… (${settled.join(", ")})`);
} else {
	await Promise.all(contexts.map(async ([, ctx]) => {
		await ctx.rebuild();
		await ctx.dispose();
	}));
}
