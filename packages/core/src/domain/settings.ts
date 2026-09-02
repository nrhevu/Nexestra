import { z } from "zod";
import { HarnessIdSchema, SandboxLevelSchema } from "./common.js";

export const MasterProviderProtocolSchema = z.enum(["openai-responses", "anthropic-messages"]);
export type MasterProviderProtocol = z.infer<typeof MasterProviderProtocolSchema>;

const ProviderBaseUrlSchema = z.url().refine(
  (value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))
    );
  },
  { message: "provider URLs must use HTTPS, except for loopback HTTP endpoints" },
);

/**
 * A server-side model provider for the Master.
 *
 * Secrets are deliberately referenced by environment-variable name. They are
 * never persisted in SQLite or returned to the browser.
 */
export const MasterProviderSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "use lowercase letters, numbers, dashes or underscores"),
  name: z.string().min(1).max(80),
  protocol: MasterProviderProtocolSchema,
  baseUrl: ProviderBaseUrlSchema,
  model: z.string().min(1).max(160),
  apiKeyEnv: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/, "use an uppercase environment-variable name")
    .optional(),
  enabled: z.boolean().default(true),
});
export type MasterProvider = z.infer<typeof MasterProviderSchema>;

export const DEFAULT_MASTER_PROVIDERS: readonly MasterProvider[] =
  MasterProviderSchema.array().parse([
    {
      id: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      model: "chat-latest",
      apiKeyEnv: "OPENAI_API_KEY",
      enabled: true,
    },
    {
      id: "anthropic",
      name: "Anthropic",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      model: "claude-opus-5",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      enabled: true,
    },
  ]);

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
  /** Providers the Master may use. The active provider can be changed without a restart. */
  masterProviders: z
    .array(MasterProviderSchema)
    .max(20)
    .default([...DEFAULT_MASTER_PROVIDERS]),
  /** `null` selects the first enabled provider whose credential is available. */
  activeMasterProviderId: z.string().min(1).nullable().default(null),
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
  /** @deprecated Kept only so older settings rows still parse. Ignored by production. */
  enableFakeHarness: z.boolean().default(false),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = AppSettingsSchema.parse({});
