import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const resolveFromHere = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/** Backend port; keep in sync with `NEXESTRA_PORT` in apps/server. */
const API_TARGET = `http://127.0.0.1:${process.env.NEXESTRA_PORT ?? 4242}`;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Workspace packages ship TypeScript sources; alias them so Vite compiles
      // them as part of the app instead of trying to pre-bundle them.
      "@nexestra/core/mock": resolveFromHere("../../packages/core/src/mock/index.ts"),
      "@nexestra/core": resolveFromHere("../../packages/core/src/index.ts"),
      "@nexestra/ui-kit/styles.css": resolveFromHere("../../packages/ui-kit/src/styles.css"),
      "@nexestra/ui-kit": resolveFromHere("../../packages/ui-kit/src/index.ts"),
    },
  },
  server: {
    // Bind IPv4 explicitly: the default `localhost` resolves to ::1 only on
    // macOS, which makes `curl http://127.0.0.1:5173` fail.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/ws": { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
