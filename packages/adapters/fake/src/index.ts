/**
 * `@nexestra/adapter-fake` — deterministic `HarnessAdapter` test support.
 *
 * Two entry points, one implementation:
 *
 * - `createFakeAdapter(options)` — scenario driven. Use this. It plays
 *   `success`, `retryable_failure_then_success`, `fatal_failure`,
 *   `permission_request`, `slow`, `review_with_findings` or `review_clean`,
 *   writes real files into the worktree, paces its events, reports usage with
 *   a cost, and answers `control()`.
 * - `createFakeHarnessAdapter(options)` — script driven, for a unit test that
 *   wants to spell out the exact events a run emits.
 *
 * Production does not import or register this package. See `docs/testing.md`.
 */
export type { CreateFakeAdapterOptions } from "./adapter.js";
export {
  createFakeAdapter,
  DEFAULT_FAKE_DELAY_MS,
  DEFAULT_FAKE_SLOW_MS,
  FAKE_HARNESS_MODEL,
  FAKE_HARNESS_VERSION,
  FAKE_SANDBOX_MODES,
  resolveFiles,
  resolveScenario,
} from "./adapter.js";
export type { FakeReviewFinding, FakeScenario, ScenarioConfig } from "./scenarios.js";
export {
  DEFAULT_REVIEW_FINDINGS,
  defaultScenarioFor,
  FAKE_INPUT_USD_PER_MTOK,
  FAKE_OUTPUT_USD_PER_MTOK,
  FAKE_SCENARIOS,
  fakeCostUSD,
  fileContentFor,
  filesFromInstructions,
  isFakeScenario,
  scenarioFromInstructions,
  scenarioScript,
  sessionRefFor,
  usageEvent,
} from "./scenarios.js";
export type {
  FakeAdapterCall,
  FakeAdapterOptions,
  FakeHarnessAdapter,
  FakeRunContext,
  FakeRunScript,
  FakeStreamContext,
  ScriptedFakeAdapterOptions,
} from "./scripted.js";
export {
  createFakeHarnessAdapter,
  fatalFailure,
  resetFakeRunIds,
  retryableFailure,
  reviewFindings,
  writesFiles,
} from "./scripted.js";
