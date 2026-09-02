/**
 * `createCodexAdapter()` — the `HarnessAdapter` implementation for
 * `codex exec --json` (PLAN.md §5, `docs/harness-protocols.md` §1).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  HarnessAdapter,
  HarnessEvent,
  HarnessInfo,
  PreparedRun,
  RunControl,
  RunKind,
  RunSpec,
  SandboxLevel,
} from "@nexestra/core";
import { buildCodexCommand } from "./command.js";
import { discoverCodex, findCodexBinary } from "./discover.js";
import {
  type CodexControlResult,
  CodexPrepareError,
  CodexRunError,
  CodexUnsupportedControlError,
} from "./errors.js";
import {
  BENIGN_STDERR_PATTERNS,
  type CodexAdapterOptions,
  DIFF_EXCLUDE_PATHSPECS,
  type ResolvedCodexOptions,
  RUN_DIR_SEGMENTS,
  resolveOptions,
} from "./options.js";
import { CodexStreamParser, classifyCodexError } from "./parser.js";
import { spawnCodex } from "./process.js";
import { type CodexReviewFinding, parseReviewFindings } from "./review.js";
import type { CodexTodoItem, CodexUsage } from "./types.js";
import { diff as gitDiff, type WorktreeDiff } from "./worktree.js";

const MANIFEST_FILE = "run.json";
const LAST_MESSAGE_FILE = "last-message.md";
const OUTPUT_SCHEMA_FILE = "output-schema.json";
const INSTRUCTIONS_FILE = "instructions.md";

/** What `prepare()` persists so `run()` works even in a fresh process. */
interface CodexRunManifest {
  runId: string;
  taskId: string;
  kind: RunKind;
  cwd: string;
  runDir: string;
  review: boolean;
  sandbox: SandboxLevel;
  model?: string;
  timeoutMs: number;
  lastMessagePath: string;
  outputSchemaPath?: string;
  hasOutputSchema: boolean;
  warnings: string[];
}

/** Live state for one prepared or running run. */
export interface CodexRunHandle extends CodexRunManifest {
  /** Present while `run()` is streaming. */
  controller?: AbortController;
  /** Reason recorded by `control(runId, {action:"cancel"})`. */
  cancelReason?: string;
}

/** `final.structured` produced by this adapter. */
export interface CodexFinalStructured {
  threadId?: string;
  /** `JSON.parse` of the final message, when an `--output-schema` was in play. */
  output?: unknown;
  /** Review findings; `kind: "review"` only. */
  findings?: CodexReviewFinding[];
  reviewSummary?: string;
  /** The real `git diff` — Codex' own `file_change` carries no patch content. */
  diff?: WorktreeDiff;
  /** `file_change` items exactly as Codex reported them. */
  fileChanges?: { path: string; kind: "add" | "modify" | "delete" }[];
  todos?: CodexTodoItem[];
  /** Full Codex token breakdown (`HarnessEvent.usage` only carries two fields). */
  usage?: CodexUsage;
  warnings?: string[];
}

export interface CodexAdapter extends HarnessAdapter {
  /**
   * Like `control()`, but reports unsupported actions as a typed value instead
   * of throwing. `codex exec` supports `cancel` only.
   */
  controlDetailed(runId: string, action: RunControl): Promise<CodexControlResult>;
  /** Runs this adapter instance has prepared, by run id. */
  readonly runs: ReadonlyMap<string, CodexRunHandle>;
}

