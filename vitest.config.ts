import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { join } from "node:path";

// pi's extension loader resolves the @earendil-works packages via jiti aliases.
// pi 1.0 hoists them into the root node_modules (0.87.x nested them under
// pi-coding-agent), so prefer the hoisted entry and fall back to the nested
// layout. Mirror those aliases so extension tests can import them through
// vitest's vite transform.
const nested = join(
	__dirname,
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"node_modules",
	"@earendil-works",
);

const pkgRoot = join(__dirname, "node_modules", "@earendil-works");
const firstExisting = (...candidates: string[]): string =>
	candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];

const piAliases = {
	"@earendil-works/pi-tui": firstExisting(
		join(pkgRoot, "pi-tui", "dist", "index.js"),
		join(nested, "pi-tui", "dist", "index.js"),
	),
	"@earendil-works/pi-ai": firstExisting(
		join(pkgRoot, "pi-ai", "dist", "compat.js"),
		join(nested, "pi-ai", "dist", "compat.js"),
	),
	"@earendil-works/pi-ai/compat": firstExisting(
		join(pkgRoot, "pi-ai", "dist", "compat.js"),
		join(nested, "pi-ai", "dist", "compat.js"),
	),
	"@earendil-works/pi-ai/oauth": firstExisting(
		join(pkgRoot, "pi-ai", "dist", "oauth.js"),
		join(nested, "pi-ai", "dist", "oauth.js"),
	),
	"@earendil-works/pi-ai/providers/all": firstExisting(
		join(pkgRoot, "pi-ai", "dist", "providers", "all.js"),
		join(nested, "pi-ai", "dist", "providers", "all.js"),
	),
	"@earendil-works/pi-agent-core": firstExisting(
		join(pkgRoot, "pi-agent-core", "dist", "index.js"),
		join(nested, "pi-agent-core", "dist", "index.js"),
	),
	// typebox is a direct dependency since the pi 1.0 bump (it used to be
	// reachable only through pi-coding-agent's nested node_modules).
	typebox: firstExisting(
		join(__dirname, "node_modules", "typebox", "build", "index.mjs"),
		join(
			__dirname,
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"node_modules",
			"typebox",
			"build",
			"index.mjs",
		),
	),
};

export default defineConfig({
	test: {
		include: [
			"src/__tests__/**/*.test.ts",
			"resources/extensions/__tests__/**/*.test.ts",
		],
		environment: "node",
	},
	resolve: {
		alias: piAliases,
	},
});
