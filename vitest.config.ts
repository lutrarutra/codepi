import { defineConfig } from "vitest/config";
import { join } from "node:path";

// pi's extension loader resolves the @earendil-works packages via jiti aliases
// (they live nested under pi-coding-agent's node_modules). Mirror those aliases
// so extension tests can import them through vitest's vite transform.
const nested = join(
	__dirname,
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"node_modules",
	"@earendil-works",
);

const piAliases = {
	"@earendil-works/pi-tui": join(nested, "pi-tui", "dist", "index.js"),
	"@earendil-works/pi-ai": join(nested, "pi-ai", "dist", "compat.js"),
	"@earendil-works/pi-ai/compat": join(nested, "pi-ai", "dist", "compat.js"),
	"@earendil-works/pi-ai/oauth": join(nested, "pi-ai", "dist", "oauth.js"),
	"@earendil-works/pi-ai/providers/all": join(
		nested,
		"pi-ai",
		"dist",
		"providers",
		"all.js",
	),
	"@earendil-works/pi-agent-core": join(
		nested,
		"pi-agent-core",
		"dist",
		"index.js",
	),
	// typebox lives nested under pi-coding-agent's node_modules (the pi loader
	// aliases it the same way at runtime).
	typebox: join(
		__dirname,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"node_modules",
		"typebox",
		"build",
		"index.mjs",
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
