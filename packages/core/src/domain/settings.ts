import { z } from "zod";
import { HarnessIdSchema, SandboxLevelSchema } from "./common.js";

/**
 * Machine-wide defaults edited from the Settings surface and stored in the
 * `settings` table (one JSON row). A workspace may still override any of these
 * through `WorkspaceSettings`.
 */
export const AppSettingsSchema = z.object({
  defaultHarness: HarnessIdSchema.default("codex"),
  defaultModel: z.string().default("gpt-5.1-codex"),
  /** Soft budget in USD applied to new threads. */
  budgetUSD: z.number().nonnegative().default(20),
  /** How many harness runs may execute in parallel (PLAN.md §6). */
  concurrency: z.number().int().min(1).max(8).default(2),
  defaultSandbox: SandboxLevelSchema.default("workspace-write"),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = AppSettingsSchema.parse({});
