import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // In development the SPA and the API run as separate processes; in
    // production the same worker serves both, so requests stay relative.
    proxy: { "/api": "http://localhost:8788" },
  },
});
