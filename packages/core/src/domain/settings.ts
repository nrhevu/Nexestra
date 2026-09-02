import { z } from "zod";
import { HarnessIdSchema, SandboxLevelSchema } from "./common.js";

/**
 * Machine-wide defaults edited from the Settings surface and stored in the
 * `settings` table (one JSON row). A workspace may still override any of these
 * through `WorkspaceSettings`.
 */
/**
 * `AppSettings.defaultModel` when the harness should pick for itself.
 *
 * An empty string is not "no answer" — it is the answer: do not pass `-m` (or
 * OpenCode's `--model`) at all, and let the harness use whatever it is
 * configured for. That has to be the default, because there is no single model
 * name that works on every account: a Codex CLI signed in with a ChatGPT
 * subscription rejects `gpt-5.1-codex` with a 400, while the same name is fine
 * on an API key. Nexestra therefore ships with no opinion and prices the run
 * against whatever `discover()` says the harness actually defaults to.
 */
export const HARNESS_DEFAULT_MODEL = "";

export const AppSettingsSchema = z.object({
  defaultHarness: HarnessIdSchema.default("codex"),
  /** Empty means `HARNESS_DEFAULT_MODEL` — let the harness choose. */
  defaultModel: z.string().default(HARNESS_DEFAULT_MODEL),
  /** Soft budget in USD applied to new threads. */
  budgetUSD: z.number().nonnegative().default(20),
  /** How many harness runs may execute in parallel (PLAN.md §6). */
  concurrency: z.number().int().min(1).max(8).default(2),
  defaultSandbox: SandboxLevelSchema.default("workspace-write"),
  /** Ceiling on execute attempts per task before the Master is asked to replan. */
  maxAttempts: z.number().int().min(1).max(10).default(3),
  /** Land a verified task branch without asking. PLAN.md §10.2 says ask. */
  autoMerge: z.boolean().default(false),
  /**
   * Leave a task's git worktree on disk after its branch has landed.
   *
   * Off by default: a merged worktree is a copy of the repository nothing
   * reads any more, and `$NEXESTRA_HOME/worktrees` otherwise grows by one per
   * task forever. Turn it on to keep the harness's scratch state for a
   * post-mortem — the *branch* is kept either way, so nothing is lost by
   * leaving this off.
   */
  keepWorktrees: z.boolean().default(false),
  /**
   * Days of `master.*` stream rows to keep; older ones are pruned at startup.
   *
   * The transcript itself lives in `master_state` and in the thread's message
   * rows; these are the token-by-token deltas the UI needs only while a turn is
   * live, and a long-lived thread accumulates thousands of them. `0` keeps
   * everything.
   */
  streamRetentionDays: z.number().int().min(0).max(365).default(14),
  /**
   * Register the orchestrator's scripted `fake` adapter alongside the real
   * harnesses, so the whole loop can be driven without spending quota.
   * `NEXESTRA_FAKE_HARNESS=1` forces it on for one process.
   */
  enableFakeHarness: z.boolean().default(false),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = AppSettingsSchema.parse({});
