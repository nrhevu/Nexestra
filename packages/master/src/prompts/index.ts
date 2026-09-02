/**
 * Prompt loading.
 *
 * The prompts live as Markdown next to the code and are read at run time, so
 * they can be edited and diffed like prose rather than escaped into a string
 * literal. They are read once per process and cached: the system prefix has to
 * stay byte-identical across turns or prompt caching stops paying.
 *
 * A caller that cannot reach the filesystem (a bundled server build) can hand
 * `createMasterSession` a `prompts` override instead.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ThreadPhase, ThreadPhaseSchema } from "@nexestra/core";

export type MasterPromptSet = Readonly<Record<ThreadPhase, string>> & { readonly base: string };

const PROMPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

let cached: MasterPromptSet | null = null;

function read(name: string): string {
  return readFileSync(path.join(PROMPT_DIRECTORY, `${name}.md`), "utf8").trim();
}

/** Read every phase prompt from disk (cached for the life of the process). */
export function loadPromptSet(): MasterPromptSet {
  if (cached) return cached;
  const phases = ThreadPhaseSchema.options;
  const entries = phases.map((phase) => [phase, read(phase)] as const);
  cached = { base: read("base"), ...Object.fromEntries(entries) } as MasterPromptSet;
  return cached;
}

/** The full, cacheable system prompt for one phase. */
export function systemPromptFor(phase: ThreadPhase, prompts: MasterPromptSet): string {
  return `${prompts.base}\n\n${prompts[phase]}`;
}
