/**
 * `createOpenCodeAdapter()` — the `HarnessAdapter` implementation for
 * `opencode serve` + `GET /event` (PLAN.md §5, `docs/harness-protocols.md` §2).
 *
 * Shape of one run:
 *
 *   prepare()  ensure a server for the worktree → `POST /session` with a
 *              per-session permission ruleset → write the run directory
 *   run()      subscribe to the shared SSE stream → `POST prompt_async` (204)
 *              → map events until the session goes idle → `final` + `ended`
 *   control()  abort / answer a permission / steer the same session
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { diff as gitDiff, type WorktreeDiff } from "@nexestra/adapter-codex/worktree";
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
import { OpenCodeClient } from "./client.js";
import { discoverOpenCode, findOpenCodeBinary } from "./discover.js";
import {
  type OpenCodeControlResult,
  OpenCodeHttpError,
  OpenCodePrepareError,
  OpenCodeRunError,
  OpenCodeUnsupportedControlError,
} from "./errors.js";
import { OpenCodeMapper, type OpenCodePatchRecord } from "./mapper.js";
import {
  DIFF_EXCLUDE_PATHSPECS,
  type OpenCodeAdapterOptions,
  type OpenCodeUsageTotals,
  REASONING_TO_OPENCODE_VARIANT,
  type ResolvedOpenCodeOptions,
  RUN_DIR_SEGMENTS,
  resolveOptions,
} from "./options.js";
import { permissionRulesetFor, toolMapFor } from "./permission.js";
import { AsyncQueue } from "./queue.js";
import { buildReviewPrompt, type OpenCodeReviewFinding, parseReviewFindings } from "./review.js";
import { type OpenCodeServerHandle, OpenCodeServerManager } from "./server.js";
import type { OpenCodeEvent, OpenCodePermissionRuleset } from "./types.js";

const MANIFEST_FILE = "run.json";
const INSTRUCTIONS_FILE = "instructions.md";
const PROMPT_FILE = "prompt.md";

/** What `prepare()` persists so `run()` works even in a fresh process. */
interface OpenCodeRunManifest {
  runId: string;
  taskId: string;
  kind: RunKind;
  cwd: string;
  runDir: string;
  review: boolean;
  sandbox: SandboxLevel;
  sessionId: string;
  serverUrl: string;
  providerId: string;
  modelId: string;
  variant?: string;
  agent: string;
  prompt: string;
  timeoutMs: number;
  hasOutputSchema: boolean;
  outputSchema?: Record<string, unknown>;
  tools?: Record<string, boolean>;
  permission: OpenCodePermissionRuleset;
  warnings: string[];
}

/** Live state for one prepared or running run. */
export interface OpenCodeRunHandle extends OpenCodeRunManifest {
  /** Present while `run()` is streaming. */
  controller?: AbortController;
  cancelReason?: string;
  mapper?: OpenCodeMapper;
  server?: OpenCodeServerHandle;
}

/** `final.structured` produced by this adapter. */
export interface OpenCodeFinalStructured {
  sessionRef: string;
  agent: string;
  model: string;
  variant?: string;
  /** `AssistantMessage.structured`, or the JSON parsed out of the final message. */
  output?: unknown;
  /** Review findings; `kind: "review"` only. */
  findings?: OpenCodeReviewFinding[];
  reviewSummary?: string;
  /** The real `git diff` of the worktree — the source of truth for file kinds. */
  diff?: WorktreeDiff;
  /** `file_changed` events exactly as the adapter emitted them. */
  fileChanges?: { path: string; kind: "add" | "modify" | "delete" }[];
  /** Unified diffs carried by `apply_patch` / `edit` / `write` tool metadata. */
  patches?: OpenCodePatchRecord[];
  /** Full token breakdown; `HarnessEvent.usage` only carries three fields. */
  usage?: OpenCodeUsageTotals;
  /** `session.status {type:"retry"}` count — provider retries, not failures. */
  retries?: number;
  /** How often the shared SSE stream had to be re-established mid-run. */
  reconnects?: number;
  /** Events the mapper did not recognise. */
  unknownEvents?: number;
  finish?: string;
  warnings?: string[];
}

