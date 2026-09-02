/**
 * The orchestrator's public contracts (PLAN.md §6).
 *
 * Two seams keep this package a library rather than a service:
 *
 * - `MasterBridge` is everything the loop needs *from* the Master — replanning
 *   and notifications. `apps/server` implements it on top of a `MasterSession`.
 * - `ExecutionHost` is everything the Master needs *from* the loop. It is
 *   deliberately structurally identical to the execution half of
 *   `MasterHost` (`docs/master.md` §4), so the server's host object can
 *   delegate straight to it without this package depending on
 *   `@nexestra/master`.
 */
import type {
  Approval,
  Artifact,
  HarnessId,
  ReasoningLevel,
  RunControl,
  RunKind,
  SandboxLevel,
  TaskStatus,
} from "@nexestra/core";

/* -------------------------------------------------------------- execution */

/** Harness overrides a caller may push onto one dispatch. */
export interface DispatchHarnessConfig {
  model?: string;
  reasoning?: ReasoningLevel;
  sandbox?: SandboxLevel;
  tools?: string[];
  skills?: string[];
  timeoutMs?: number;
  budgetUSD?: number;
}

export interface DispatchTaskInput {
  taskId: string;
  kind?: RunKind;
  /** Appended to the composed instructions, below the task description. */
  instructions?: string;
  harness?: HarnessId;
  harnessConfig?: DispatchHarnessConfig;
}

export interface DispatchTaskResult {
  readonly runId: string;
  readonly taskId: string;
  readonly harness: HarnessId;
  readonly kind: RunKind;
  readonly worktreePath?: string;
}

export interface ReadRunEventsInput {
  runId: string;
  sinceSeq?: number;
  limit?: number;
  /** Filter to these `HarnessEvent` types. */
  types?: string[];
}

export interface RunEventSummary {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}

export interface ReadRunEventsResult {
  readonly runId: string;
  readonly events: readonly RunEventSummary[];
  readonly nextSeq: number;
  readonly truncated: boolean;
}

export interface ReadArtifactInput {
  artifactId: string;
  maxBytes?: number;
}

export interface ReadArtifactResult {
  readonly artifact: Pick<Artifact, "id" | "kind" | "title">;
  readonly content: string;
  readonly truncated: boolean;
}

export interface ControlRunInput {
  runId: string;
  action: "pause" | "resume" | "cancel" | "steer";
  message?: string;
}

export interface ControlRunResult {
  readonly ok: boolean;
  readonly note?: string;
}

export interface VerificationOutcome {
  readonly criterionId: string;
  readonly passed: boolean;
  readonly evidenceArtifactId?: string;
  readonly exitCode?: number;
  readonly output?: string;
}

export interface RunVerificationResult {
  readonly taskId: string;
  readonly outcomes: readonly VerificationOutcome[];
}

export interface MarkCriterionInput {
  criterionId: string;
  passed: boolean;
  evidenceArtifactId?: string;
  note?: string;
}

export interface MarkCriterionResult {
  readonly criterionId: string;
  readonly satisfied: boolean;
}

/**
 * The execution half of `MasterHost`. The server's host object implements the
 * read tools itself and forwards these six straight to the orchestrator.
 */
export interface ExecutionHost {
  dispatchTask(input: DispatchTaskInput): Promise<DispatchTaskResult>;
  readRunEvents(input: ReadRunEventsInput): Promise<ReadRunEventsResult>;
  readArtifact(input: ReadArtifactInput): Promise<ReadArtifactResult>;
  controlRun(input: ControlRunInput): Promise<ControlRunResult>;
  runVerification(input: {
    taskId: string;
    criterionIds?: string[];
  }): Promise<RunVerificationResult>;
  markCriterion(input: MarkCriterionInput): Promise<MarkCriterionResult>;
}

/* ------------------------------------------------------------------ review */

/** Normalised finding, shaped like the Codex review schema. */
export interface ReviewFinding {
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  file: string | null;
  line: number | null;
  body: string;
}

/** Severities that send a task back to `execute` (PLAN.md §6). */
export const BLOCKING_REVIEW_SEVERITIES: readonly ReviewFinding["severity"][] = [
  "critical",
  "high",
];

/* ------------------------------------------------------------ master seam */