function unsupportedReason(action: RunControl["action"]): string {
  switch (action) {
    case "pause":
    case "resume":
      return (
        "codex exec runs one turn to completion; pausing would mean killing the process and " +
        "later `codex exec resume <thread_id>`. Live pause/resume needs `codex app-server`."
      );
    case "steer":
      return (
        "codex exec takes a single prompt in argv and runs with stdin closed, so there is no " +
        "channel for a mid-run message. Steering needs `codex app-server`."
      );
    case "answer_permission":
      return (
        "codex exec never asks for approval — it runs whatever the sandbox allows " +
        "(harness-protocols §1.3). Approval requests only exist in `codex app-server`."
      );
    default:
      return "unsupported by codex exec";
  }
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): CodexAdapter {
  const resolved = resolveOptions(options);
  const runs = new Map<string, CodexRunHandle>();
  let binaryPromise: Promise<string | undefined> | undefined;

  async function binary(): Promise<string> {
    binaryPromise ??= findCodexBinary(resolved);
    const found = await binaryPromise;
    if (!found) {
      binaryPromise = undefined;
      throw new CodexPrepareError(
        options.binaryPath
          ? `configured codex binary "${options.binaryPath}" is missing or not executable`
          : "codex binary not found on PATH; set options.binaryPath",
      );
    }
    return found;
  }

  async function prepare(spec: RunSpec): Promise<PreparedRun> {
    if (!path.isAbsolute(spec.cwd)) {
      throw new CodexPrepareError(`RunSpec.cwd must be absolute, got "${spec.cwd}"`);
    }
    const command = await binary();
    const runId = resolved.runIdFactory();
    const runDir = path.join(spec.cwd, ...RUN_DIR_SEGMENTS, runId);
    await mkdir(runDir, { recursive: true });

    const lastMessagePath = path.join(runDir, LAST_MESSAGE_FILE);
    const instructionsPath = path.join(runDir, INSTRUCTIONS_FILE);
    await writeFile(instructionsPath, spec.instructions, "utf8");

    // Review defaults to the findings schema so `final.structured.findings`
    // is populated; a caller-supplied schema always wins.
    const schema = spec.outputSchema;
    let outputSchemaPath: string | undefined;
    if (schema) {
      outputSchemaPath = path.join(runDir, OUTPUT_SCHEMA_FILE);
      await writeFile(outputSchemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
    }

    const line = buildCodexCommand(command, spec, resolved, {
      lastMessagePath,
      ...(outputSchemaPath ? { outputSchemaPath } : {}),
    });
    for (const warning of line.warnings) resolved.logger.warn(`codex: ${warning}`);

    const manifest: CodexRunManifest = {
      runId,
      taskId: spec.taskId,
      kind: spec.kind,
      cwd: spec.cwd,
      runDir,
      review: line.review,
      sandbox: spec.sandbox,
      ...(spec.model ? { model: spec.model } : {}),
      timeoutMs: spec.timeoutMs,
      lastMessagePath,
      ...(outputSchemaPath ? { outputSchemaPath } : {}),
      hasOutputSchema: outputSchemaPath !== undefined,
      warnings: line.warnings,
    };
    runs.set(runId, { ...manifest });
    await writeFile(
      path.join(runDir, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    return {
      runId,
      taskId: spec.taskId,
      harness: "codex",
      cwd: spec.cwd,
      command: line.command,
      args: line.args,
      // Only the overlay — never a copy of process.env, which would be
      // persisted into the event store along with every secret in it.
      env: { ...resolved.env },
      instructionsPath,
      worktreePath: spec.cwd,
    };
  }

  async function handleFor(prepared: PreparedRun): Promise<CodexRunHandle> {
    const known = runs.get(prepared.runId);
    if (known) return known;
    const manifestPath = path.join(
      prepared.cwd,
      ...RUN_DIR_SEGMENTS,
      prepared.runId,
      MANIFEST_FILE,
    );
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CodexRunManifest;
      const handle: CodexRunHandle = { ...manifest };
      runs.set(prepared.runId, handle);
      return handle;
    } catch (error) {
      throw new CodexRunError(
        `no run manifest for "${prepared.runId}"; call prepare() first (looked in ${manifestPath})`,
        error,
      );
    }
  }

  async function* run(prepared: PreparedRun, signal: AbortSignal): AsyncIterable<HarnessEvent> {
    if (prepared.harness !== "codex") {
      throw new CodexRunError(`PreparedRun.harness is "${prepared.harness}", expected "codex"`);
    }
    const handle = await handleFor(prepared);
    const controller = new AbortController();
    handle.controller = controller;

    const parser = new CodexStreamParser({
      cwd: handle.cwd,
      relativisePaths: resolved.relativisePaths,
      hasOutputSchema: handle.hasOutputSchema,
      logger: resolved.logger,
    });

    const proc = spawnCodex({
      command: prepared.command,
      args: prepared.args,
      cwd: prepared.cwd,
      env: { ...process.env, ...prepared.env } as Record<string, string>,
      stderrTailBytes: resolved.stderrTailBytes,
    });

    let cancelKind: "cancel" | "timeout" | undefined;
    const abort = (kind: "cancel" | "timeout") => {
      if (cancelKind) return;
      cancelKind = kind;
      void proc.kill(resolved.killGraceMs, resolved.logger);
    };

    const onExternal = () => abort("cancel");
    const onInternal = () => abort("cancel");
    const timer =
      handle.timeoutMs > 0 ? setTimeout(() => abort("timeout"), handle.timeoutMs) : undefined;
    timer?.unref?.();

    if (signal?.aborted) abort("cancel");
    signal?.addEventListener("abort", onExternal, { once: true });
    controller.signal.addEventListener("abort", onInternal, { once: true });

    try {
      for await (const chunk of proc.stdout()) {
        for (const event of parser.push(chunk)) yield decorate(event, handle, resolved);
      }
      for (const event of parser.flush()) yield decorate(event, handle, resolved);

      const result = await proc.subprocess;
      const exitCode =
        typeof result.exitCode === "number"
          ? result.exitCode
          : cancelKind
            ? 1
            : result.failed
              ? 1
              : 0;

      if (cancelKind) {
        // §1.4: SIGINT gives exit 1 with no terminal event at all and the `-o`
        // file is never written, so the adapter has to synthesise both events.
        // `final` is deliberately absent for a cancelled run.
        const message =
          cancelKind === "timeout"
            ? `timeout after ${handle.timeoutMs}ms`
            : (handle.cancelReason ?? "cancelled");
        yield { type: "error", message, retryable: cancelKind === "timeout" };
        yield { type: "ended", exitCode };
        return;
      }

      const state = parser.state;
      const succeeded = state.turnCompleted && !state.turnFailed && exitCode === 0;
      if (!succeeded) {
        const message = failureMessage(exitCode, proc.stderrTail(), state.turnCompleted);
        yield { type: "error", message, retryable: classifyCodexError(message) };
        yield { type: "ended", exitCode };
        return;
      }

      const fileMessage = await readIfPresent(handle.lastMessagePath);
      const finalMessage = fileMessage ?? parser.lastAgentMessage ?? "";
      const structured = await buildStructured(handle, parser, finalMessage, resolved);
      yield { type: "final", message: finalMessage, structured };
      yield { type: "ended", exitCode };
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onExternal);
      controller.signal.removeEventListener("abort", onInternal);
      handle.controller = undefined;
      // A consumer that breaks out of the loop must not leave codex running.
      if (proc.pid !== undefined && !proc.exited()) {
        await proc.kill(resolved.killGraceMs, resolved.logger).catch(() => {});
      }
    }
  }

  async function controlDetailed(runId: string, action: RunControl): Promise<CodexControlResult> {
    if (action.action === "cancel") {
      const handle = runs.get(runId);
      if (!handle) {
        return {
          action: "cancel",
          supported: true,
          applied: false,
          note: `unknown run "${runId}"`,
        };
      }
      handle.cancelReason = action.reason ?? "cancelled";
      const live = handle.controller !== undefined;
      handle.controller?.abort();
      return {
        action: "cancel",
        supported: true,
        applied: live,
        ...(live ? {} : { note: `run "${runId}" is not streaming` }),
      };
    }
    return {
      action: action.action,
      supported: false,
      reason: unsupportedReason(action.action),
      requires: "app-server",
    };
  }

  async function control(runId: string, action: RunControl): Promise<void> {
    const result = await controlDetailed(runId, action);
    if (!result.supported) {
      throw new CodexUnsupportedControlError(result.action, result.reason);
    }
  }

  return {
    id: "codex",
    discover: (): Promise<HarnessInfo> => discoverCodex(resolved),
    prepare,
    run,
    control,
    controlDetailed,
    runs,
  };
}

// -------------------------------------------------------------------- helpers

/** Codex reports token counts only; a pricer fills in `costUSD` if supplied. */
function decorate(
  event: HarnessEvent,
  handle: CodexRunHandle,
  options: ResolvedCodexOptions,
): HarnessEvent {
  if (event.type !== "usage" || !options.priceUsage) return event;
  const cost = options.priceUsage(handle.model, {
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
  });
  return cost === undefined ? event : { ...event, costUSD: cost };
}

function failureMessage(exitCode: number, stderrTail: string, turnCompleted: boolean): string {
  const noise = stderrTail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !BENIGN_STDERR_PATTERNS.some((rx) => rx.test(line)));
  const tail = noise.slice(-5).join("\n");
  if (exitCode === 2) {
    return `codex rejected the command line (exit 2)${tail ? `: ${tail}` : ""}`;
  }
  const base = turnCompleted
    ? `codex exited with code ${exitCode} after completing the turn`
    : `codex exited with code ${exitCode} without a turn.completed event`;
  return tail ? `${base}: ${tail}` : base;
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    const text = await readFile(file, "utf8");
    return text.length > 0 ? text : undefined;
  } catch {
    // §1.1: `-o` is not written at all when the run is cancelled or fails.
    return undefined;
  }
}

