import esbuild from "esbuild";

const r = await esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
  external: ["vscode"],
  plugins: [{
    name: "external-earendil",
    setup(build) {
      build.onResolve({ filter: /^@earendil-works\// }, args => {
        return { path: args.path, external: true };
      });
    }
  }],
});

const out = r.outputFiles[0].text;
console.log("Bundle size:", (out.length / 1024 / 1024).toFixed(2), "MB");
console.log();

// Show the getPi function context
const idx = out.indexOf("async function getPi");
if (idx >= 0) {
  console.log(out.substring(idx, idx + 500));
}