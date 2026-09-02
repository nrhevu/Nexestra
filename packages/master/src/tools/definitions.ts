/**
 * The Master's tool catalogue: one entry per tool, phase-filtered at request
 * time so the model only ever sees the tools its current phase allows.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ThreadPhase } from "@nexestra/core";
import type { z } from "zod";
import { MASTER_TOOLS_BY_PHASE, type MasterToolName } from "../phase.js";
import { type JsonSchemaObject, toStrictJsonSchema } from "./json-schema.js";
import {
  AskUserInputSchema,
  ControlRunInputSchema,
  DispatchTaskInputSchema,
  MarkCriterionInputSchema,
  ProposePlanInputSchema,
  ReadArtifactInputSchema,
  ReadRunEventsInputSchema,
  ReadWorkspaceInputSchema,
  RecordMemoryInputSchema,
  ReplanInputSchema,
  RequestApprovalInputSchema,
  RunVerificationInputSchema,
  SearchCodeInputSchema,
  SummarizeInputSchema,
  UpdateSpecInputSchema,
} from "./schemas.js";

export interface MasterToolDefinition {
  readonly name: Exclude<MasterToolName, "web_search">;
  readonly description: string;
  readonly schema: z.ZodType;
  /** True when calling it hands control back to the user and ends the turn. */
  readonly suspends: boolean;
}

export const MASTER_TOOL_DEFINITIONS: readonly MasterToolDefinition[] = [
  {
    name: "read_workspace",
    description:
      "List the workspace's directory tree, with ignore rules applied, and optionally the text of the README and package manifests it finds. Use this before asking the user anything a file would already answer.",
    schema: ReadWorkspaceInputSchema,
    suspends: false,
  },
  {
    name: "search_code",
    description:
      "Search file contents across the workspace and return matching lines with their file and line number. Cheaper than reading trees when you already know what you are looking for.",
    schema: SearchCodeInputSchema,
    suspends: false,
  },
  {
    name: "ask_user",
    description:
      "Ask the user up to six questions in one batch and stop until they answer. Batch everything you need; a second round costs the user another wait. Offer concrete options whenever a small set of answers covers the realistic cases.",
    schema: AskUserInputSchema,
    suspends: true,
  },
  {
    name: "update_spec",
    description:
      "Apply a partial update to the thread's Spec. Only the fields you send change; acceptance criteria, open questions and decisions are upserted by id. The Spec is versioned, so write early and often rather than saving one big update for the end.",
    schema: UpdateSpecInputSchema,
    suspends: false,
  },
  {
    name: "record_memory",
    description:
      "Write one node into the workspace memory graph: a decision, a piece of research, an architectural fact, a lesson. Record things a future thread would regret not knowing, not a transcript of this one.",
    schema: RecordMemoryInputSchema,
    suspends: false,
  },
  {
    name: "request_approval",
    description:
      "Ask the user to approve something and stop until they decide: freezing the spec, escalating a sandbox, spending past budget, merging, or a destructive operation.",
    schema: RequestApprovalInputSchema,
    suspends: true,
  },
  {
    name: "propose_plan",
    description:
      "Propose the task DAG for the frozen spec. Every task needs at least one acceptance criterion id and a complete harnessConfig. The graph must be acyclic and every dependency must name a task in the same proposal.",
    schema: ProposePlanInputSchema,
    suspends: false,
  },
  {
    name: "replan",
    description:
      "Amend the current plan: add, replace or remove tasks, with a reason. Use it when a task failed repeatedly, the user changed the spec, or the work turned out to be shaped differently than planned.",
    schema: ReplanInputSchema,
    suspends: false,
  },
  {
    name: "dispatch_task",
    description:
      "Hand a ready task to a coding harness. The harness does the editing; you never edit files yourself.",
    schema: DispatchTaskInputSchema,
    suspends: false,
  },
  {
    name: "read_run_events",
    description:
      "Read the normalised event log of a run: assistant text, tool calls, file changes, commands, usage, errors.",
    schema: ReadRunEventsInputSchema,
    suspends: false,
  },
  {
    name: "read_artifact",
    description:
      "Read one artifact produced by a run: a diff, a test report, a log, a file output.",
    schema: ReadArtifactInputSchema,
    suspends: false,
  },
  {
    name: "control_run",
    description: "Pause, resume, cancel or steer a running harness session.",
    schema: ControlRunInputSchema,
    suspends: false,
  },
  {
    name: "run_verification",
    description:
      "Run the verification attached to a task's acceptance criteria inside its worktree. The result is evidence: exit codes and output, not a harness' claim that it worked.",
    schema: RunVerificationInputSchema,
    suspends: false,
  },
  {
    name: "mark_criterion",
    description:
      "Record the verdict for one acceptance criterion. Passing requires an evidence artifact id produced by run_verification.",
    schema: MarkCriterionInputSchema,
    suspends: false,
  },
  {
    name: "summarize",
    description:
      "Close out the thread: what was done, what was proven, what is left, and the lessons worth keeping.",
    schema: SummarizeInputSchema,
    suspends: false,
  },
];

const BY_NAME = new Map<string, MasterToolDefinition>(
  MASTER_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]),
);

export function getToolDefinition(name: string): MasterToolDefinition | undefined {
  return BY_NAME.get(name);
}

/** JSON Schemas are stable per process; caching keeps the tool list byte-identical for the prompt cache. */
const SCHEMA_CACHE = new Map<string, JsonSchemaObject>();

export function toolJsonSchema(tool: MasterToolDefinition): JsonSchemaObject {
  const cached = SCHEMA_CACHE.get(tool.name);
  if (cached) return cached;
  const schema = toStrictJsonSchema(tool.schema);
  SCHEMA_CACHE.set(tool.name, schema);
  return schema;
}

/** The server-side search tool, enabled in `intake` and `clarifying` only. */
export const WEB_SEARCH_TOOL: Anthropic.Beta.BetaWebSearchTool20260209 = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: 6,
};

export interface ToolListOptions {
  /** Attach a cache breakpoint to the last tool so the whole list is cached. */
  readonly cache?: boolean;
  /** Drop tools the host cannot service (e.g. no workspace root configured). */
  readonly exclude?: readonly string[];
}

/**
 * Build the `tools` array for a phase. Order is deterministic — it follows
 * `MASTER_TOOL_DEFINITIONS` — because any reordering would invalidate the
 * prompt cache on every request.
 */
export function toolsForPhase(
  phase: ThreadPhase,
  options: ToolListOptions = {},
): Anthropic.Beta.BetaToolUnion[] {
  const allowed = new Set<string>(MASTER_TOOLS_BY_PHASE[phase]);
  for (const name of options.exclude ?? []) allowed.delete(name);

  const tools: Anthropic.Beta.BetaToolUnion[] = [];
  if (allowed.has("web_search")) tools.push(WEB_SEARCH_TOOL);
  for (const tool of MASTER_TOOL_DEFINITIONS) {
    if (!allowed.has(tool.name)) continue;
    tools.push({
      type: "custom",
      name: tool.name,
      description: tool.description,
      input_schema: toolJsonSchema(tool) as Anthropic.Beta.BetaTool.InputSchema,
      strict: true,
    });
  }

  if (options.cache && tools.length > 0) {
    const last = tools[tools.length - 1];
    if (last) {
      (last as { cache_control?: Anthropic.Beta.BetaCacheControlEphemeral }).cache_control = {
        type: "ephemeral",
      };
    }
  }
  return tools;
}
