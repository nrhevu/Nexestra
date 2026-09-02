// Bundle the server into a single ESM file so that `@nexestra/*` workspace
// packages (which ship TypeScript sources, not build output) are inlined.
// Third-party runtime dependencies stay external and are resolved from
// node_modules at runtime.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  logLevel: "info",
  external: [
    "hono",
    "hono/*",
    "@hono/node-server",
    "ws",
    "zod",
    "drizzle-orm",
    "drizzle-orm/*",
    "better-sqlite3",
  ],
  banner: {
    js: [
      "import { createRequire as __nexestraCreateRequire } from 'node:module';",
      "const require = __nexestraCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
