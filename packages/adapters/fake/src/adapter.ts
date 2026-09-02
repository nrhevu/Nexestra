/**
 * `createFakeAdapter()` — the harness you can run without a harness.
 *
 * It implements the whole `HarnessAdapter` contract (PLAN.md §5) on top of the
 * scripted core, but you drive it with a *scenario* rather than an event list:
 * `success`, `retryable_failure_then_success`, `fatal_failure`,
 * `permission_request`, `slow`, `review_with_findings`, `review_clean`.
 *
 * The scenario for a run comes from, in order: `options.scenario`,
 * `options.scenarioFor(spec)`, a marker in the run's instructions
 * (`[scenario: slow]`, or just the bare name), `options.defaultScenario`, and
 * finally the run kind — `review` runs default to `review_clean`, everything
 * else to `success`.
 *
 * `success` really does write the files the instructions name into `spec.cwd`,
 * so `git diff`, the Editor surface and the acceptance-criteria commands all
 * see a real change. That is the whole point: the loop under test should not
 * be able to tell that the harness was fake.
 */
import type { HarnessId, HarnessInfo, RunControl, RunSpec, SandboxLevel } from "@nexestra/core";
import {
  DEFAULT_REVIEW_FINDINGS,
  defaultScenarioFor,
  type FakeReviewFinding,
  type FakeScenario,
  fileContentFor,
  filesFromInstructions,
  type ScenarioConfig,
  scenarioFromInstructions,
  scenarioScript,
} from "./scenarios.js";
import {
  createFakeHarnessAdapter,
  type FakeHarnessAdapter,
  type FakeRunContext,
  type FakeRunScript,
  type ScriptedFakeAdapterOptions,
} from "./scripted.js";

/** Reported by `discover()`; the `fake` harness has no binary to version. */
export const FAKE_HARNESS_VERSION = "0.0.0-fake";
export const FAKE_HARNESS_MODEL = "fake-model";
export const FAKE_SANDBOX_MODES: readonly SandboxLevel[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

/** Default pacing: fast enough for a test, slow enough to look like streaming. */
export const DEFAULT_FAKE_DELAY_MS = 20;
export const DEFAULT_FAKE_SLOW_MS = 3000;

export interface CreateFakeAdapterOptions {
  /**
   * The harness id this fake answers to. `HarnessId` has no `fake` member —
   * the fake stands in for a real harness rather than being one — so it
   * impersonates `codex` unless told otherwise.
   */
  id?: HarnessId;
  /** Merged into `discover()`'s answer. */
  info?: Partial<HarnessInfo>;
  /** Control actions this fake claims to support. Default: all of them. */
  supports?: readonly RunControl["action"][];

  /** Force one scenario for every run, whatever the instructions say. */
  scenario?: FakeScenario;
  /** Pick the scenario per run. `undefined` falls through to the instructions. */
  scenarioFor?: (spec: RunSpec) => FakeScenario | undefined;
  /** Used when neither the caller nor the instructions chose one. */
  defaultScenario?: FakeScenario;

  /** Milliseconds between events. Default `DEFAULT_FAKE_DELAY_MS`. */
  delayMs?: number;
  /** Wall-clock duration of the `slow` scenario. Default `DEFAULT_FAKE_SLOW_MS`. */
  slowMs?: number;

  /** Override the files a successful run writes, keyed by worktree-relative path. */
  filesFor?: (spec: RunSpec) => Record<string, string> | undefined;
  /** The command a run reports having executed. */
  command?: string;
  /** Findings returned by `review_with_findings`. */
  findings?: readonly FakeReviewFinding[];

  /** Escape hatch: a raw script wins over the scenario for that run. */
  script?: ScriptedFakeAdapterOptions["script"];
}

/**
 * Build a `HarnessAdapter` that behaves like a harness without being one.
 *
 * ```ts
 * const fake = createFakeAdapter({ id: "codex", delayMs: 5 });
 * const orchestrator = createOrchestrator({ store, adapters: { codex: fake }, config });
 * ```
 */
export function createFakeAdapter(options: CreateFakeAdapterOptions = {}): FakeHarnessAdapter {
  const delayMs = options.delayMs ?? DEFAULT_FAKE_DELAY_MS;
  const slowMs = options.slowMs ?? DEFAULT_FAKE_SLOW_MS;
  const findings = options.findings ?? DEFAULT_REVIEW_FINDINGS;

  const script = (context: FakeRunContext): FakeRunScript | undefined => {
    const explicit = options.script?.(context);
    if (explicit) return Array.isArray(explicit) ? { events: explicit } : explicit;

    const scenario = resolveScenario(options, context.spec);
    const config: ScenarioConfig = {
      delayMs,
      slowMs,
      files: resolveFiles(options, context.spec),
      command: options.command ?? "pnpm test",
      findings,
    };
    return scenarioScript(scenario, context, config);
  };

  return createFakeHarnessAdapter({
    ...(options.id ? { id: options.id } : {}),
    ...(options.supports ? { supports: options.supports } : {}),
    script,
    info: {
      version: FAKE_HARNESS_VERSION,
      supportedVersionRange: FAKE_HARNESS_VERSION,
      models: [FAKE_HARNESS_MODEL],
      defaultModel: FAKE_HARNESS_MODEL,
      sandboxModes: [...FAKE_SANDBOX_MODES],
      authOk: true,
      binaryPath: "(built-in fake harness)",
      warnings: ["fake harness: scripted output, no model is called"],
      ...options.info,
    },
  });
}

/** The resolution order documented on `createFakeAdapter`. */
export function resolveScenario(options: CreateFakeAdapterOptions, spec: RunSpec): FakeScenario {
  return (
    options.scenario ??
    options.scenarioFor?.(spec) ??
    scenarioFromInstructions(spec.instructions) ??
    options.defaultScenario ??
    defaultScenarioFor(spec.kind)
  );
}

/**
 * Which files a successful run writes.
 *
 * The instructions are the source of truth — a Master-written task names the
 * files it wants in backticks — and a run that names none still writes one
 * scratch file, so that `git diff` is never empty and the Editor surface has
 * something to show.
 */
export function resolveFiles(
  options: CreateFakeAdapterOptions,
  spec: RunSpec,
): Record<string, string> {
  const override = options.filesFor?.(spec);
  if (override) return override;

  const paths = filesFromInstructions(spec.instructions);
  const resolved = paths.length > 0 ? paths : [fallbackPath(spec.taskId)];

  const files: Record<string, string> = {};
  for (const file of resolved) files[file] = fileContentFor(file, spec.taskId);
  return files;
}

function fallbackPath(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9_-]/g, "_") || "task";
  return `nexestra-fake/${safe}.md`;
}
