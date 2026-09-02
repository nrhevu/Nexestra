import { z } from "zod";
import {
  HarnessIdSchema,
  IdSchema,
  ReasoningLevelSchema,
  SandboxLevelSchema,
  TimestampSchema,
} from "./common.js";

/** Per-workspace defaults used when the Master dispatches work. */
export const WorkspaceSettingsSchema = z.object({
  defaultHarness: HarnessIdSchema.default("codex"),
  defaultModel: z.string().optional(),
  defaultReasoning: ReasoningLevelSchema.default("medium"),
  defaultSandbox: SandboxLevelSchema.default("workspace-write"),
  /** How many harness runs may execute in parallel (PLAN.md §6). */
  concurrency: z.number().int().min(1).max(8).default(2),
  /** Soft budget in USD; 80% raises an approval, 100% pauses the thread. */
  budgetUSD: z.number().nonnegative().default(20),
  /** Merge worktrees back automatically after verification passes. */
  autoMerge: z.boolean().default(false),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;

/** A workspace points at one repository / directory on the local machine. */
export const WorkspaceSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  /** Absolute path to the git repository root. */
  rootPath: z.string().min(1),
  /** Short label rendered in the 48px workspace rail. */
  shortLabel: z.string().min(1).max(3),
  defaultBranch: z.string().min(1).default("main"),
  settings: WorkspaceSettingsSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
