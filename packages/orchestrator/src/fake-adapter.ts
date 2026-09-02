/**
 * `FakeHarnessAdapter` — a scripted `HarnessAdapter` for tests and for running
 * the loop without a real harness installed.
 *
 * It behaves like a real adapter in the ways the loop cares about: it writes
 * files into the worktree so `git diff` and the verification commands see real
 * changes, it reports usage, it honours `AbortSignal`, and a cancelled run ends
 * the way `codex exec` ends one — an `error` followed by `ended`, with no
 * `final` (`docs/harness-protocols.md` §1.4).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  HarnessAdapter,
  HarnessEvent,
  HarnessId,
  HarnessInfo,
  PreparedRun,
  RunControl,
  RunSpec,
} from "@nexestra/core";

export interface FakeRunScript {
  /** Emitted verbatim, in order. Defaults to a successful edit run. */
  events?: HarnessEvent[];
  /** Written into the worktree before the events are emitted. */
  files?: Record<string, string>;
  /** Removed from the worktree before the events are emitted. */
  deleteFiles?: string[];
  /** Await this before emitting anything — lets a test interleave. */
  before?: () => Promise<void> | void;
  /** Milliseconds between events. Default 0. */
  delayMs?: number;
  /** Never finish; the run only ends when it is cancelled. */
  hang?: boolean;
}

export interface FakeRunContext {
  spec: RunSpec;
  prepared: PreparedRun;
  /** 1-based count of runs this adapter has started for `taskId` + `kind`. */
  attempt: number;
  /** Total runs started by this adapter, 1-based. */
  index: number;
}

export interface FakeAdapterCall {
  runId: string;
  taskId: string;
  kind: RunSpec["kind"];
  attempt: number;
  cwd: string;
  instructions: string;
  sandbox: RunSpec["sandbox"];
}

export interface FakeAdapterOptions {
  id?: HarnessId;
  /** Decides what a run does. Falls back to `defaultScript`. */
  script?: (context: FakeRunContext) => FakeRunScript | HarnessEvent[] | undefined;
  /** Emitted when a script does not supply its own events. */
  defaultScript?: FakeRunScript;
  /** Reported by `discover()`. */
  info?: Partial<HarnessInfo>;
  /** Control actions this fake claims to support. Default: all of them. */
  supports?: readonly RunControl["action"][];
}

export interface FakeHarnessAdapter extends HarnessAdapter {
  /** Every run this adapter prepared, in order. */
  readonly calls: readonly FakeAdapterCall[];
  /** Control actions received, in order. */
  readonly controls: readonly { runId: string; action: RunControl }[];
  /** Highest number of runs that overlapped in time. */
  readonly maxConcurrent: number;
  /** Runs currently streaming. */
  readonly running: ReadonlySet<string>;
  /** Answer a `permission_request` this adapter emitted. */
  readonly answers: ReadonlyMap<string, boolean>;
}

const DEFAULT_EVENTS: HarnessEvent[] = [
  { type: "started", sessionRef: "fake-session" },
  { type: "assistant_text", text: "done" },
  { type: "usage", inputTokens: 1000, outputTokens: 200 },
  { type: "final", message: "done" },
  { type: "ended", exitCode: 0 },
];

/** A script that fails once with a retryable error and writes nothing. */
export function retryableFailure(message = "transient harness error"): FakeRunScript {
  return {
    events: [
      { type: "started", sessionRef: "fake-session" },
      { type: "usage", inputTokens: 500, outputTokens: 50 },
      { type: "error", message, retryable: true },
      { type: "ended", exitCode: 1 },
    ],
  };
}

/** A script that fails in a way no retry can fix. */
export function fatalFailure(message = "the model refused"): FakeRunScript {
  return {
    events: [
      { type: "started", sessionRef: "fake-session" },
      { type: "error", message, retryable: false },
      { type: "ended", exitCode: 1 },
    ],
  };
}

/** A successful run that writes `files` into the worktree. */
export function writesFiles(files: Record<string, string>, message = "done"): FakeRunScript {
  return {
    files,
    events: [
      { type: "started", sessionRef: "fake-session" },
      ...Object.keys(files).map(
        (file): HarnessEvent => ({ type: "file_changed", path: file, kind: "add" }),
      ),
      { type: "usage", inputTokens: 1200, outputTokens: 300 },
      { type: "final", message },
      { type: "ended", exitCode: 0 },
    ],
  };
}

