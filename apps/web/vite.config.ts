import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const daemonTarget = process.env.FORGE_DAEMON_URL?.trim() || "http://127.0.0.1:4782";
const cloudTarget = process.env.FORGE_CLOUD_API_URL?.trim() || "http://127.0.0.1:4790";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": daemonTarget,
      "/cloud": {
        target: cloudTarget,
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(/^\/cloud/, ""),
      },
    },
  },
});