async function buildStructured(
  handle: CodexRunHandle,
  parser: CodexStreamParser,
  finalMessage: string,
  options: ResolvedCodexOptions,
): Promise<CodexFinalStructured> {
  const state = parser.state;
  const structured: CodexFinalStructured = {};
  if (state.threadId) structured.threadId = state.threadId;

  const output = parser.parseStructuredOutput(finalMessage);
  if (output !== undefined) structured.output = output;

  if (handle.review) {
    const review = parseReviewFindings(finalMessage);
    // Review may answer in prose; then there are simply no structured findings.
    structured.findings = review?.findings ?? [];
    if (review?.summary) structured.reviewSummary = review.summary;
  }

  if (options.computeDiff) {
    try {
      structured.diff = await gitDiff(handle.cwd, options.diffBase, {
        excludePathspecs: DIFF_EXCLUDE_PATHSPECS,
        maxBytes: options.maxDiffBytes,
      });
    } catch (error) {
      options.logger.warn("codex: could not compute the post-run diff", error);
    }
  }

  if (state.fileChanges.length > 0) structured.fileChanges = [...state.fileChanges];
  if (state.todos.length > 0) structured.todos = [...state.todos];
  if (state.usage) structured.usage = state.usage;
  if (handle.warnings.length > 0) structured.warnings = [...handle.warnings];
  return structured;
}
