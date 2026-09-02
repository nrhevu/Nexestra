/**
 * `ExecutionHost` — the seam between the Master and the thing that actually
 * runs harnesses.
 *
 * `MasterHost` (from `@nexestra/master`) is one interface covering the whole
 * agent lifecycle. Everything up to and including planning is pure
 * bookkeeping over the store, so `ServerMasterHost` implements it directly.
 * Everything from `executing` onwards needs git worktrees, spawned processes
 * and a scheduler — the orchestrator (M4/M5). Rather than let the Master's
 * wiring wait on that package, the execution half is factored out here.
 *
 * `ServerMasterHost` delegates the six execution-phase callbacks to whatever
 * `ExecutionHost` it was constructed with, adding an `ExecutionContext` so the
 * implementation does not have to be per-thread. Until the orchestrator lands,
 * the server injects `createNotYetAvailableExecutionHost()`, which rejects
 * with a clear message; the Master session turns a rejection into a
 * `tool_result` with `is_error: true`, so the model reports the limitation to
 * the user instead of the turn crashing.
 *
 * Two guarantees the implementation can rely on:
 *
 * 1. `input.taskId` is a persisted `Task.id`. `ServerMasterHost` translates the
 *    model-authored plan ids (`t1`, `setup`, …) before delegating, and rejects
 *    an unknown id itself.
 * 2. `context.workspacePath` is the absolute, validated repository root of the
 *    thread's workspace.
 */
import type {
  ControlRunInput,
  DispatchTaskInput,
  DispatchTaskResult,
  MarkCriterionInput,
  MarkCriterionResult,
  ReadArtifactInput,
  ReadArtifactResult,
  ReadRunEventsInput,
  ReadRunEventsResult,
  RunVerificationInput,
  RunVerificationResult,
  TaskDispatchDefaults,
} from "@nexestra/master";

/** Which thread, in which workspace, on which checkout. */
export interface ExecutionContext {
  readonly workspaceId: string;
  readonly threadId: string;
  /** Absolute path of the workspace repository on this machine. */
  readonly workspacePath: string;
}

export interface ControlRunOutcome {
  readonly ok: boolean;
  readonly note?: string;
}

/**
 * The execution-phase half of `MasterHost`, made injectable.
 *
 * Every method may reject: the Master turns a rejection into a failed tool
 * result and keeps the turn alive, so an implementation should throw a
 * message a model can act on rather than swallow the failure.
 */
export interface ExecutionHost {
  /** Start a harness run for a task. */
  dispatchTask(input: DispatchTaskInput, context: ExecutionContext): Promise<DispatchTaskResult>;

  /** Normalised `HarnessEvent`s of a run, from `sinceSeq`. */
  readRunEvents(input: ReadRunEventsInput, context: ExecutionContext): Promise<ReadRunEventsResult>;

  /** Text of one artifact, truncated to `maxBytes`. */
  readArtifact(input: ReadArtifactInput, context: ExecutionContext): Promise<ReadArtifactResult>;

  /** Pause / resume / cancel / steer a live run. */
  controlRun(input: ControlRunInput, context: ExecutionContext): Promise<ControlRunOutcome>;

  /** Execute the acceptance criteria of a task and produce evidence. */
  runVerification(
    input: RunVerificationInput,
    context: ExecutionContext,
  ): Promise<RunVerificationResult>;

  /** Record a criterion as satisfied (or not) against its evidence. */
  markCriterion(input: MarkCriterionInput, context: ExecutionContext): Promise<MarkCriterionResult>;

  /** Harness / reasoning / sandbox defaults the planning prompt shows. */
  dispatchDefaults?(
    context: ExecutionContext,
  ): TaskDispatchDefaults | Promise<TaskDispatchDefaults>;
}

/** Raised by every method of `NotYetAvailableExecutionHost`. */
export class ExecutionNotAvailableError extends Error {
  constructor(readonly capability: string) {
    super(
      `${capability} is not available yet: Nexestra can plan work but cannot run it. ` +
        "The orchestrator and the harness adapters land in M4/M5. " +
        "Tell the user the plan is ready and that execution is not wired up yet, " +
        "then stop rather than retrying.",
    );
    this.name = "ExecutionNotAvailableError";
  }
}

/**
 * The M3 implementation: refuse, clearly, in a way the model can relay.
 *
 * It is deliberately not a silent no-op — a Master that believed a task had
 * been dispatched would go on to poll a run that does not exist.
 */
export function createNotYetAvailableExecutionHost(): ExecutionHost {
  const refuse = (capability: string) => Promise.reject(new ExecutionNotAvailableError(capability));

  return {
    dispatchTask: () => refuse("Dispatching a task to a harness"),
    readRunEvents: () => refuse("Reading run events"),
    readArtifact: () => refuse("Reading artifacts"),
    controlRun: () => refuse("Controlling a run"),
    runVerification: () => refuse("Running verification"),
    markCriterion: () => refuse("Marking an acceptance criterion"),
  };
}
