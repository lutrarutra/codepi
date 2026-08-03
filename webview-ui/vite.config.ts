import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	build: {
		outDir: "dist",
		// Single combined stylesheet: the settings HTML shell (buildSettingsHtml)
		// references "assets/index.css" by name, so per-entry CSS splitting would
		// orphan the stylesheet (assetFileNames dedupes the second CSS to "index2.css").
		cssCodeSplit: false,
		rollupOptions: {
			input: {
				settings: "settings.html",
				extensions: "extensions.html",
			},
			output: {
				entryFileNames: "assets/[name].js",
				chunkFileNames: "assets/[name].js",
				assetFileNames: "assets/index.css",
			},
		},
	},
});
