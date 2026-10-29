import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * - `vite` / `vite build`: the real console, talking to the Orrery API (runtime config from /config.js).
 * - `vite build --mode prototype`: one self-contained HTML file with the in-browser mock API,
 *   used as the clickable wireframe prototype.
 */
const stripRuntimeConfig = {
  name: "orrery-strip-runtime-config",
  transformIndexHtml: (html: string) => html.replace(/\s*<script src="\/config\.js"><\/script>/, ""),
};

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "prototype" ? [viteSingleFile(), stripRuntimeConfig] : [])],
  resolve: { conditions: ["@orrery/source", "browser", "module", "import", "default"] },
  define: { __ORRERY_PROTOTYPE__: JSON.stringify(mode === "prototype") },
  build: {
    outDir: mode === "prototype" ? "dist-prototype" : "dist",
    sourcemap: mode !== "prototype",
    target: "es2022",
  },
  server: {
    port: 5173,
    proxy: { "/v1": { target: process.env.ORRERY_API_URL ?? "http://localhost:8080", changeOrigin: true } },
  },
}));
