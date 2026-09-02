import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${process.env.NEXESTRA_PORT ?? "4242"}`,
    },
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
  },
});