/** Everything the Master is told about a failed task, so it can replan. */
export interface ReplanEvidence {
  readonly threadId: string;
  readonly taskId: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** Every run this task produced, newest last. */
  readonly runIds: readonly string[];
  /** Artifacts recorded for those runs (diff, log, review, evidence). */
  readonly artifactIds: readonly string[];
  readonly lastError?: string;
  readonly reviewFindings?: readonly ReviewFinding[];
  readonly verification?: readonly VerificationOutcome[];
}

/** Why the loop stopped touching a thread. */
export type ThreadOutcome =
  | "completed"
  | "failed"
  | "blocked"
  | "paused"
  | "cancelled"
  | "budget_exceeded";

/**
 * Notifications pushed at the Master. The server maps the interesting ones
 * onto `MasterSession.applyTrigger()` — the orchestrator never writes
 * `Thread.phase` itself, because the phase machine belongs to the Master.
 */
export type OrchestratorEvent =
  | { type: "thread_started"; threadId: string }
  | { type: "thread_idle"; threadId: string; outcome: ThreadOutcome }
  | { type: "task_status"; threadId: string; taskId: string; from: TaskStatus; to: TaskStatus }
  | {
      type: "run_started";
      threadId: string;
      taskId: string;
      runId: string;
      kind: RunKind;
      harness: HarnessId;
      attempt: number;
    }
  | {
      type: "run_ended";
      threadId: string;
      taskId: string;
      runId: string;
      kind: RunKind;
      ok: boolean;
      exitCode?: number;
      error?: string;
      retryable?: boolean;
    }
  | { type: "run_retrying"; threadId: string; taskId: string; attempt: number; reason: string }
  | {
      type: "review_findings";
      threadId: string;
      taskId: string;
      runId: string;
      blocking: number;
      findings: readonly ReviewFinding[];
    }
  | {
      type: "verification_completed";
      threadId: string;
      taskId: string;
      passed: boolean;
      outcomes: readonly VerificationOutcome[];
    }
  | { type: "approval_requested"; threadId: string; approval: Approval }
  | { type: "approval_resolved"; threadId: string; approval: Approval }
  | { type: "replan_requested"; threadId: string; taskId: string; reason: string }
  | { type: "budget_warning"; threadId: string; costUSD: number; budgetUSD: number }
  | { type: "budget_exceeded"; threadId: string; costUSD: number; budgetUSD: number }
  | {
      type: "merge";
      threadId: string;
      taskId: string;
      branch: string;
      into: string;
      result: "merged" | "pending_approval" | "conflict";
      detail?: string;
    }
  | { type: "error"; threadId: string; taskId?: string; message: string };

/**
 * What the loop needs from the Master. Implemented by `apps/server` on top of
 * a `MasterSession`; both methods may be async and both may reject — a
 * rejection is logged and never stalls the loop.
 */
export interface MasterBridge {
  /** A task exhausted its attempts, or a review/verification keeps failing. */
  requestReplan(taskId: string, reason: string, evidence: ReplanEvidence): void | Promise<void>;
  /** Progress the Master (and, through it, the UI) should know about. */
  notify(event: OrchestratorEvent): void | Promise<void>;
}

/** A `MasterBridge` that does nothing, for callers that have no Master yet. */
export const NOOP_MASTER_BRIDGE: MasterBridge = {
  requestReplan() {},
  notify() {},
};

/* ------------------------------------------------------------------ status */

export interface ActiveRunSummary {
  readonly runId: string;
  readonly taskId: string;
  readonly kind: RunKind;
  readonly harness: HarnessId;
  readonly startedAt: string;
}

/** Thread-level state of the loop itself, not of the Master's phase machine. */
export type ThreadRunState = "idle" | "running" | "paused" | "cancelled";

export interface OrchestratorStatus {
  readonly threadId: string;
  readonly workspaceId: string;
  readonly state: ThreadRunState;
  readonly tasks: Readonly<Record<TaskStatus, number>>;
  readonly totalTasks: number;
  readonly activeRuns: readonly ActiveRunSummary[];
  readonly pendingApprovals: number;
  readonly costUSD: number;
  readonly budgetUSD: number;
  /** `costUSD / budgetUSD`, or 0 when there is no budget. */
  readonly budgetRatio: number;
  readonly lastOutcome?: ThreadOutcome;
}

/** What `recover()` had to repair. */
export interface RecoverReport {
  readonly threadId: string;
  readonly interruptedRuns: readonly string[];
  readonly resetTasks: readonly string[];
  readonly removedWorktrees: readonly string[];
}

export type { RunControl };