/** A review run that answers with structured findings. */
export function reviewFindings(
  findings: { title: string; severity: string; body?: string }[],
  summary = "reviewed",
): FakeRunScript {
  const structured = {
    summary,
    findings: findings.map((finding) => ({
      title: finding.title,
      severity: finding.severity,
      file: null,
      line: null,
      body: finding.body ?? finding.title,
    })),
  };
  return {
    events: [
      { type: "started", sessionRef: "fake-review" },
      { type: "usage", inputTokens: 800, outputTokens: 120 },
      { type: "final", message: JSON.stringify(structured), structured },
      { type: "ended", exitCode: 0 },
    ],
  };
}

let counter = 0;

export function createFakeHarnessAdapter(options: FakeAdapterOptions = {}): FakeHarnessAdapter {
  const id = options.id ?? "codex";
  const calls: FakeAdapterCall[] = [];
  const controls: { runId: string; action: RunControl }[] = [];
  const answers = new Map<string, boolean>();
  const running = new Set<string>();
  const cancelled = new Map<string, AbortController>();
  const attempts = new Map<string, number>();
  const specs = new Map<string, RunSpec>();
  let maxConcurrent = 0;

  const adapter = {
    id,

    async discover(): Promise<HarnessInfo> {
      return {
        id,
        available: true,
        version: "0.0.0-fake",
        models: ["fake-model"],
        sandboxModes: ["read-only", "workspace-write", "danger-full-access"],
        authOk: true,
        warnings: [],
        ...options.info,
      };
    },

    async prepare(spec: RunSpec): Promise<PreparedRun> {
      counter += 1;
      const runId = `run_fake${counter.toString(36).padStart(4, "0")}`;
      const key = `${spec.taskId}:${spec.kind}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      specs.set(runId, spec);
      calls.push({
        runId,
        taskId: spec.taskId,
        kind: spec.kind,
        attempt,
        cwd: spec.cwd,
        instructions: spec.instructions,
        sandbox: spec.sandbox,
      });
      return {
        runId,
        taskId: spec.taskId,
        harness: id,
        cwd: spec.cwd,
        command: "fake-harness",
        args: [],
        env: {},
      };
    },

    async *run(prepared: PreparedRun, signal: AbortSignal): AsyncIterable<HarnessEvent> {
      const spec = specs.get(prepared.runId);
      if (!spec) throw new Error(`fake adapter: prepare() was not called for ${prepared.runId}`);

      const key = `${spec.taskId}:${spec.kind}`;
      const attempt = attempts.get(key) ?? 1;
      const resolved = options.script?.({ spec, prepared, attempt, index: calls.length });
      const script: FakeRunScript = Array.isArray(resolved)
        ? { events: resolved }
        : (resolved ?? options.defaultScript ?? {});

      const controller = new AbortController();
      cancelled.set(prepared.runId, controller);
      running.add(prepared.runId);
      maxConcurrent = Math.max(maxConcurrent, running.size);

      try {
        await script.before?.();

        for (const file of script.deleteFiles ?? []) {
          await rm(path.join(prepared.cwd, file), { force: true });
        }
        for (const [file, content] of Object.entries(script.files ?? {})) {
          const target = path.join(prepared.cwd, file);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content, "utf8");
        }

        const events = script.events ?? DEFAULT_EVENTS;
        for (const event of events) {
          if (signal.aborted || controller.signal.aborted) break;
          if (script.delayMs) await sleep(script.delayMs);
          yield event;
        }

        if (script.hang) {
          await until(signal, controller.signal);
        }

        if (signal.aborted || controller.signal.aborted) {
          // Same shape as a cancelled `codex exec`: no `final`.
          yield { type: "error", message: "cancelled", retryable: false };
          yield { type: "ended", exitCode: 1 };
        }
      } finally {
        running.delete(prepared.runId);
        cancelled.delete(prepared.runId);
      }
    },

    async control(runId: string, action: RunControl): Promise<void> {
      controls.push({ runId, action });
      const supported = options.supports ?? [
        "pause",
        "resume",
        "cancel",
        "answer_permission",
        "steer",
      ];
      if (!supported.includes(action.action)) {
        throw new Error(`fake adapter does not support "${action.action}"`);
      }
      if (action.action === "cancel") cancelled.get(runId)?.abort();
      if (action.action === "answer_permission") answers.set(action.requestId, action.approved);
    },

    get calls() {
      return calls;
    },
    get controls() {
      return controls;
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
    get running() {
      return running;
    },
    get answers() {
      return answers;
    },
  } satisfies FakeHarnessAdapter;

  return adapter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Resolve as soon as any of the signals aborts. */
function until(...signals: AbortSignal[]): Promise<void> {
  return new Promise((resolve) => {
    for (const signal of signals) {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    }
  });
}
