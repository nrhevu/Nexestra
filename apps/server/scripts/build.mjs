// Bundle the server into a single ESM file so that `@nexestra/*` workspace
// packages (which ship TypeScript sources, not build output) are inlined.
// Third-party runtime dependencies stay external and are resolved from
// node_modules at runtime.
//
// "External" is not free: under pnpm's isolated `node_modules`, a package the
// bundle imports has to be a declared dependency of `apps/server` itself, or
// `node dist/index.js` dies with `ERR_MODULE_NOT_FOUND`. So the rule here is:
// externalise only what *cannot* be bundled — the native `better-sqlite3`
// binding, which is a `.node` file — and list it in `apps/server`'s own
// dependencies. Everything else, `drizzle-orm` included, is inlined, which is
// why the storage layer's dependencies do not have to be repeated here.
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/**
 * Left out of the bundle, resolved from `node_modules` at run time.
 *
 * `better-sqlite3` has to be here: it loads a compiled `.node` binding, which
 * no bundler can inline. The rest are here because they are large, stable and
 * already declared — but every entry is checked against `package.json` below,
 * so adding one without declaring it fails the build instead of failing at
 * `pnpm start`.
 */
const EXTERNAL = [
  "better-sqlite3",
  "hono",
  "hono/*",
  "@hono/node-server",
  "@anthropic-ai/sdk",
  "@anthropic-ai/sdk/*",
  "ws",
  "zod",
];

await assertExternalsAreDeclared();

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  logLevel: "info",
  external: EXTERNAL,
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

/**
 * Every external must be a runtime dependency of `apps/server`.
 *
 * This is the check that would have caught the M6 bug where `drizzle-orm` and
 * `better-sqlite3` were externalised while only `@nexestra/storage` depended on
 * them: the bundle built fine and `node dist/index.js` threw
 * `ERR_MODULE_NOT_FOUND` on the first import.
 */
async function assertExternalsAreDeclared() {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  const missing = [...new Set(EXTERNAL.map((entry) => entry.replace(/\/\*$/, "")))].filter(
    (name) => !declared.has(name),
  );

  if (missing.length > 0) {
    process.stderr.write(
      `apps/server/scripts/build.mjs: externalised but not a dependency of @nexestra/server: ${missing.join(", ")}\n` +
        "Add it to apps/server/package.json or drop it from EXTERNAL so esbuild bundles it.\n",
    );
    process.exit(1);
  }
}
