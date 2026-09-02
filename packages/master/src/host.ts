/**
 * `MasterHost` — everything the Master needs from the outside world.
 *
 * The Master is a pure conversation engine: it decides *what* should happen
 * and validates the request, but every side effect (spawning a harness,
 * writing a memory node, creating an approval, running a verification) is
 * delegated to the host. `apps/server` implements this against the event
 * store and the orchestrator in a later milestone; `FakeHost` implements it
 * in memory so the whole loop is testable without a repo, a harness or a key.
 *
 * Every callback may return a rejected promise: the session turns that into a
 * `tool_result` with `is_error: true` and lets the model recover, rather than
 * aborting the turn.
 */
import type {
  Artifact,
  HarnessId,
  Memory,
  ReasoningLevel,
  RunKind,
  SandboxLevel,
  Spec,
  ThreadPhase,
} from "@nexestra/core";
import type { MasterPlanProposal } from "./plan.js";
import type {
  ControlRunInput,
  DispatchTaskInput,
  MarkCriterionInput,
  ReadArtifactInput,
  ReadRunEventsInput,
  ReadWorkspaceInput,
  RecordMemoryInput,
  RequestApprovalInput,
  RunVerificationInput,
  SearchCodeInput,
  SummarizeInput,
} from "./tools/schemas.js";

/* ---------------------------------------------------------------- read side */

export interface WorkspaceEntry {
  readonly path: string;
  readonly kind: "file" | "dir";
  /** Byte size for files. */
  readonly size?: number;
}

export interface WorkspaceManifest {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface ReadWorkspaceResult {
  readonly root: string;
  readonly entries: readonly WorkspaceEntry[];
  readonly manifests: readonly WorkspaceManifest[];
  /** Set when the walk stopped early (entry cap or depth cap). */
  readonly truncated: boolean;
}

export interface SearchCodeMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface SearchCodeResult {
  readonly matches: readonly SearchCodeMatch[];
  readonly truncated: boolean;
  /** `"ripgrep"` when rg was available, `"walk"` for the JS fallback. */
  readonly engine: "ripgrep" | "walk";
}

/* --------------------------------------------------------------- write side */

export interface ApprovalRequestResult {
  readonly approvalId: string;
  /** `pending` suspends the turn; anything else resolves the tool call now. */
  readonly status: "pending" | "approved" | "rejected";
  readonly note?: string;
}

export interface DispatchTaskResult {
  readonly runId: string;
  readonly taskId: string;
  readonly harness: HarnessId;
  readonly kind: RunKind;
  readonly worktreePath?: string;
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

export interface ReadArtifactResult {
  readonly artifact: Pick<Artifact, "id" | "kind" | "title">;
  readonly content: string;
  readonly truncated: boolean;
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

export interface MarkCriterionResult {
  readonly criterionId: string;
  readonly satisfied: boolean;
}

export interface TaskDispatchDefaults {
  readonly harness: HarnessId;
  readonly model?: string;
  readonly reasoning: ReasoningLevel;
  readonly sandbox: SandboxLevel;
}

/**
 * Callbacks the orchestrator / server must implement.
 *
 * The read tools (`readWorkspace`, `searchCode`) are on the host too rather
 * than reaching for `node:fs` directly, so a session can be pointed at a fake
 * tree, a remote workspace, or a permission-checked view of a real one.
 * `createFsWorkspaceReader()` supplies the real filesystem implementation.
 */
export interface MasterHost {
  readWorkspace(input: ReadWorkspaceInput): Promise<ReadWorkspaceResult>;
  searchCode(input: SearchCodeInput): Promise<SearchCodeResult>;

  recordMemory(input: RecordMemoryInput): Promise<Memory>;
  requestApproval(input: RequestApprovalInput): Promise<ApprovalRequestResult>;

  dispatchTask(input: DispatchTaskInput): Promise<DispatchTaskResult>;
  readRunEvents(input: ReadRunEventsInput): Promise<ReadRunEventsResult>;
  readArtifact(input: ReadArtifactInput): Promise<ReadArtifactResult>;
  controlRun(input: ControlRunInput): Promise<{ readonly ok: boolean; readonly note?: string }>;

  runVerification(input: RunVerificationInput): Promise<RunVerificationResult>;
  markCriterion(input: MarkCriterionInput): Promise<MarkCriterionResult>;

  summarize(input: SummarizeInput): Promise<{ readonly ok: boolean }>;

  /** Defaults the planning prompt shows the model. */
  dispatchDefaults?(): TaskDispatchDefaults | Promise<TaskDispatchDefaults>;

  /* Notifications — the session tells the host what it decided. */
  onSpecUpdated?(spec: Spec): void | Promise<void>;
  onPlanProposed?(plan: MasterPlanProposal): void | Promise<void>;
  onPhaseChanged?(from: ThreadPhase, to: ThreadPhase, reason: string): void | Promise<void>;
}
