import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  base: "/editor-assets/",
  plugins: [react()],
  root: resolve(import.meta.dirname, "src/app"),
  build: {
    outDir: resolve(import.meta.dirname, "assets/editor-app"),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("moveable") || id.includes("selecto") || id.includes("@daybrush") || id.includes("gesto")) return "canvas-tools";
          if (id.includes("lucide-react")) return "icons";
          if (id.includes("react") || id.includes("zustand")) return "react-runtime";
          return undefined;
        },
      },
    },
  },
});
