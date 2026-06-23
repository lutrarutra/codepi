import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // Fixed filenames so extension.ts can reference them reliably.
      output: {
        entryFileNames: "assets/index.js",
        assetFileNames: "assets/index.[ext]",
        chunkFileNames: "assets/[name].js",
      },
    },
  },
});
