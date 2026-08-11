// Package-content check: assert the built .vsix ships every runtime asset and
// no dev-tree-only sources. Runs after `make vsix` (make check-package) so a
// packaging regression — missing bundled extension, theme, font, or raw .ts
// leaking into the artifact — fails the release instead of the user's install.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const dist = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist");
const vsix = readdirSync(dist).find((f) => f.endsWith(".vsix"));
if (!vsix) {
	console.error("check-package: no .vsix found in dist/ — run `make vsix` first");
	process.exit(1);
}

let listing;
try {
	listing = execFileSync("unzip", ["-Z1", join(dist, vsix)], {
		encoding: "utf8",
		maxBuffer: 128 * 1024 * 1024,
	}).split("\n");
} catch (e) {
	console.error(`check-package: failed to list ${vsix}: ${e.message}`);
	process.exit(1);
}
const files = new Set(
	listing.filter(Boolean).map((f) => f.replace(/^extension\//, "")),
);

const required = [
	// Extension host bundle
	"dist/extension.js",
	// Compiled bundled pi extensions (the codepi-task fix)
	"resources/extensions/dist/codepi-footer.js",
	"resources/extensions/dist/codepi-diff.js",
	"resources/extensions/dist/codepi-modes.js",
	"resources/extensions/dist/codepi-bash.js",
	"resources/extensions/dist/codepi-context.js",
	"resources/extensions/dist/codepi-task.js",
	// Theme (nebula) + shared resources
	"resources/themes/nebula-pulse.json",
	"resources/shared/ask-allowlist.ts",
	// media/ (webview localResourceRoots: favicons, logo, terminal fonts)
	"media/favicon-idle.svg",
	"media/pi-icon.svg",
	"media/codepi-logo.woff",
	"media/fira-code-nerd-regular.woff2",
	"media/fira-code-nerd-bold.woff2",
	"media/OFL-FiraCodeNerd.txt",
	// Terminal fonts copied into the webview bundle (copy:fonts)
	"webview-ui/dist/fira-code-nerd-regular.woff2",
	"webview-ui/dist/fira-code-nerd-bold.woff2",
];

const forbidden = [
	// Raw bundled-extension sources — the package must be self-contained
	"resources/extensions/codepi-task.ts",
	"resources/extensions/codepi-bash.ts",
	"resources/extensions/codepi-footer.ts",
	"resources/extensions/codepi-diff.ts",
	"resources/extensions/codepi-modes.ts",
	"resources/extensions/codepi-context.ts",
	"resources/extensions/__tests__/smoke-load.mjs",
	// Host TypeScript sources are not packaged (bundled into extension.js)
	"src/extension.ts",
	"src/tools/bash.ts",
];

const missing = required.filter((f) => !files.has(f));
const leaked = forbidden.filter((f) => files.has(f));

if (missing.length || leaked.length) {
	for (const f of missing)
		console.error(`check-package: MISSING required asset: ${f}`);
	for (const f of leaked)
		console.error(`check-package: UNEXPECTED dev source in package: ${f}`);
	console.error(`check-package: FAIL (${vsix})`);
	process.exit(1);
}

console.log(
	`check-package: PASS (${vsix}) — ${required.length} required assets present, 0 dev sources leaked`,
);
