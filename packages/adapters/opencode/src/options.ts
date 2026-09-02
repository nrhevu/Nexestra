import type { ReasoningLevel, SandboxLevel } from "@nexestra/core";
import type { OpenCodePermissionAction } from "./types.js";

/** The `opencode` version this adapter's fixtures and contract tests were recorded against. */
export const TESTED_OPENCODE_VERSION = "1.18.25";

/** Inclusive lower / exclusive upper bound of the versions we believe the parser handles. */
export const MIN_OPENCODE_VERSION = "1.18.0";
export const MAX_OPENCODE_VERSION_EXCLUSIVE = "2.0.0";

/** Human readable form of the range, surfaced as `HarnessInfo.supportedVersionRange`. */
export const SUPPORTED_OPENCODE_RANGE = `>=${MIN_OPENCODE_VERSION} <${MAX_OPENCODE_VERSION_EXCLUSIVE}`;

/**
 * OpenCode has no sandbox flag at all; the levels below are approximated with a
 * per-session `permission` ruleset plus tool gating (`permission.ts`).
 */
export const OPENCODE_SANDBOX_MODES: readonly SandboxLevel[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

/** Built-in tool ids (`GET /experimental/tool/ids`, 1.18.25). */
export const OPENCODE_TOOL_IDS = [
  "invalid",
  "question",
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "task",
  "webfetch",
  "todowrite",
  "websearch",
  "skill",
  "apply_patch",
] as const;

export type OpenCodeToolId = (typeof OPENCODE_TOOL_IDS)[number];

/** Tools that can mutate the worktree. Disabled outright below `workspace-write`. */
export const OPENCODE_WRITE_TOOL_IDS: readonly string[] = ["edit", "write", "apply_patch", "patch"];

/** Tools that reach the network. */
export const OPENCODE_NETWORK_TOOL_IDS: readonly string[] = ["webfetch", "websearch"];

/**
 * `RunSpec.reasoning` → the model `variant` OpenCode passes to the provider.
 *
 * Variants are provider-specific (`Model.variants` is an open map), so an
 * unknown variant is a silent no-op rather than an error. Override with
 * `options.variantFor`.
 */
export const REASONING_TO_OPENCODE_VARIANT: Record<ReasoningLevel, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

/** Directory (relative to the run cwd) that holds per-run scratch files. */
export const RUN_DIR_SEGMENTS = [".nexestra", "runs"] as const;

/** Pathspec used to keep adapter scratch files out of the computed diff. */
export const DIFF_EXCLUDE_PATHSPECS: readonly string[] = [":(exclude).nexestra"];

/** Agent used for `kind: "execute"` / `"verify"` runs when nothing else is set. */
export const DEFAULT_OPENCODE_AGENT = "build";

/** Agent used for `kind: "review"` runs — `plan` denies every edit tool. */
export const DEFAULT_OPENCODE_REVIEW_AGENT = "plan";

export interface OpenCodeLogger {
  debug(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
}

export const noopLogger: OpenCodeLogger = {
  debug() {},
  warn() {},
};

/** Token counts an OpenCode step reported, handed to `options.priceUsage`. */
export interface OpenCodeUsageTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of every `step-finish.cost`; `0` for subscription-billed providers. */
  costUSD: number;
  steps: number;
}

export interface OpenCodeAdapterOptions {
  /** Absolute path to the `opencode` binary. Skips PATH discovery when set. */
  binaryPath?: string;
  /** Extra directories searched after `PATH` (defaults include `~/.opencode/bin`). */
  extraSearchPaths?: readonly string[];
  /** Environment overlaid on `process.env` for every spawned server. */
  env?: Record<string, string>;
  /**
   * Attach to an already-running `opencode serve` instead of spawning one.
   * The URL is used for every workspace; nothing is started or disposed.
   */
  attachUrl?: string;
  /** `--pure` (skip external plugins) — keeps the event stream deterministic. Default `true`. */
  pure?: boolean;
  /** `--log-level`. Default `INFO`; `--print-logs` is always passed (the port line needs it). */
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  /** Extra argv appended to `opencode serve`. */
  extraServeArgs?: readonly string[];
  /** How long the server gets to print its port and answer `/global/health`. Default 30000. */
  startTimeoutMs?: number;
  /** Timeout applied to every ordinary HTTP request. Default 30000. */
  requestTimeoutMs?: number;
  /** SIGTERM → SIGKILL grace for the server's process group. Default 5000. */
  killGraceMs?: number;
  /**
   * How long the run keeps draining events after the session goes idle.
   * `message.updated` carrying the final cost / `structured` can trail the
   * `session.idle` event by a few milliseconds. Default 250.
   */
  idleSettleMs?: number;
  /** How long an abort waits for the session to report idle. Default 10000. */
  abortTimeoutMs?: number;
  /** First SSE reconnect delay; doubles up to `reconnectMaxDelayMs`. Default 250. */
  reconnectDelayMs?: number;
  /** Ceiling for the SSE reconnect backoff. Default 8000. */
  reconnectMaxDelayMs?: number;
  /** `provider/model` used when `RunSpec.model` is absent, e.g. `openai/gpt-5.4-mini`. */
  defaultModel?: string;
  /** Provider assumed when `RunSpec.model` carries no `provider/` prefix. */
  defaultProviderId?: string;
  /** Model list reported by `discover()`; otherwise read from `GET /provider`. */
  models?: readonly string[];
  /** Agent for `execute` / `verify` runs. Default `build`. */
  agent?: string;
  /** Agent for `review` runs. Default `plan`. */
  reviewAgent?: string;
  /** Override the `RunSpec.reasoning` → `variant` mapping. */
  variantFor?: (
    reasoning: ReasoningLevel | undefined,
    model: string | undefined,
  ) => string | undefined;
  /** Override the whole `sandbox` → `PermissionRuleset` mapping. */
  permissionRuleset?: (
    sandbox: SandboxLevel,
  ) => { permission: string; pattern: string; action: OpenCodePermissionAction }[];
  /** What `read-only` does with `bash`. `deny` is the safe default. */
  readOnlyBashAction?: OpenCodePermissionAction;
  /** Emit one `assistant_text` / `reasoning` per delta instead of per part. Default `false`. */
  streamDeltas?: boolean;
  /** Emit `file_changed.path` relative to the run cwd. Default `true`. */
  relativisePaths?: boolean;
  /** Compute a real `git diff` after the run and attach it to `final.structured.diff`. */
  computeDiff?: boolean;
  /** Ref the post-run diff is taken against. Default: `HEAD` (or the empty tree). */
  diffBase?: string;
  /** Hard cap on the captured patch; longer diffs are truncated with a marker. */
  maxDiffBytes?: number;
  /** Generates run ids in `prepare()`. Default: `run_<base36 time><random>`. */
  runIdFactory?: () => string;
  /**
   * Fallback pricer. OpenCode reports `cost` on every `step-finish`, but it is
   * `0` for subscription-billed providers; this fills the gap.
   */
  priceUsage?: (model: string | undefined, usage: OpenCodeUsageTotals) => number | undefined;
  /** Injected `fetch`, for tests. Defaults to the global one. */
  fetch?: typeof fetch;
  logger?: OpenCodeLogger;
}

export interface ResolvedOpenCodeOptions {
  binaryPath: string | undefined;
  extraSearchPaths: readonly string[];
  env: Record<string, string>;
  attachUrl: string | undefined;
  pure: boolean;
  logLevel: "DEBUG" | "INFO" | "WARN" | "ERROR";
  extraServeArgs: readonly string[];
  startTimeoutMs: number;
  requestTimeoutMs: number;
  killGraceMs: number;
  idleSettleMs: number;
  abortTimeoutMs: number;
  reconnectDelayMs: number;
  reconnectMaxDelayMs: number;
  defaultModel: string | undefined;
  defaultProviderId: string | undefined;
  models: readonly string[] | undefined;
  agent: string;
  reviewAgent: string;
  variantFor:
    | ((reasoning: ReasoningLevel | undefined, model: string | undefined) => string | undefined)
    | undefined;
  permissionRuleset:
    | ((
        sandbox: SandboxLevel,
      ) => { permission: string; pattern: string; action: OpenCodePermissionAction }[])
    | undefined;
  readOnlyBashAction: OpenCodePermissionAction;
  streamDeltas: boolean;
  relativisePaths: boolean;
  computeDiff: boolean;
  diffBase: string | undefined;
  maxDiffBytes: number;
  runIdFactory: () => string;
  priceUsage:
    | ((model: string | undefined, usage: OpenCodeUsageTotals) => number | undefined)
    | undefined;
  fetch: typeof fetch;
  logger: OpenCodeLogger;
}

function defaultRunId(): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `run_${time}${random}`;
}

