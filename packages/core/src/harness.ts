import { z } from "zod";
import {
  HarnessIdSchema,
  JsonSchemaSchema,
  McpServerRefSchema,
  ReasoningLevelSchema,
  RunKindSchema,
  SandboxLevelSchema,
  TimestampSchema,
} from "./domain/common.js";

/**
 * Normalised event stream every adapter must emit (PLAN.md §5). Adapters map
 * their native JSONL / SSE payloads onto this union and silently drop unknown
 * event kinds instead of crashing.
 */
export const HarnessEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), sessionRef: z.string() }),
  z.object({ type: z.literal("assistant_text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({
    type: z.literal("tool_call"),
    name: z.string(),
    input: z.unknown(),
    callId: z.string(),
  }),
  z.object({
    type: z.literal("tool_result"),
    callId: z.string(),
    output: z.unknown(),
    ok: z.boolean(),
  }),
  z.object({
    type: z.literal("file_changed"),
    path: z.string(),
    kind: z.enum(["add", "modify", "delete"]),
  }),
  z.object({
    type: z.literal("command"),
    cmd: z.string(),
    exitCode: z.number().int().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  }),
  z.object({
    type: z.literal("permission_request"),
    requestId: z.string(),
    description: z.string(),
    risk: z.enum(["low", "high"]),
  }),
  z.object({
    type: z.literal("usage"),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUSD: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("final"),
    message: z.string(),
    structured: z.unknown().optional(),
  }),
  z.object({ type: z.literal("error"), message: z.string(), retryable: z.boolean() }),
  z.object({ type: z.literal("ended"), exitCode: z.number().int() }),
]);
export type HarnessEvent = z.infer<typeof HarnessEventSchema>;

/** Discriminator values of `HarnessEvent`, reused by the event store. */
export const HarnessEventTypeSchema = z.enum([
  "started",
  "assistant_text",
  "reasoning",
  "tool_call",
  "tool_result",
  "file_changed",
  "command",
  "permission_request",
  "usage",
  "final",
  "error",
  "ended",
]);
export type HarnessEventType = z.infer<typeof HarnessEventTypeSchema>;

/** Everything an adapter needs to start one run (PLAN.md §5). */
export const RunSpecSchema = z.object({
  taskId: z.string().min(1),
  kind: RunKindSchema,
  /** Absolute path of the worktree the harness is allowed to touch. */
  cwd: z.string().min(1),
  instructions: z.string(),
  model: z.string().optional(),
  reasoning: ReasoningLevelSchema.optional(),
  sandbox: SandboxLevelSchema,
  tools: z.array(z.string()).optional(),
  mcpServers: z.array(McpServerRefSchema).optional(),
  skills: z.array(z.string()).optional(),
  outputSchema: JsonSchemaSchema.optional(),
  timeoutMs: z.number().int().positive(),
  budgetUSD: z.number().nonnegative().optional(),
});
export type RunSpec = z.infer<typeof RunSpecSchema>;

/** Result of `discover()`: is this harness usable on this machine? */
export const HarnessInfoSchema = z.object({
  id: HarnessIdSchema,
  available: z.boolean(),
  binaryPath: z.string().optional(),
  version: z.string().optional(),
  /** Version range this adapter was contract-tested against. */
  supportedVersionRange: z.string().optional(),
  models: z.array(z.string()).default([]),
  defaultModel: z.string().optional(),
  authOk: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
  detectedAt: TimestampSchema.optional(),
});
export type HarnessInfo = z.infer<typeof HarnessInfoSchema>;

/** Result of `prepare()`: the exact process that will be spawned. */
export const PreparedRunSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().min(1),
  harness: HarnessIdSchema,
  cwd: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /** File the instructions were written to, when the harness reads from disk. */
  instructionsPath: z.string().optional(),
  worktreePath: z.string().optional(),
  branch: z.string().optional(),
});
export type PreparedRun = z.infer<typeof PreparedRunSchema>;

/** Out-of-band control actions applied to a live run (PLAN.md §5). */
export const RunControlSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("cancel"), reason: z.string().optional() }),
  z.object({
    action: z.literal("answer_permission"),
    requestId: z.string(),
    approved: z.boolean(),
    note: z.string().optional(),
  }),
  z.object({ action: z.literal("steer"), message: z.string() }),
]);
export type RunControl = z.infer<typeof RunControlSchema>;

/**
 * The single contract every coding harness is normalised to. Implemented in
 * `@nexestra/adapter-codex` and `@nexestra/adapter-opencode` from M4 onwards.
 */
export interface HarnessAdapter {
  readonly id: HarnessEventAdapterId;
  /** Locate the binary, read its version, check auth. */
  discover(): Promise<HarnessInfo>;
  /** Build the command line, create the worktree, write instruction files. */
  prepare(spec: RunSpec): Promise<PreparedRun>;
  /** Spawn the harness and stream normalised events until it exits. */
  run(prepared: PreparedRun, signal: AbortSignal): AsyncIterable<HarnessEvent>;
  /** Pause / cancel / answer a permission prompt / steer a live run. */
  control(runId: string, action: RunControl): Promise<void>;
}

export type HarnessEventAdapterId = z.infer<typeof HarnessIdSchema>;
