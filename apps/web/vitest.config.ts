import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const resolveFromHere = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/**
 * Component tests run in jsdom against the workspace sources, exactly as the
 * app does — the aliases mirror `vite.config.ts` rather than resolving the
 * packages through node_modules, so a test cannot pass against a stale build.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@nexestra/core/mock": resolveFromHere("../../packages/core/src/mock/index.ts"),
      "@nexestra/core": resolveFromHere("../../packages/core/src/index.ts"),
      "@nexestra/ui-kit/styles.css": resolveFromHere("../../packages/ui-kit/src/styles.css"),
      "@nexestra/ui-kit": resolveFromHere("../../packages/ui-kit/src/index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
