/**
 * One harness run, from `prepare()` to the last artifact.
 *
 * The run's store id **is** the adapter's `PreparedRun.runId`, so a runId the
 * Master receives from `dispatchTask` can be handed straight back to
 * `adapter.control()` without a translation table.
 */

import { diff as gitDiff } from "@nexestra/adapter-codex/worktree";
import type {
  HarnessAdapter,
  HarnessEvent,
  Run,
  RunKind,
  RunSpec,
  Task,
  Usage,
} from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { writeArtifact } from "./artifacts.js";
import { addUsage, priceUsage, ZERO_USAGE } from "./budget.js";
import type { ResolvedConfig } from "./config.js";
import { extractReview, type ReviewResult } from "./review.js";

export interface RunOutcome {
  readonly run: Run;
  readonly runId: string;
  readonly ok: boolean;
  readonly cancelled: boolean;
  readonly exitCode?: number;
  readonly error?: { message: string; retryable: boolean };
  readonly final?: { message: string; structured?: unknown };
  readonly review?: ReviewResult;
  readonly usage: Usage;
  readonly costUSD: number;
  readonly artifactIds: readonly string[];
  /** Files git reports as changed in the worktree after the run. */
  readonly changedFiles: readonly string[];
}

export interface RunHooks {
  /** Called for every event, after it has been persisted. */
  onEvent?(runId: string, event: HarnessEvent): void;
  /** Called with the incremental cost of each `usage` event. */
  onCost?(runId: string, costUSD: number): void | Promise<void>;
  /** Called when the harness asks for permission mid-run. Must not block. */
  onPermission?(runId: string, event: Extract<HarnessEvent, { type: "permission_request" }>): void;
}

export interface ExecuteRunOptions {
  store: NexestraStore;
  adapter: HarnessAdapter;
  config: ResolvedConfig;
  threadId: string;
  task: Task;
  kind: RunKind;
  spec: RunSpec;
  worktree: string;
  attempt: number;
  signal: AbortSignal;
  hooks?: RunHooks;
  /** Called once the run row exists — `dispatch()` resolves on this. */
  onRunRecorded?(run: Run): void;
}

const MAX_COMMAND_LOG = 200;

/** Prepare, stream, persist. Never throws for a harness-level failure. */
export async function executeRun(options: ExecuteRunOptions): Promise<RunOutcome> {
  const { store, adapter, config, task, spec, signal, hooks } = options;

  // A spec with no model is the common case — it is what makes the adapter
  // leave `-m` off the command line — so pricing has to fall back to whatever
  // the harness itself said it defaults to, or every such run costs $0.00.
  const model = spec.model ?? config.defaultModelFor(adapter.id);

  const prepared = await adapter.prepare(spec);
  let run = store.recordRun({
    id: prepared.runId,
    threadId: options.threadId,
    taskId: task.id,
    kind: options.kind,
    harness: adapter.id,
    status: "running",
    worktreePath: options.worktree,
  });
  options.onRunRecorded?.(run);

  let seq = 0;
  let usage: Usage = { ...ZERO_USAGE };
  let costUSD = 0;
  let sessionRef: string | undefined;
  let exitCode: number | undefined;
  let error: { message: string; retryable: boolean } | undefined;
  let final: { message: string; structured?: unknown } | undefined;
  const commands: string[] = [];
  const texts: string[] = [];

  const append = (event: HarnessEvent): void => {
    store.appendRunEvent({ runId: run.id, type: event.type, payload: event, seq: seq++ });
    hooks?.onEvent?.(run.id, event);
  };

  try {
    for await (const event of adapter.run(prepared, signal)) {
      append(event);
      switch (event.type) {
        case "started":
          sessionRef = event.sessionRef;
          break;
        case "assistant_text":
          texts.push(event.text);
          break;
        case "command":
          if (commands.length < MAX_COMMAND_LOG) {
            commands.push(
              [
                `$ ${event.cmd}`,
                event.exitCode !== undefined ? `exit ${event.exitCode}` : undefined,
                event.stdout?.trim() ? event.stdout.trim() : undefined,
                event.stderr?.trim() ? `stderr: ${event.stderr.trim()}` : undefined,
              ]
                .filter((line) => line !== undefined)
                .join("\n"),
            );
          }
          break;
        case "permission_request":
          hooks?.onPermission?.(run.id, event);
          break;
        case "usage": {
          const cost = priceUsage(event, model, config.priceTable);
          usage = addUsage(usage, event, cost);
          costUSD += cost;
          await hooks?.onCost?.(run.id, cost);
          break;
        }
        case "final":
          final = {
            message: event.message,
            ...(event.structured !== undefined ? { structured: event.structured } : {}),
          };
          break;
        case "error":
          error = { message: event.message, retryable: event.retryable };
          break;
        case "ended":
          exitCode = event.exitCode;
          break;
        default:
          break;
      }
    }
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    error = { message, retryable: false };
    append({ type: "error", message, retryable: false });
  }

  const cancelled = signal.aborted;
  const ok = !cancelled && error === undefined && final !== undefined && (exitCode ?? 0) === 0;

  run = store.recordRun({
    id: run.id,
    threadId: options.threadId,
    taskId: task.id,
    kind: options.kind,
    harness: adapter.id,
    status: cancelled ? "cancelled" : ok ? "succeeded" : "failed",
    ...(sessionRef ? { sessionRef } : {}),
    worktreePath: options.worktree,
    ...(exitCode !== undefined ? { exitCode } : {}),
    usage,
    endedAt: config.now(),
  });

  const artifactIds: string[] = [];
  const record = async (
    kind: Parameters<typeof writeArtifact>[0]["kind"],
    title: string,
    content: string,
  ): Promise<void> => {
    if (content.trim().length === 0) return;
    const artifact = await writeArtifact({
      store,
      threadId: options.threadId,
      taskId: task.id,
      runId: run.id,
      kind,
      title,
      content,
      maxBytes: config.maxArtifactBytes,
    });
    artifactIds.push(artifact.id);
  };

  let changedFiles: string[] = [];
  let review: ReviewResult | undefined;

  if (options.kind === "review") {
    if (final) {
      review = extractReview(final);
      await record(
        "review",
        `Review findings — ${task.title} (attempt ${options.attempt})`,
        `${JSON.stringify({ summary: review.summary, findings: review.findings }, null, 2)}\n`,
      );
    }
  } else {
    try {
      const patch = await gitDiff(options.worktree, undefined, {
        excludePathspecs: [":(exclude).nexestra"],
        maxBytes: config.maxArtifactBytes,
      });
      changedFiles = patch.files.map((file) => file.path);
      await record("diff", `Diff — ${task.title} (attempt ${options.attempt})`, patch.patch);
    } catch (thrown) {
      config.logger.warn("orchestrator: could not compute the post-run diff", thrown);
    }
  }

  const message = [
    final?.message ?? texts.join("\n\n"),
    error ? `[error] ${error.message} (retryable: ${error.retryable})` : "",
    exitCode !== undefined ? `[exit] ${exitCode}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
  await record("log", `Harness output — ${task.title} (${options.kind})`, message);
  if (commands.length > 0) {
    await record("log", `Commands — ${task.title} (${options.kind})`, commands.join("\n\n"));
  }

  return {
    run,
    runId: run.id,
    ok,
    cancelled,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(error ? { error } : {}),
    ...(final ? { final } : {}),
    ...(review ? { review } : {}),
    usage,
    costUSD,
    artifactIds,
    changedFiles,
  };
}
