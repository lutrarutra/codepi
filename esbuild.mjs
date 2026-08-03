import * as esbuild from "esbuild";

const isProduction = process.argv.includes("--production");
const isWatch = process.argv.includes("--watch");

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

const ctx = await esbuild.context({
	entryPoints: ["src/extension.ts"],
	bundle: true,
	outfile: "dist/extension.js",
	external: [
		"vscode",
		"@earendil-works/pi-coding-agent",
		"@vscode/ripgrep-universal",
	],
	format: "cjs",
	platform: "node",
	target: "node18",
	sourcemap: !isProduction,
	sourcesContent: false,
	minify: isProduction,
	plugins: [esbuildProblemMatcherPlugin],
});

if (isWatch) {
	await ctx.watch();
	console.log("watching for changes…");
} else {
	await ctx.rebuild();
	await ctx.dispose();
}
