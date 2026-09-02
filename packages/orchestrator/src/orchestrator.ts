/**
 * `createOrchestrator()` — the public face of the loop.
 *
 * It owns one `ThreadEngine` per thread and exposes two surfaces:
 *
 * - the control API (`start`, `pause`, `resume`, `cancel`, `dispatch`,
 *   `controlRun`, `runVerification`, `recover`, `status`) that `apps/server`
 *   drives from REST routes and the UI;
 * - `host`, an `ExecutionHost` the Master's `MasterHost` delegates to.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessId } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import type { CreateOrchestratorOptions, ResolvedConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { type DispatchOptions, ThreadEngine } from "./engine.js";
import type {
  DispatchTaskInput,
  DispatchTaskResult,
  ExecutionHost,
  MarkCriterionInput,
  MarkCriterionResult,
  MasterBridge,
  OrchestratorStatus,
  ReadArtifactInput,
  ReadArtifactResult,
  ReadRunEventsInput,
  ReadRunEventsResult,
  RecoverReport,
  RunVerificationResult,
} from "./types.js";
import { NOOP_MASTER_BRIDGE } from "./types.js";

const DEFAULT_ARTIFACT_BYTES = 100_000;
const DEFAULT_EVENT_LIMIT = 200;

export interface Orchestrator {
  /** Begin (or resume) scheduling ready tasks for a thread. */
  start(threadId: string): Promise<OrchestratorStatus>;
  /** Stop dispatching new work; runs already in flight finish. */
  pause(threadId: string): Promise<OrchestratorStatus>;
  resume(threadId: string): Promise<OrchestratorStatus>;
  /** Abort every live run of a thread and stop scheduling. */
  cancel(threadId: string): Promise<OrchestratorStatus>;
  /** Start one task and resolve once its first run row exists. */
  dispatch(taskId: string, options?: DispatchOptions): Promise<DispatchTaskResult>;
  controlRun(
    runId: string,
    action: { action: "pause" | "resume" | "cancel" | "steer"; message?: string },
  ): Promise<{ ok: boolean; note?: string }>;
  runVerification(taskId: string, criterionIds?: string[]): Promise<RunVerificationResult>;
  /** Repair state left behind by a crash. Call once per thread at startup. */
  recover(threadId: string): Promise<RecoverReport>;
  status(threadId: string): OrchestratorStatus;
  /** Resolve once a thread has nothing left to do. */
  drain(threadId: string): Promise<void>;
  /** Cancel every thread and release the engines. */
  close(): Promise<void>;
  /** The six callbacks a `MasterHost` forwards to the orchestrator. */
  readonly host: ExecutionHost;
  readonly config: ResolvedConfig;
}

