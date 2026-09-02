/**
 * Getting the Master's prompts into the server.
 *
 * `@nexestra/master` reads `src/prompts/*.md` from disk relative to its own
 * module. That works under `tsx` and Vitest, where the package's sources are
 * on disk, but not in `apps/server/dist/index.js`: esbuild inlines the
 * TypeScript and leaves the Markdown behind, and `import.meta.url` then points
 * at `dist/`.
 *
 * So: try the library loader first, and fall back to reading a `prompts/`
 * directory copied next to the bundle by `scripts/build.mjs`. The result is
 * passed to `createMasterSession({prompts})`, which is the escape hatch the
 * library documents for exactly this case.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ThreadPhaseSchema } from "@nexestra/core";
import { loadPromptSet, type MasterPromptSet } from "@nexestra/master";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where the bundle keeps its copy; see `apps/server/scripts/build.mjs`. */
export const BUNDLED_PROMPT_DIRECTORIES = [
  path.resolve(here, "prompts"),
  path.resolve(here, "../prompts"),
];

let cached: MasterPromptSet | null = null;

export function loadServerPromptSet(): MasterPromptSet {
  if (cached) return cached;
  try {
    cached = loadPromptSet();
    return cached;
  } catch {
    cached = readFrom(BUNDLED_PROMPT_DIRECTORIES);
    return cached;
  }
}

function readFrom(candidates: readonly string[]): MasterPromptSet {
  const directory = candidates.find((candidate) => existsSync(path.join(candidate, "base.md")));
  if (!directory) {
    throw new Error(
      `cannot find the Master prompts; looked in ${candidates.join(", ")}. ` +
        "Run `pnpm --filter @nexestra/server build`, which copies them into dist/prompts.",
    );
  }
  const read = (name: string) => readFileSync(path.join(directory, `${name}.md`), "utf8").trim();
  const phases = ThreadPhaseSchema.options.map((phase) => [phase, read(phase)] as const);
  return { base: read("base"), ...Object.fromEntries(phases) } as MasterPromptSet;
}
