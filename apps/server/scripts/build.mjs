// Bundle the server into a single ESM file so that `@nexestra/*` workspace
// packages (which ship TypeScript sources, not build output) are inlined.
// Third-party runtime dependencies stay external and are resolved from
// node_modules at runtime.
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

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
    "@anthropic-ai/sdk",
    "@anthropic-ai/sdk/*",
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

// The Master reads its phase prompts as Markdown at run time. esbuild inlines
// the TypeScript but not the `.md` next to it, so copy the directory into the
// bundle; `src/master/prompts.ts` falls back to reading `dist/prompts` when
// `loadPromptSet()` cannot find the package sources.
const prompts = resolve(root, "../../packages/master/src/prompts");
await mkdir(resolve(root, "dist/prompts"), { recursive: true });
await cp(prompts, resolve(root, "dist/prompts"), {
  recursive: true,
  filter: (source) => !source.endsWith(".ts"),
});
process.stdout.write("  copied packages/master/src/prompts → dist/prompts\n");
