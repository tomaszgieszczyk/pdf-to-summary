import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  base: "/reports/",
  server: {
    port: 5175,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    watch: { usePolling: process.env.VITE_USE_POLLING === "true" },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
