import * as esbuild from "esbuild";

const isProduction = process.argv.includes("--production");

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
	minify: isProduction,
});

if (isProduction) {
	await ctx.rebuild();
	await ctx.dispose();
} else {
	await ctx.watch();
	console.log("watching...");
}
