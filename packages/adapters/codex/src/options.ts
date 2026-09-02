import type { ReasoningLevel, SandboxLevel } from "@nexestra/core";
import type { CodexUsage } from "./types.js";

/** The Codex CLI version this adapter's fixtures and contract tests were recorded against. */
export const TESTED_CODEX_VERSION = "0.148.0";

/** Inclusive lower / exclusive upper bound of the versions we believe the parser handles. */
export const MIN_CODEX_VERSION = "0.140.0";
export const MAX_CODEX_VERSION_EXCLUSIVE = "0.150.0";

/** Human readable form of the range, surfaced as `HarnessInfo.supportedVersionRange`. */
export const SUPPORTED_CODEX_RANGE = `>=${MIN_CODEX_VERSION} <${MAX_CODEX_VERSION_EXCLUSIVE}`;

/** `codex exec -s <mode>` accepts exactly these (`codex exec --help`, 0.148.0). */
export const CODEX_SANDBOX_MODES: readonly SandboxLevel[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

/**
 * `model_reasoning_effort` values accepted by Codex (the `ModelReasoningEffort`
 * union in `@openai/codex-sdk`). Codex accepts an invalid value *silently*, so
 * the adapter validates client-side before spawning.
 */
export const CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

/** `RunSpec.reasoning` (4 levels) → Codex `model_reasoning_effort` (8 levels). */
export const REASONING_TO_CODEX_EFFORT: Record<ReasoningLevel, CodexReasoningEffort> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

/**
 * Codex has no `models list` command, so `discover()` cannot enumerate models.
 * This is a static hint for the Settings UI; override with `options.models`.
 */
export const KNOWN_CODEX_MODELS: readonly string[] = ["gpt-5.1-codex", "gpt-5.1-codex-mini"];

/** Directory (relative to the run cwd) that holds per-run scratch files. */
export const RUN_DIR_SEGMENTS = [".nexestra", "runs"] as const;

/** Pathspec used to keep adapter scratch files out of the computed diff. */
export const DIFF_EXCLUDE_PATHSPECS: readonly string[] = [":(exclude).nexestra"];

/** Benign stderr lines Codex prints on every piped run; never treated as failure. */
export const BENIGN_STDERR_PATTERNS: readonly RegExp[] = [
  /^Reading additional input from stdin\.\.\.$/i,
];

export interface CodexLogger {
  debug(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
}

export const noopLogger: CodexLogger = {
  debug() {},
  warn() {},
};

export interface CodexAdapterOptions {
  /** Absolute path to the `codex` binary. Skips PATH discovery when set. */
  binaryPath?: string;
  /** Extra directories searched after `PATH` (defaults include `~/.local/bin`). */
  extraSearchPaths?: readonly string[];
  /** Environment overlaid on `process.env` for every spawned Codex process. */
  env?: Record<string, string>;
  /** Model used when `RunSpec.model` is absent. */
  defaultModel?: string;
  /** Model list reported by `discover()` (Codex cannot enumerate them itself). */
  models?: readonly string[];
  /** Do not persist rollout files under `~/.codex/sessions` (adds `--ephemeral`). */
  ephemeral?: boolean;
  /** Adds `--ignore-user-config`; MCP servers must then be re-supplied per run. */
  ignoreUserConfig?: boolean;
  /** Extra `-c key=value` overrides appended to every run. */
  configOverrides?: Record<string, string>;
  /** Extra argv appended verbatim, after everything the adapter builds. */
  extraArgs?: readonly string[];
  /** Emit `file_changed.path` relative to the run cwd. Default `true`. */
  relativisePaths?: boolean;
  /** Compute a real `git diff` after the run and attach it to `final.structured.diff`. */
  computeDiff?: boolean;
  /** Ref the post-run diff is taken against. Default: `HEAD` (or the empty tree). */
  diffBase?: string;
  /** Hard cap on the captured patch; longer diffs are truncated with a marker. */
  maxDiffBytes?: number;
  /** How long `SIGTERM` is given to the process group before `SIGKILL`. Default 5000. */
  killGraceMs?: number;
  /** Bytes of stderr retained for error messages. Default 8192. */
  stderrTailBytes?: number;
  /** Generates run ids in `prepare()`. Default: `run_<base36 time><random>`. */
  runIdFactory?: () => string;
  /** Codex reports token counts only; supply a pricer to fill `usage.costUSD`. */
  priceUsage?: (model: string | undefined, usage: CodexUsage) => number | undefined;
  logger?: CodexLogger;
}

export interface ResolvedCodexOptions {
  binaryPath: string | undefined;
  extraSearchPaths: readonly string[];
  env: Record<string, string>;
  defaultModel: string | undefined;
  models: readonly string[];
  ephemeral: boolean;
  ignoreUserConfig: boolean;
  configOverrides: Record<string, string>;
  extraArgs: readonly string[];
  relativisePaths: boolean;
  computeDiff: boolean;
  diffBase: string | undefined;
  maxDiffBytes: number;
  killGraceMs: number;
  stderrTailBytes: number;
  runIdFactory: () => string;
  priceUsage: ((model: string | undefined, usage: CodexUsage) => number | undefined) | undefined;
  logger: CodexLogger;
}

function defaultRunId(): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `run_${time}${random}`;
}

function defaultExtraSearchPaths(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return [];
  return [`${home}/.local/bin`, `${home}/.codex/bin`, `${home}/bin`];
}

export function resolveOptions(options: CodexAdapterOptions = {}): ResolvedCodexOptions {
  return {
    binaryPath: options.binaryPath,
    extraSearchPaths: options.extraSearchPaths ?? defaultExtraSearchPaths(),
    env: options.env ?? {},
    defaultModel: options.defaultModel,
    models: options.models ?? KNOWN_CODEX_MODELS,
    ephemeral: options.ephemeral ?? false,
    ignoreUserConfig: options.ignoreUserConfig ?? false,
    configOverrides: options.configOverrides ?? {},
    extraArgs: options.extraArgs ?? [],
    relativisePaths: options.relativisePaths ?? true,
    computeDiff: options.computeDiff ?? true,
    diffBase: options.diffBase,
    maxDiffBytes: options.maxDiffBytes ?? 1024 * 1024,
    killGraceMs: options.killGraceMs ?? 5000,
    stderrTailBytes: options.stderrTailBytes ?? 8192,
    runIdFactory: options.runIdFactory ?? defaultRunId,
    priceUsage: options.priceUsage,
    logger: options.logger ?? noopLogger,
  };
}
