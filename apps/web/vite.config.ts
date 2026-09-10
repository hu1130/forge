import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4782",
      "/cloud": {
        target: "http://127.0.0.1:4790",
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(/^\/cloud/, ""),
      },
    },
  },
});
