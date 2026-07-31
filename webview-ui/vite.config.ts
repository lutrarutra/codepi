import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	build: {
		outDir: "dist",
		// Single combined stylesheet: both webview HTML shells in the extension
		// (buildHtml / buildSettingsHtml) reference "assets/index.css" by name,
		// so per-entry CSS splitting would orphan the settings stylesheet
		// (assetFileNames dedupes the second CSS to "index2.css").
		cssCodeSplit: false,
		rollupOptions: {
			input: {
				index: "index.html",
				settings: "settings.html",
			},
			output: {
				entryFileNames: "assets/[name].js",
				chunkFileNames: "assets/[name].js",
				assetFileNames: "assets/index.css",
			},
		},
	},
});
