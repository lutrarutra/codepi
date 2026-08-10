// Copy the bundled terminal fonts from media/ into webview-ui/dist so the
// terminal webview can always load them: dist/ is permanently in the panel's
// localResourceRoots (even panels created before media/ was added), while
// media/ is not.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dist = join(root, "webview-ui", "dist");

const fonts = ["fira-code-nerd-regular.woff2", "fira-code-nerd-bold.woff2"];

mkdirSync(dist, { recursive: true });
for (const f of fonts) {
	const src = join(root, "media", f);
	if (!existsSync(src)) {
		console.warn(`[CodePi] missing bundled font: ${src}`);
		continue;
	}
	copyFileSync(src, join(dist, f));
	console.log(`[CodePi] copied ${f} -> webview-ui/dist/`);
}