export interface OpenCodeAdapter extends HarnessAdapter {
  /** Like `control()`, but reports unsupported actions instead of throwing. */
  controlDetailed(runId: string, action: RunControl): Promise<OpenCodeControlResult>;
  /** Runs this adapter instance has prepared, by run id. */
  readonly runs: ReadonlyMap<string, OpenCodeRunHandle>;
  /** The `opencode serve` processes this adapter owns. */
  readonly servers: OpenCodeServerManager;
  /** Stop every server this adapter started. */
  dispose(): Promise<void>;
}

function unsupportedReason(action: RunControl["action"]): string {
  switch (action) {
    case "pause":
    case "resume":
      return (
        "opencode has no pause: a session is either busy or idle. The closest " +
        "equivalent is `cancel` (POST /session/{id}/abort) followed by a new " +
        "prompt on the same session, which `steer` already does."
      );
    default:
      return "unsupported by opencode";
  }
}

export function createOpenCodeAdapter(options: OpenCodeAdapterOptions = {}): OpenCodeAdapter {
  const resolved = resolveOptions(options);
  const runs = new Map<string, OpenCodeRunHandle>();
  /** Run ids currently streaming, per server URL — see `#sessionless` routing. */
  const activeByServer = new Map<string, Set<string>>();
  let binaryPromise: Promise<string | undefined> | undefined;

  async function binary(): Promise<string> {
    binaryPromise ??= findOpenCodeBinary(resolved);
    const found = await binaryPromise;
    if (!found) {
      binaryPromise = undefined;
      throw new OpenCodePrepareError(
        options.binaryPath
          ? `configured opencode binary "${options.binaryPath}" is missing or not executable`
          : "opencode binary not found on PATH; set options.binaryPath",
      );
    }
    return found;
  }

  const servers = new OpenCodeServerManager({ binary, options: resolved });

  // ------------------------------------------------------------------ prepare

  async function prepare(spec: RunSpec): Promise<PreparedRun> {
    if (!path.isAbsolute(spec.cwd)) {
      throw new OpenCodePrepareError(`RunSpec.cwd must be absolute, got "${spec.cwd}"`);
    }
    const warnings: string[] = [];
    const server = await servers.ensure(spec.cwd);
    const model = await resolveModel(spec.model, server, resolved);
    const review = spec.kind === "review";
    // A reviewer must not be able to edit the code it is reviewing, whatever
    // the caller asked for.
    const sandbox: SandboxLevel = review ? "read-only" : spec.sandbox;
    if (review && spec.sandbox !== "read-only") {
      warnings.push(
        `review runs are forced to read-only permissions (RunSpec.sandbox was "${spec.sandbox}")`,
      );
    }
    const agent = review ? resolved.reviewAgent : resolved.agent;
    const variant = resolved.variantFor
      ? resolved.variantFor(spec.reasoning, spec.model)
      : spec.reasoning
        ? REASONING_TO_OPENCODE_VARIANT[spec.reasoning]
        : undefined;
    const permission = permissionRulesetFor(sandbox, resolved);
    const tools = toolMapFor(sandbox, spec.tools);
    if (spec.mcpServers && spec.mcpServers.length > 0) {
      warnings.push(
        "per-run MCP servers are not wired yet; register them with POST /mcp before the run",
      );
    }
    if (spec.skills && spec.skills.length > 0) {
      warnings.push("RunSpec.skills is ignored; OpenCode resolves skills from its own config");
    }

    const prompt = review
      ? buildReviewPrompt(spec.instructions, spec.reviewTarget)
      : spec.instructions;

    const runId = resolved.runIdFactory();
    const runDir = path.join(spec.cwd, ...RUN_DIR_SEGMENTS, runId);
    await mkdir(runDir, { recursive: true });
    const instructionsPath = path.join(runDir, INSTRUCTIONS_FILE);
    await writeFile(instructionsPath, spec.instructions, "utf8");
    if (review) await writeFile(path.join(runDir, PROMPT_FILE), prompt, "utf8");

    const session = await server.client.createSession({
      title: spec.taskId,
      agent,
      permission,
      model: {
        providerID: model.providerId,
        id: model.modelId,
        ...(variant ? { variant } : {}),
      },
      metadata: { nexestra: { runId, taskId: spec.taskId, kind: spec.kind } },
    });

    const manifest: OpenCodeRunManifest = {
      runId,
      taskId: spec.taskId,
      kind: spec.kind,
      cwd: spec.cwd,
      runDir,
      review,
      sandbox,
      sessionId: session.id,
      serverUrl: server.url,
      providerId: model.providerId,
      modelId: model.modelId,
      ...(variant ? { variant } : {}),
      agent,
      prompt,
      timeoutMs: spec.timeoutMs,
      hasOutputSchema: spec.outputSchema !== undefined,
      ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
      ...(tools ? { tools } : {}),
      permission,
      warnings,
    };
    runs.set(runId, { ...manifest, server });
    await writeFile(
      path.join(runDir, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    for (const warning of warnings) resolved.logger.warn(`opencode: ${warning}`);

    const command = resolved.attachUrl
      ? (resolved.binaryPath ?? "opencode")
      : await binary().catch(() => "opencode");
    return {
      runId,
      taskId: spec.taskId,
      harness: "opencode",
      cwd: spec.cwd,
      command,
      args: serveArgs(resolved),
      // Only the overlay — never a copy of process.env, which would be
      // persisted into the event store along with every secret in it.
      env: { ...resolved.env },
      instructionsPath,
      worktreePath: spec.cwd,
    };
  }

  async function handleFor(prepared: PreparedRun): Promise<OpenCodeRunHandle> {
    const known = runs.get(prepared.runId);
    if (known) return known;
    const manifestPath = path.join(
      prepared.cwd,
      ...RUN_DIR_SEGMENTS,
      prepared.runId,
      MANIFEST_FILE,
    );
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as OpenCodeRunManifest;
      const handle: OpenCodeRunHandle = { ...manifest };
      runs.set(prepared.runId, handle);
      return handle;
    } catch (error) {
      throw new OpenCodeRunError(
        `no run manifest for "${prepared.runId}"; call prepare() first (looked in ${manifestPath})`,
        error,
      );
    }
  }

  // ---------------------------------------------------------------------- run

  async function* run(prepared: PreparedRun, signal: AbortSignal): AsyncIterable<HarnessEvent> {
    if (prepared.harness !== "opencode") {
      throw new OpenCodeRunError(
        `PreparedRun.harness is "${prepared.harness}", expected "opencode"`,
      );
    }
    const handle = await handleFor(prepared);
    const server = await servers.ensure(handle.cwd);
    handle.server = server;
    handle.serverUrl = server.url;

    const mapper = new OpenCodeMapper({
      sessionId: handle.sessionId,
      cwd: handle.cwd,
      relativisePaths: resolved.relativisePaths,
      streamDeltas: resolved.streamDeltas,
      logger: resolved.logger,
    });
    handle.mapper = mapper;

    const controller = new AbortController();
    handle.controller = controller;
    const queue = new AsyncQueue<HarnessEvent>();
    const warnings = [...handle.warnings];
    const unsubscribes: (() => void)[] = [];

    let cancelKind: "cancel" | "timeout" | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    let reconnects = 0;

    const active = activeByServer.get(server.url) ?? new Set<string>();
    active.add(handle.runId);
    activeByServer.set(server.url, active);

    const settle = () => {
      if (settleTimer) return;
      settleTimer = setTimeout(() => queue.close(), resolved.idleSettleMs);
      settleTimer.unref?.();
    };

    const onEvent = (event: OpenCodeEvent) => {
      queue.push(...mapper.push(event));
      if (mapper.state.terminal) settle();
    };

    unsubscribes.push(server.events.subscribe(handle.sessionId, onEvent));
    // `file.edited` carries no session id, so it can only be attributed when
    // this run is the sole one streaming on that server.
    unsubscribes.push(
      server.events.subscribeSessionless((event) => {
        if (event.type !== "file.edited") return;
        const others = activeByServer.get(server.url);
        if (others?.size !== 1) return;
        onEvent(event);
      }),
    );
    unsubscribes.push(
      server.events.onLifecycle((lifecycle) => {
        if (lifecycle.type !== "connected" || !lifecycle.reconnect) return;
        reconnects += 1;
        resolved.logger.warn("opencode: event stream reconnected; events may have been missed", {
          runId: handle.runId,
        });
        // Events emitted while we were disconnected are gone; the session may
        // even have finished. Re-check instead of hanging forever.
        void recheckIdle(server, handle.sessionId, mapper).then((idle) => {
          if (idle) settle();
        });
      }),
    );
    unsubscribes.push(
      server.onExit((reason) => {
        queue.push({
          type: "error",
          message: `opencode server exited during the run (${reason})`,
          retryable: true,
        });
        mapper.markAborted();
        queue.close();
      }),
    );

    const abort = (kind: "cancel" | "timeout") => {
      if (cancelKind) return;
      cancelKind = kind;
      mapper.markAborted();
      void abortSession(server, handle, resolved).finally(() => {
        // The session normally answers with MessageAbortedError + idle over
        // SSE; this guard covers the case where it never does.
        const timer = setTimeout(() => queue.close(), resolved.abortTimeoutMs);
        timer.unref?.();
      });
    };

    const onExternalAbort = () => abort("cancel");
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    controller.signal.addEventListener("abort", onExternalAbort, { once: true });
    const timer =
      handle.timeoutMs > 0 ? setTimeout(() => abort("timeout"), handle.timeoutMs) : undefined;
    timer?.unref?.();

    try {
      await server.events.ready(resolved.startTimeoutMs);
      yield { type: "started", sessionRef: handle.sessionId };
      if (signal?.aborted) abort("cancel");

      if (!cancelKind) {
        try {
          await server.client.promptAsync(handle.sessionId, {
            parts: [{ type: "text", text: handle.prompt }],
            agent: handle.agent,
            model: { providerID: handle.providerId, modelID: handle.modelId },
            ...(handle.variant ? { variant: handle.variant } : {}),
            ...(handle.tools ? { tools: handle.tools } : {}),
            ...(handle.outputSchema
              ? { format: { type: "json_schema" as const, schema: handle.outputSchema } }
              : {}),
          });
        } catch (error) {
          const message =
            error instanceof OpenCodeHttpError
              ? error.message
              : `prompt failed: ${error instanceof Error ? error.message : String(error)}`;
          yield { type: "error", message, retryable: isRetryableHttp(error) };
          yield { type: "ended", exitCode: 1 };
          return;
        }
      }

      for await (const event of queue.drain()) yield event;
      for (const event of mapper.flushPending()) yield event;

      const state = mapper.state;
      if (cancelKind || state.aborted) {
        const message =
          cancelKind === "timeout"
            ? `timeout after ${handle.timeoutMs}ms`
            : (handle.cancelReason ?? "cancelled");
        // The mapper already emitted `cancelled` when the session reported
        // MessageAbortedError; only synthesise what is missing.
        if (!state.cancelEmitted || cancelKind === "timeout") {
          yield { type: "error", message, retryable: cancelKind === "timeout" };
        }
        yield { type: "ended", exitCode: 1 };
        return;
      }

      if (state.failure) {
        yield { type: "ended", exitCode: 1 };
        return;
      }

      const final = await buildFinal(server, handle, mapper, resolved, {
        warnings,
        reconnects,
      });
      yield final.event;
      yield { type: "ended", exitCode: final.exitCode };
    } finally {
      if (timer) clearTimeout(timer);
      if (settleTimer) clearTimeout(settleTimer);
      signal?.removeEventListener("abort", onExternalAbort);
      controller.signal.removeEventListener("abort", onExternalAbort);
      for (const unsubscribe of unsubscribes) unsubscribe();
      active.delete(handle.runId);
      if (active.size === 0) activeByServer.delete(server.url);
      handle.controller = undefined;
      // A consumer that breaks out of the loop must not leave the model running.
      if (!queue.closed && !mapper.state.terminal) {
        await abortSession(server, handle, resolved).catch(() => {});
      }
    }
  }

  // ------------------------------------------------------------------ control

  async function controlDetailed(
    runId: string,
    action: RunControl,
  ): Promise<OpenCodeControlResult> {
    const handle = runs.get(runId);
    if (action.action === "pause" || action.action === "resume") {
      return { action: action.action, supported: false, reason: unsupportedReason(action.action) };
    }
    if (!handle) {
      return {
        action: action.action,
        supported: true,
        applied: false,
        note: `unknown run "${runId}"`,
      };
    }
    const client = await clientFor(handle);

    switch (action.action) {
      case "cancel": {
        handle.cancelReason = action.reason ?? "cancelled";
        const live = handle.controller !== undefined;
        if (live) {
          handle.controller?.abort();
        } else {
          await client.abort(handle.sessionId).catch(() => false);
        }
        return {
          action: "cancel",
          supported: true,
          applied: true,
          ...(live ? {} : { note: `run "${runId}" was not streaming; the session was aborted` }),
        };
      }

      case "answer_permission": {
        const pending = handle.mapper?.pendingPermission(action.requestId);
        const channel =
          pending?.channel ?? (action.requestId.startsWith("que") ? "question" : "permission");
        if (channel === "question") {
          // The question channel takes answers, not allow/deny; a rejection is
          // its own endpoint and an approval forwards `note` as the answer.
          const applied = await answerQuestion(client, action, resolved);
          return { action: "answer_permission", supported: true, applied };
        }
        // `always` is opt-in through the note, because `RunControl` only has a
        // boolean and "allow this pattern forever" must never be the default.
        const reply = !action.approved
          ? "reject"
          : action.note?.trim().toLowerCase() === "always"
            ? "always"
            : "once";
        try {
          await client.respondPermission(handle.sessionId, action.requestId, reply);
          return { action: "answer_permission", supported: true, applied: true };
        } catch (error) {
          resolved.logger.debug(
            "opencode: session-scoped permission reply failed, retrying flat",
            error,
          );
          try {
            await client.replyPermission(action.requestId, reply, action.note);
            return { action: "answer_permission", supported: true, applied: true };
          } catch (fallbackError) {
            return {
              action: "answer_permission",
              supported: true,
              applied: false,
              note: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            };
          }
        }
      }

      case "steer": {
        await client.promptAsync(handle.sessionId, {
          parts: [{ type: "text", text: action.message }],
          agent: handle.agent,
          model: { providerID: handle.providerId, modelID: handle.modelId },
          ...(handle.variant ? { variant: handle.variant } : {}),
          ...(handle.tools ? { tools: handle.tools } : {}),
        });
        return { action: "steer", supported: true, applied: true };
      }
    }
  }

  async function control(runId: string, action: RunControl): Promise<void> {
    const result = await controlDetailed(runId, action);
    if (!result.supported) {
      throw new OpenCodeUnsupportedControlError(result.action, result.reason);
    }
  }

  async function clientFor(handle: OpenCodeRunHandle): Promise<OpenCodeClient> {
    if (handle.server?.alive()) return handle.server.client;
    const server = servers.get(handle.cwd);
    if (server?.alive() && server.url === handle.serverUrl) return server.client;
    // The run may have been prepared by a previous process; talk to the URL the
    // manifest recorded rather than starting a second server for the worktree.
    return new OpenCodeClient({
      baseUrl: handle.serverUrl,
      directory: handle.cwd,
      requestTimeoutMs: resolved.requestTimeoutMs,
      fetch: resolved.fetch,
    });
  }

  return {
    id: "opencode",
    discover: (): Promise<HarnessInfo> => discoverOpenCode({ options: resolved, manager: servers }),
    prepare,
    run,
    control,
    controlDetailed,
    runs,
    servers,
    dispose: () => servers.disposeAll(),
  };
}

// -------------------------------------------------------------------- helpers

function serveArgs(options: ResolvedOpenCodeOptions): string[] {
  return [
    "serve",
    "--port",
    "0",
    "--hostname",
    "127.0.0.1",
    "--print-logs",
    "--log-level",
    options.logLevel,
    ...(options.pure ? ["--pure"] : []),
    ...options.extraServeArgs,
  ];
}

/**
 * `provider/model` → `{providerId, modelId}`.
 *
 * Split on the **first** slash only: model ids themselves contain slashes
 * (`9router/dsv4/deepseek-v4-flash-0731`).
 */
export function splitModelRef(
  reference: string,
): { providerId: string; modelId: string } | undefined {
  const slash = reference.indexOf("/");
  if (slash <= 0 || slash === reference.length - 1) return undefined;
  return { providerId: reference.slice(0, slash), modelId: reference.slice(slash + 1) };
}

async function resolveModel(
  requested: string | undefined,
  server: OpenCodeServerHandle,
  options: ResolvedOpenCodeOptions,
): Promise<{ providerId: string; modelId: string }> {
  const reference = requested ?? options.defaultModel;
  if (reference) {
    const split = splitModelRef(reference);
    if (split) return split;
    if (options.defaultProviderId) {
      return { providerId: options.defaultProviderId, modelId: reference };
    }
    throw new OpenCodePrepareError(
      `model "${reference}" has no provider prefix; use "provider/model" or set options.defaultProviderId`,
    );
  }
  // §4.5: never fall through to the user's configured default silently — it
  // pointed at an unreachable local proxy on the recording machine. Pick the
  // first *connected* provider's default and say so.
  const providers = await server.client.providers().catch(() => undefined);
  const connected = providers?.connected ?? [];
  for (const providerId of connected) {
    const modelId = providers?.default?.[providerId];
    if (modelId) {
      options.logger.warn(
        `opencode: no model requested; using the connected default "${providerId}/${modelId}"`,
      );
      return { providerId, modelId };
    }
  }
  throw new OpenCodePrepareError(
    "no model given and no connected provider has a default; set RunSpec.model or options.defaultModel",
  );
}

async function abortSession(
  server: OpenCodeServerHandle,
  handle: OpenCodeRunHandle,
  options: ResolvedOpenCodeOptions,
): Promise<void> {
  try {
    await server.client.abort(handle.sessionId);
  } catch (error) {
    options.logger.warn("opencode: abort request failed", error);
    return;
  }
  // §2.7: abort answers `true` immediately; the session goes idle a moment
  // later. Verify rather than trusting the acknowledgement.
  const deadline = Date.now() + options.abortTimeoutMs;
  while (Date.now() < deadline) {
    const idle = await isSessionIdle(server.client, handle.sessionId);
    if (idle) return;
    await sleep(200);
  }
  options.logger.warn("opencode: session did not report idle after the abort", {
    sessionId: handle.sessionId,
  });
}

async function isSessionIdle(client: OpenCodeClient, sessionId: string): Promise<boolean> {
  try {
    const statuses = await client.sessionStatus();
    const entry = statuses.find((status) => status.sessionID === sessionId);
    if (!entry) return true;
    return entry.status?.type !== "busy";
  } catch {
    return false;
  }
}

async function recheckIdle(
  server: OpenCodeServerHandle,
  sessionId: string,
  mapper: OpenCodeMapper,
): Promise<boolean> {
  if (!mapper.state.sawBusy) return false;
  return isSessionIdle(server.client, sessionId);
}

function isRetryableHttp(error: unknown): boolean {
  if (error instanceof OpenCodeHttpError) return error.status >= 500 || error.status === 429;
  return true;
}

interface FinalContext {
  warnings: string[];
  reconnects: number;
}

async function buildFinal(
  server: OpenCodeServerHandle,
  handle: OpenCodeRunHandle,
  mapper: OpenCodeMapper,
  options: ResolvedOpenCodeOptions,
  context: FinalContext,
): Promise<{ event: HarnessEvent; exitCode: number }> {
  const state = mapper.state;
  // §2.4: one prompt yields many assistant messages and the sync POST response
  // only holds the last one, so the transcript is fetched explicitly.
  const transcript = await lastAssistantMessage(server.client, handle.sessionId, options);
  const message = transcript?.text ?? state.lastAssistantText ?? "";
  const structuredOutput = transcript?.structured ?? state.structured;

  const structured: OpenCodeFinalStructured = {
    sessionRef: handle.sessionId,
    agent: handle.agent,
    model: `${handle.providerId}/${handle.modelId}`,
    ...(handle.variant ? { variant: handle.variant } : {}),
  };
  if (structuredOutput !== undefined) structured.output = structuredOutput;
  if (state.finish) structured.finish = state.finish;

  if (handle.review) {
    const review = parseReviewFindings(message, structuredOutput);
    structured.findings = review?.findings ?? [];
    if (review?.summary) structured.reviewSummary = review.summary;
    if (!review) {
      context.warnings.push("the reviewer answered in prose; no structured findings were parsed");
    }
  }

  if (options.computeDiff) {
    try {
      structured.diff = await gitDiff(handle.cwd, options.diffBase, {
        excludePathspecs: DIFF_EXCLUDE_PATHSPECS,
        maxBytes: options.maxDiffBytes,
      });
    } catch (error) {
      options.logger.warn("opencode: could not compute the post-run diff", error);
    }
  }

  if (state.fileChanges.length > 0) structured.fileChanges = [...state.fileChanges];
  if (state.patches.length > 0) structured.patches = [...state.patches];

  const usage = { ...state.usage };
  if (usage.costUSD === 0 && options.priceUsage) {
    const priced = options.priceUsage(`${handle.providerId}/${handle.modelId}`, usage);
    if (priced !== undefined) usage.costUSD = priced;
  }
  structured.usage = usage;
  if (state.retries > 0) structured.retries = state.retries;
  if (context.reconnects > 0) {
    structured.reconnects = context.reconnects;
    context.warnings.push(
      `the event stream reconnected ${context.reconnects} time(s); some events were not observed`,
    );
  }
  if (state.unknownEvents > 0) structured.unknownEvents = state.unknownEvents;
  if (context.warnings.length > 0) structured.warnings = [...context.warnings];

  return { event: { type: "final", message, structured }, exitCode: 0 };
}

async function lastAssistantMessage(
  client: OpenCodeClient,
  sessionId: string,
  options: ResolvedOpenCodeOptions,
): Promise<{ text: string; structured: unknown } | undefined> {
  try {
    const messages = await client.messages(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.info.role !== "assistant") continue;
      const text = message.parts
        .filter((part) => part.type === "text" && part.synthetic !== true)
        .map((part) => part.text ?? "")
        .filter((value) => value.trim().length > 0)
        .join("\n")
        .trim();
      if (text.length === 0) continue;
      return { text, structured: message.info.structured };
    }
  } catch (error) {
    options.logger.warn("opencode: could not fetch the session transcript", error);
  }
  return undefined;
}

async function answerQuestion(
  client: OpenCodeClient,
  action: Extract<RunControl, { action: "answer_permission" }>,
  options: ResolvedOpenCodeOptions,
): Promise<boolean> {
  const route = action.approved
    ? `/question/${encodeURIComponent(action.requestId)}/reply`
    : `/question/${encodeURIComponent(action.requestId)}/reject`;
  try {
    const response = await options.fetch(client.url(route), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action.approved ? { answers: action.note ? [[action.note]] : [] } : {}),
    });
    return response.ok;
  } catch (error) {
    options.logger.warn("opencode: question reply failed", error);
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
