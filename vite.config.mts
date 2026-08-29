import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [react()],
    // Relative asset paths, so the built page works from any origin or subpath — Netlify deploy,
    // a PR preview, or a host serving it from a directory.
    base: "./",
    build: { outDir: "build" },
    server: { port: 3021 },
});
