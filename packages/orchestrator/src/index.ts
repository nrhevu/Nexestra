/**
 * `@nexestra/orchestrator` — the dispatch / review / verify loop (PLAN.md §6).
 *
 * A library, not a service: it is handed a `NexestraStore`, a map of
 * `HarnessAdapter`s and a `MasterBridge`, and it drives the task DAG of a
 * thread to completion — worktree per task, cross-review by a second harness,
 * acceptance criteria executed as real commands, retry with the failure
 * attached, and a replan request when the attempts run out.
 *
 * ```ts
 * const orchestrator = createOrchestrator({
 *   store,
 *   adapters: { codex, opencode },
 *   master: bridge,
 *   config: { worktreeRoot: "/repo/.nexestra/worktrees" },
 * });
 * await orchestrator.recover(threadId);
 * await orchestrator.start(threadId);
 * ```
 *
 * See `docs/orchestrator.md` for the state machine and the server wiring.
 */

/* Approvals */
export {
  AbortedError,
  type ApprovalRequest,
  createApproval,
  evaluateGate,
  type GateDecision,
  requestApproval,
  waitForApproval,
} from "./approvals.js";
/* Artifacts */
export { type WriteArtifactInput, writeArtifact } from "./artifacts.js";
/* Money */
export {
  addUsage,
  type BudgetLevel,
  type BudgetState,
  budgetState,
  priceUsage,
  ZERO_USAGE,
} from "./budget.js";
/* Configuration */
export {
  BUDGET_WARNING_RATIO,
  type CreateOrchestratorOptions,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_ATTEMPTS,
  type Logger,
  type ModelPrice,
  noopLogger,
  type OrchestratorConfig,
  type PriceTable,
  type ResolvedConfig,
  resolveConfig,
} from "./config.js";
/* Engine internals, exported for tests and for a server that wants one thread */
export {
  type DispatchOptions,
  type EngineDeps,
  selectReadyTasks,
  ThreadEngine,
} from "./engine.js";
/* Test harness */
export {
  createFakeHarnessAdapter,
  type FakeAdapterCall,
  type FakeAdapterOptions,
  type FakeHarnessAdapter,
  type FakeRunContext,
  type FakeRunScript,
  fatalFailure,
  retryableFailure,
  reviewFindings,
  writesFiles,
} from "./fake-adapter.js";
/* Prompt composition */
export {
  buildExecuteInstructions,
  buildReviewInstructions,
  buildRunSpec,
  criteriaForTask,
  type FailureContext,
  type InstructionContext,
} from "./instructions.js";
/* The orchestrator itself */
export { createOrchestrator, type Orchestrator } from "./orchestrator.js";
/* Review normalisation */
export { blockingFindings, extractReview, type ReviewResult } from "./review.js";
/* Runs */
export { type ExecuteRunOptions, executeRun, type RunHooks, type RunOutcome } from "./runner.js";
/* Contracts */
export {
  type ActiveRunSummary,
  BLOCKING_REVIEW_SEVERITIES,
  type ControlRunInput,
  type ControlRunResult,
  type DispatchHarnessConfig,
  type DispatchTaskInput,
  type DispatchTaskResult,
  type ExecutionHost,
  type MarkCriterionInput,
  type MarkCriterionResult,
  type MasterBridge,
  NOOP_MASTER_BRIDGE,
  type OrchestratorEvent,
  type OrchestratorStatus,
  type ReadArtifactInput,
  type ReadArtifactResult,
  type ReadRunEventsInput,
  type ReadRunEventsResult,
  type RecoverReport,
  type ReplanEvidence,
  type ReviewFinding,
  type RunEventSummary,
  type RunVerificationResult,
  type ThreadOutcome,
  type ThreadRunState,
  type VerificationOutcome,
} from "./types.js";
/* Verification */
export {
  type CommandEvidence,
  renderEvidence,
  runVerificationCommand,
  summariseEvidence,
} from "./verification.js";
/* Git */
export {
  branchNameFor,
  type CommitResult,
  commitWorktree,
  ensureTaskWorktree,
  type MergeOutcome,
  type MergeResult,
  mergeTaskBranch,
  pruneStaleWorktrees,
  type TaskWorktree,
  worktreePathFor,
} from "./worktree.js";
