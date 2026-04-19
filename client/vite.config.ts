import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config is intentionally minimal — one plugin, one server setting,
// and the @/ alias that mirrors tsconfig paths. Deployment-specific values
// are injected through VITE_* env vars so the same build can target local
// docker and a production droplet without code changes.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(here, "src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
