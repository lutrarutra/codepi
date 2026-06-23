import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = !production;

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  outfile: "dist/extension.js",
  // pi SDK is ESM-only; externalize so it loads from node_modules at runtime instead of bundling as CJS
  plugins: [
    {
      name: "external-earendil",
      setup(build) {
        build.onResolve({ filter: /^@earendil-works\// }, (args) => ({
          path: args.path,
          external: true,
        }));
      },
    },
  ],
  external: ["vscode"],
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
  console.log("[esbuild] watching...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
