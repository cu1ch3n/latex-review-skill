import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const target = process.env.REVIEW_API ?? "http://127.0.0.1:8765";
const proxy = {
  target,
  changeOrigin: true,
  configure(server: import("vite").HttpProxy.ProxyServer) {
    server.on("proxyReq", (request) => request.setHeader("Origin", target));
  },
};
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    proxy: {
      "/api": proxy,
      "/files": proxy,
    },
  },
});
