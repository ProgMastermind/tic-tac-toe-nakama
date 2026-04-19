import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config is intentionally minimal — one plugin, one server setting.
// Deployment-specific values are injected through VITE_* env vars so the
// same build can target local docker and a production droplet.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