function defaultExtraSearchPaths(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return [];
  return [`${home}/.opencode/bin`, `${home}/.local/bin`, `${home}/bin`];
}

export function resolveOptions(options: OpenCodeAdapterOptions = {}): ResolvedOpenCodeOptions {
  return {
    binaryPath: options.binaryPath,
    extraSearchPaths: options.extraSearchPaths ?? defaultExtraSearchPaths(),
    env: options.env ?? {},
    attachUrl: options.attachUrl ? stripTrailingSlash(options.attachUrl) : undefined,
    pure: options.pure ?? true,
    logLevel: options.logLevel ?? "INFO",
    extraServeArgs: options.extraServeArgs ?? [],
    startTimeoutMs: options.startTimeoutMs ?? 30_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    killGraceMs: options.killGraceMs ?? 5000,
    idleSettleMs: options.idleSettleMs ?? 250,
    abortTimeoutMs: options.abortTimeoutMs ?? 10_000,
    reconnectDelayMs: options.reconnectDelayMs ?? 250,
    reconnectMaxDelayMs: options.reconnectMaxDelayMs ?? 8000,
    defaultModel: options.defaultModel,
    defaultProviderId: options.defaultProviderId,
    models: options.models,
    agent: options.agent ?? DEFAULT_OPENCODE_AGENT,
    reviewAgent: options.reviewAgent ?? DEFAULT_OPENCODE_REVIEW_AGENT,
    variantFor: options.variantFor,
    permissionRuleset: options.permissionRuleset,
    readOnlyBashAction: options.readOnlyBashAction ?? "deny",
    streamDeltas: options.streamDeltas ?? false,
    relativisePaths: options.relativisePaths ?? true,
    computeDiff: options.computeDiff ?? true,
    diffBase: options.diffBase,
    maxDiffBytes: options.maxDiffBytes ?? 1024 * 1024,
    runIdFactory: options.runIdFactory ?? defaultRunId,
    priceUsage: options.priceUsage,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    logger: options.logger ?? noopLogger,
  };
}

export function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