export function createOrchestrator(options: CreateOrchestratorOptions): Orchestrator {
  const config = resolveConfig(options.config);
  const store = options.store;
  const master: MasterBridge = options.master ?? NOOP_MASTER_BRIDGE;
  const engines = new Map<string, ThreadEngine>();

  const engineFor = (threadId: string): ThreadEngine => {
    let engine = engines.get(threadId);
    if (!engine) {
      if (!store.getThread(threadId)) throw new Error(`thread ${threadId} not found`);
      engine = new ThreadEngine(threadId, { store, adapters: options.adapters, master, config });
      engines.set(threadId, engine);
    }
    return engine;
  };

  const engineForTask = (taskId: string): ThreadEngine => {
    const task = store.getTask(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    return engineFor(task.threadId);
  };

  const orchestrator: Orchestrator = {
    config,

    async start(threadId) {
      return engineFor(threadId).start();
    },

    async pause(threadId) {
      return engineFor(threadId).pause();
    },

    async resume(threadId) {
      return engineFor(threadId).resume();
    },

    async cancel(threadId) {
      return engineFor(threadId).cancel();
    },

    async dispatch(taskId, dispatchOptions = {}) {
      const engine = engineForTask(taskId);
      const run = await engine.dispatch(taskId, dispatchOptions);
      return {
        runId: run.id,
        taskId: run.taskId,
        harness: run.harness,
        kind: run.kind,
        ...(run.worktreePath ? { worktreePath: run.worktreePath } : {}),
      };
    },

    async controlRun(runId, action) {
      const run = store.getRun(runId);
      if (!run) return { ok: false, note: `unknown run ${runId}` };
      return engineFor(run.threadId).controlRun(runId, action);
    },

    async runVerification(taskId, criterionIds) {
      return engineForTask(taskId).verify(taskId, criterionIds);
    },

    async recover(threadId) {
      return engineFor(threadId).recover();
    },

    status(threadId) {
      return engineFor(threadId).status();
    },

    async drain(threadId) {
      await engineFor(threadId).drain();
    },

    async close() {
      await Promise.all([...engines.values()].map((engine) => engine.cancel()));
      engines.clear();
    },

    host: createExecutionHost({
      store,
      engineForTask,
      engineFor,
      dispatch: (taskId, opts) => orchestrator.dispatch(taskId, opts),
    }),
  };

  return orchestrator;
}

/* ------------------------------------------------------------------- host */

function createExecutionHost(deps: {
  store: NexestraStore;
  engineFor(threadId: string): ThreadEngine;
  engineForTask(taskId: string): ThreadEngine;
  dispatch(taskId: string, options: DispatchOptions): Promise<DispatchTaskResult>;
}): ExecutionHost {
  const { store } = deps;

  return {
    async dispatchTask(input: DispatchTaskInput): Promise<DispatchTaskResult> {
      const options: DispatchOptions = {
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...(input.harness ? { harness: input.harness as HarnessId } : {}),
        ...(input.harnessConfig ? { harnessConfig: input.harnessConfig } : {}),
      };
      return deps.dispatch(input.taskId, options);
    },

    async readRunEvents(input: ReadRunEventsInput): Promise<ReadRunEventsResult> {
      const limit = input.limit ?? DEFAULT_EVENT_LIMIT;
      const types = input.types ? new Set(input.types) : undefined;
      const all = store
        .listRunEvents(input.runId, input.sinceSeq)
        .filter((event) => !types || types.has(event.type));
      const page = all.slice(0, limit);
      const last = page.at(-1);
      return {
        runId: input.runId,
        events: page.map((event) => ({ seq: event.seq, type: event.type, payload: event.payload })),
        nextSeq: last ? last.seq + 1 : (input.sinceSeq ?? 0),
        truncated: all.length > page.length,
      };
    },

    async readArtifact(input: ReadArtifactInput): Promise<ReadArtifactResult> {
      const artifact = store.getArtifact(input.artifactId);
      if (!artifact) throw new Error(`artifact ${input.artifactId} not found`);
      const maxBytes = input.maxBytes ?? DEFAULT_ARTIFACT_BYTES;

      let content: string;
      try {
        content = await readFile(path.join(store.dataDir, artifact.path), "utf8");
      } catch {
        content = artifact.preview;
      }
      const truncated = Buffer.byteLength(content, "utf8") > maxBytes;
      return {
        artifact: { id: artifact.id, kind: artifact.kind, title: artifact.title },
        content: truncated ? content.slice(0, maxBytes) : content,
        truncated,
      };
    },

    async controlRun(input) {
      const run = store.getRun(input.runId);
      if (!run) return { ok: false, note: `unknown run ${input.runId}` };
      return deps.engineFor(run.threadId).controlRun(input.runId, {
        action: input.action,
        ...(input.message ? { message: input.message } : {}),
      });
    },

    async runVerification(input): Promise<RunVerificationResult> {
      return deps.engineForTask(input.taskId).verify(input.taskId, input.criterionIds);
    },

    async markCriterion(input: MarkCriterionInput): Promise<MarkCriterionResult> {
      // The criterion belongs to a thread, not a task; find it through the spec
      // of whichever thread carries it.
      for (const thread of store.listThreads()) {
        const spec = store.getSpec(thread.id);
        if (!spec?.acceptanceCriteria.some((criterion) => criterion.id === input.criterionId)) {
          continue;
        }
        return deps.engineFor(thread.id).markCriterion(input);
      }
      return { criterionId: input.criterionId, satisfied: false };
    },
  };
}
