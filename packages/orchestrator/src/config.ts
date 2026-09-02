/**
 * Configuration for `createOrchestrator()`.
 *
 * Every knob has a default except `worktreeRoot`, which has to be a real
 * directory on the machine the harnesses run on.
 */
import type { HarnessAdapter, HarnessId } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import type { MasterBridge } from "./types.js";

export interface Logger {
  debug(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export const noopLogger: Logger = {
  debug() {},
  warn() {},
  error() {},
};

/** Per-model token prices in USD per million tokens. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Defaults to 10% of `inputPerMTok`, the usual cache-read discount. */
  cachedInputPerMTok?: number;
}

/**
 * Prices used when a harness reports token counts but no money — which is
 * every Codex run (`docs/harness-protocols.md` §1.6). An unknown model costs
 * zero rather than a guess, so a wrong number can never pause a thread.
 */
export type PriceTable = Record<string, ModelPrice>;

export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Fraction of the budget at which a `spend` approval is raised (PLAN.md §4.2). */
export const BUDGET_WARNING_RATIO = 0.8;

export interface OrchestratorConfig {
  /** How many task pipelines may run at once, per thread. Default 2. */
  concurrency?: number;
  /** Ceiling on execute attempts per task; `Task.maxAttempts` may be lower. Default 3. */
  maxAttempts?: number;
  /** Run a cross-review pass after a successful execute. Default true. */
  reviewEnabled?: boolean;
  /** Run the acceptance criteria of each task after review. Default true. */
  verifyEnabled?: boolean;
  /** Merge the task branch into the thread's base branch without asking. Default false. */
  autoMerge?: boolean;
  /** Overrides `Thread.budgetUSD` when set. */
  budgetUSD?: number;
  priceTable?: PriceTable;
  /** Worktrees live at `<worktreeRoot>/<threadId>/<taskId>`. */
  worktreeRoot: string;

  /* ------------------------------------------------------------- optional */

  /** Fallback `RunSpec.timeoutMs` when the task's harness config has none. */
  runTimeoutMs?: number;
  /** Wall clock a single verification command gets. Default 600000. */
  verificationTimeoutMs?: number;
  /** Cap on a single artifact's bytes. Default 1 MiB. */
  maxArtifactBytes?: number;
  /** Branch every task branch is created from and merged into. Default: the workspace's. */
  baseBranch?: string;
  /** MCP servers a run may use without an Approval. Default: none. */
  allowedMcpServers?: readonly string[];
  /** Harness tools a run may request without an Approval. Default: all. */
  allowedTools?: readonly string[];
  /** Environment overlaid on verification commands. */
  env?: Record<string, string>;
  /** Identity used for the commit the orchestrator makes in a worktree. */
  commitIdentity?: { name: string; email: string };
  /** Injectable clock, for deterministic tests. */
  now?: () => string;
  logger?: Logger;
}

export interface ResolvedConfig {
  concurrency: number;
  maxAttempts: number;
  reviewEnabled: boolean;
  verifyEnabled: boolean;
  autoMerge: boolean;
  budgetUSD: number | undefined;
  priceTable: PriceTable;
  worktreeRoot: string;
  runTimeoutMs: number;
  verificationTimeoutMs: number;
  maxArtifactBytes: number;
  baseBranch: string | undefined;
  allowedMcpServers: readonly string[];
  allowedTools: readonly string[] | undefined;
  env: Record<string, string>;
  commitIdentity: { name: string; email: string };
  now: () => string;
  logger: Logger;
}

export interface CreateOrchestratorOptions {
  store: NexestraStore;
  adapters: Partial<Record<HarnessId, HarnessAdapter>>;
  master?: MasterBridge;
  config: OrchestratorConfig;
}

export function resolveConfig(config: OrchestratorConfig): ResolvedConfig {
  if (!config.worktreeRoot || config.worktreeRoot.trim().length === 0) {
    throw new TypeError("OrchestratorConfig.worktreeRoot is required");
  }
  return {
    concurrency: Math.max(1, config.concurrency ?? DEFAULT_CONCURRENCY),
    maxAttempts: Math.max(1, config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    reviewEnabled: config.reviewEnabled ?? true,
    verifyEnabled: config.verifyEnabled ?? true,
    autoMerge: config.autoMerge ?? false,
    budgetUSD: config.budgetUSD,
    priceTable: config.priceTable ?? {},
    worktreeRoot: config.worktreeRoot,
    runTimeoutMs: config.runTimeoutMs ?? 900_000,
    verificationTimeoutMs: config.verificationTimeoutMs ?? 600_000,
    maxArtifactBytes: config.maxArtifactBytes ?? 1024 * 1024,
    baseBranch: config.baseBranch,
    allowedMcpServers: config.allowedMcpServers ?? [],
    allowedTools: config.allowedTools,
    env: config.env ?? {},
    commitIdentity: config.commitIdentity ?? { name: "nexestra", email: "nexestra@local" },
    now: config.now ?? (() => new Date().toISOString()),
    logger: config.logger ?? noopLogger,
  };
}
