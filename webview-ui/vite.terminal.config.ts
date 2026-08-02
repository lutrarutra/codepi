import { defineConfig } from "vite";

/**
 * Separate build for the terminal webview (xterm.js host).
 *
 * The settings webview and the terminal webview are independent pages with
 * different CSP + asset needs, so they get separate vite builds:
 *   settings → dist/assets/*.js + dist/assets/index.css
 *   terminal → dist/terminal.js + dist/terminal.css
 */
export default defineConfig({
	build: {
		outDir: "dist",
		emptyOutDir: false,
		// xterm needs a real script tag (non-module) — the terminal HTML shell
		// references "terminal.js" directly, so use IIFE instead of ESM.
		rollupOptions: {
			input: "src/terminal/terminal.ts",
			output: {
				format: "iife",
				entryFileNames: "terminal.js",
				assetFileNames: "terminal.css",
			},
		},
	},
});
