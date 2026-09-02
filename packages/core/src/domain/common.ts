import { z } from "zod";

/** Every entity id is an opaque, human readable string (e.g. `task_1a2b`). */
export const IdSchema = z.string().min(1);
export type Id = z.infer<typeof IdSchema>;

/** ISO-8601 timestamp with timezone, e.g. `2026-09-01T09:00:00.000Z`. */
export const TimestampSchema = z.iso.datetime();
export type Timestamp = z.infer<typeof TimestampSchema>;

/** Free-form JSON payload (event payloads, tool inputs/outputs, structured outputs). */
export const JsonValueSchema: z.ZodType<unknown> = z.unknown();

/** JSON Schema document handed to a harness for structured output. */
export const JsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchemaSchema>;

/** Fields shared by every persisted entity (PLAN.md §3). */
export const EntityBaseSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type EntityBase = z.infer<typeof EntityBaseSchema>;

/**
 * Harnesses Nexestra can drive. `acp` is the generic fallback (PLAN.md §1.7);
 * `fake` is the scripted adapter the orchestrator ships, selectable from the
 * settings so the whole loop can be exercised without spending harness quota.
 */
export const HarnessIdSchema = z.enum(["codex", "opencode", "acp", "fake"]);
export type HarnessId = z.infer<typeof HarnessIdSchema>;

/** Sandbox level requested for a harness run (PLAN.md §5). */
export const SandboxLevelSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
export type SandboxLevel = z.infer<typeof SandboxLevelSchema>;

/** Reasoning effort mapped onto each harness' own vocabulary. */
export const ReasoningLevelSchema = z.enum(["low", "medium", "high", "xhigh"]);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

/** Why a run was dispatched (PLAN.md §3 / §6). */
export const RunKindSchema = z.enum(["execute", "review", "verify"]);
export type RunKind = z.infer<typeof RunKindSchema>;

/** Reference to an MCP server made available to a harness run. */
export const McpServerRefSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(["stdio", "http"]).default("stdio"),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
});
export type McpServerRef = z.infer<typeof McpServerRefSchema>;

/** Token / money accounting reported by a harness. */
export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  costUSD: z.number().nonnegative().default(0),
});
export type Usage = z.infer<typeof UsageSchema>;
