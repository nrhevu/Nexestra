/**
 * The named things a fake run can do.
 *
 * A scenario is chosen per run — from `options.scenarioFor(spec)`, or from a
 * marker in the run's instructions, or from the run kind — and turned into a
 * `FakeRunScript`. Every scenario is deterministic: same task id, same kind,
 * same attempt ⇒ same session ref, same call ids, same token counts.
 */
import type { HarnessEvent, RunKind } from "@nexestra/core";
import type { FakeRunContext, FakeRunScript, FakeStreamContext } from "./scripted.js";

export const FAKE_SCENARIOS = [
  "success",
  "retryable_failure_then_success",
  "fatal_failure",
  "permission_request",
  "slow",
  "review_with_findings",
  "review_clean",
] as const;

export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

export function isFakeScenario(value: string): value is FakeScenario {
  return (FAKE_SCENARIOS as readonly string[]).includes(value);
}

/** `[scenario: slow]`, `nexestra-scenario=fatal_failure`, `scenario: slow`. */
const SCENARIO_MARKER = /(?:nexestra[-_ ]?scenario|scenario)\s*[:=]\s*["'`[]?\s*([a-z_]+)/i;

/**
 * Read the scenario a run should play out of its instructions.
 *
 * An explicit marker wins. Otherwise a bare scenario name anywhere in the text
 * is honoured, which is what makes `"…please fail once (retryable_failure_then_success)"`
 * work in a hand-written task description without any ceremony.
 */
export function scenarioFromInstructions(instructions: string): FakeScenario | undefined {
  const marked = SCENARIO_MARKER.exec(instructions)?.[1]?.toLowerCase();
  if (marked && isFakeScenario(marked)) return marked;

  // Longest first: `review_with_findings` must not be shadowed by `review_clean`.
  for (const scenario of [...FAKE_SCENARIOS].sort((a, b) => b.length - a.length)) {
    if (new RegExp(`(^|[^a-z_])${scenario}([^a-z_]|$)`, "i").test(instructions)) return scenario;
  }
  return undefined;
}

/** What a run plays when nothing said otherwise. */
export function defaultScenarioFor(kind: RunKind): FakeScenario {
  return kind === "review" ? "review_clean" : "success";
}

/* ------------------------------------------------------------------ files */

const PATH_DENYLIST = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "biome.json",
  ".gitignore",
]);

const BACKTICKED = /`([^`\n]{1,200})`/g;
const BARE_PATH = /(?:^|[\s(])([\w][\w./-]*\.[a-z]{1,8})(?=[\s),.;:]|$)/gim;

function plausible(candidate: string): boolean {
  const value = candidate.trim();
  if (value.length === 0 || value.length > 200) return false;
  if (/\s/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("-") || value.includes("..")) return false;
  if (!/\.[a-z]{1,8}$/i.test(value)) return false;
  if (PATH_DENYLIST.has(value)) return false;
  return true;
}

/**
 * Which files a `success` run should actually create.
 *
 * Backticked paths win, because that is how a Master-written instruction names
 * a file; bare paths are the fallback for prose. The result is deliberately
 * conservative — a wrong guess would have the fake writing over something real
 * — and the adapter falls back to one scratch file when nothing is found.
 */
export function filesFromInstructions(instructions: string): string[] {
  const found: string[] = [];
  const add = (value: string) => {
    const trimmed = value.trim().replace(/^\.\//, "");
    if (plausible(trimmed) && !found.includes(trimmed)) found.push(trimmed);
  };

  for (const match of instructions.matchAll(BACKTICKED)) add(match[1] ?? "");
  if (found.length > 0) return found;
  for (const match of instructions.matchAll(BARE_PATH)) add(match[1] ?? "");
  return found;
}

/** Deterministic, syntactically valid content for the file the fake creates. */
export function fileContentFor(file: string, taskId: string): string {
  const extension = file.slice(file.lastIndexOf(".")).toLowerCase();
  const stem = file.slice(file.lastIndexOf("/") + 1, file.lastIndexOf("."));
  const identifier = stem.replace(/[^A-Za-z0-9]/g, "_") || "value";

  switch (extension) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
      return `// Written by the Nexestra fake harness for ${taskId}.\nexport const ${identifier} = ${JSON.stringify(taskId)};\n`;
    case ".json":
      return `${JSON.stringify({ generatedBy: "nexestra-fake-harness", taskId }, null, 2)}\n`;
    case ".md":
      return `# ${stem}\n\nWritten by the Nexestra fake harness for ${taskId}.\n`;
    case ".py":
      return `# Written by the Nexestra fake harness for ${taskId}.\n${identifier} = ${JSON.stringify(taskId)}\n`;
    default:
      return `Written by the Nexestra fake harness for ${taskId}.\n`;
  }
}

/* -------------------------------------------------------------- accounting */

/** Rough Opus-class pricing, so a fake run has a plausible non-zero cost. */
export const FAKE_INPUT_USD_PER_MTOK = 3;
export const FAKE_OUTPUT_USD_PER_MTOK = 15;

export function fakeCostUSD(inputTokens: number, outputTokens: number): number {
  const usd =
    (inputTokens * FAKE_INPUT_USD_PER_MTOK + outputTokens * FAKE_OUTPUT_USD_PER_MTOK) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

export function usageEvent(inputTokens: number, outputTokens: number): HarnessEvent {
  return {
    type: "usage",
    inputTokens,
    outputTokens,
    costUSD: fakeCostUSD(inputTokens, outputTokens),
  };
}

/* --------------------------------------------------------------------- ids */

/** `fake_task_a_execute_1` — stable across processes, unique per attempt. */
export function sessionRefFor(context: FakeRunContext): string {
  return `fake_${context.spec.taskId}_${context.spec.kind}_${context.attempt}`;
}

/* ---------------------------------------------------------------- findings */

export interface FakeReviewFinding {
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  body?: string;
  file?: string | null;
  line?: number | null;
}

export const DEFAULT_REVIEW_FINDINGS: readonly FakeReviewFinding[] = [
  {
    title: "The new module has no test",
    severity: "high",
    body: "Nothing exercises the file this task added, so the acceptance criterion cannot fail.",
  },
  {
    title: "Prefer a named export",
    severity: "low",
    body: "Style only; not blocking.",
  },
];

/* -------------------------------------------------------------- the scripts */

export interface ScenarioConfig {
  /** Milliseconds between events on a normal run. */
  readonly delayMs: number;
  /** Total wall-clock duration of the `slow` scenario. */
  readonly slowMs: number;
  /** Files a `success` run creates; already resolved from the instructions. */
  readonly files: Record<string, string>;
  /** Shell command the run reports having executed. */
  readonly command: string;
  readonly findings: readonly FakeReviewFinding[];
}

/** Turn one scenario plus one run into the script the scripted adapter replays. */
export function scenarioScript(
  scenario: FakeScenario,
  context: FakeRunContext,
  config: ScenarioConfig,
): FakeRunScript {
  switch (scenario) {
    case "success":
      return successScript(context, config);
    case "retryable_failure_then_success":
      return context.attempt === 1
        ? retryableScript(context, config)
        : successScript(context, config);
    case "fatal_failure":
      return fatalScript(context, config);
    case "permission_request":
      return permissionScript(context, config);
    case "slow":
      return slowScript(context, config);
    case "review_with_findings":
      return reviewScript(context, config, config.findings);
    case "review_clean":
      return reviewScript(context, config, []);
  }
}

function successScript(context: FakeRunContext, config: ScenarioConfig): FakeRunScript {
  const session = sessionRefFor(context);
  const paths = Object.keys(config.files);
  const events: HarnessEvent[] = [
    { type: "started", sessionRef: session },
    {
      type: "assistant_text",
      text: `Reading the workspace, then writing ${paths.join(", ") || "nothing"}.`,
    },
  ];

  paths.forEach((file, index) => {
    const callId = `${session}_call_${index + 1}`;
    events.push({
      type: "tool_call",
      name: "write_file",
      callId,
      input: { path: file, bytes: config.files[file]?.length ?? 0 },
    });
    events.push({ type: "tool_result", callId, ok: true, output: { path: file, written: true } });
    events.push({ type: "file_changed", path: file, kind: "add" });
  });

  events.push({
    type: "command",
    cmd: config.command,
    exitCode: 0,
    stdout: `${paths.length} file(s) written by the fake harness\n`,
  });
  events.push(usageEvent(1200 + paths.length * 100, 300 + paths.length * 20));
  events.push({
    type: "final",
    message: `Done. Wrote ${paths.length} file(s): ${paths.join(", ") || "none"}.`,
    structured: { files: paths, scenario: "success" },
  });
  events.push({ type: "ended", exitCode: 0 });

  return { files: config.files, events, delayMs: config.delayMs };
}

function retryableScript(context: FakeRunContext, config: ScenarioConfig): FakeRunScript {
  const session = sessionRefFor(context);
  return {
    delayMs: config.delayMs,
    events: [
      { type: "started", sessionRef: session },
      { type: "assistant_text", text: "Starting on the task." },
      {
        type: "command",
        cmd: config.command,
        exitCode: 1,
        stderr: "fake harness: the sandbox refused the write\n",
      },
      usageEvent(500, 60),
      {
        type: "error",
        message: "the sandbox refused the write (fake harness, attempt 1)",
        retryable: true,
      },
      { type: "ended", exitCode: 1 },
    ],
  };
}

function fatalScript(context: FakeRunContext, config: ScenarioConfig): FakeRunScript {
  return {
    delayMs: config.delayMs,
    events: [
      { type: "started", sessionRef: sessionRefFor(context) },
      { type: "assistant_text", text: "I cannot do this." },
      usageEvent(400, 40),
      {
        type: "error",
        message: "the model refused the task (fake harness)",
        retryable: false,
      },
      { type: "ended", exitCode: 1 },
    ],
  };
}

/**
 * Ask before writing, then wait. Approval writes the files and finishes;
 * rejection ends the run without them, which is what a blocked task looks like.
 */
function permissionScript(context: FakeRunContext, config: ScenarioConfig): FakeRunScript {
  const session = sessionRefFor(context);
  const requestId = `${session}_perm_1`;
  const paths = Object.keys(config.files);

  return {
    delayMs: config.delayMs,
    async *stream(ctx: FakeStreamContext): AsyncIterable<HarnessEvent> {
      yield { type: "started", sessionRef: session };
      yield {
        type: "assistant_text",
        text: "This task needs to write outside the sandbox. Asking first.",
      };
      yield {
        type: "permission_request",
        requestId,
        description: `Allow the fake harness to write ${paths.join(", ") || "a scratch file"} outside the workspace sandbox?`,
        risk: "high",
      };

      const approved = await ctx.awaitPermission(requestId);
      if (approved === undefined) return; // cancelled; the adapter emits the tail

      if (!approved) {
        yield usageEvent(600, 40);
        yield {
          type: "error",
          message: "permission denied by the user (fake harness)",
          retryable: false,
        };
        yield { type: "ended", exitCode: 1 };
        return;
      }

      await ctx.writeFiles(config.files);
      for (const file of paths) {
        yield { type: "file_changed", path: file, kind: "add" };
      }
      yield usageEvent(1300, 320);
      yield {
        type: "final",
        message: `Permission granted. Wrote ${paths.length} file(s).`,
        structured: { files: paths, scenario: "permission_request", approved: true },
      };
      yield { type: "ended", exitCode: 0 };
    },
  };
}

/** Streams progress for `slowMs`, and stops the moment it is cancelled. */
function slowScript(context: FakeRunContext, config: ScenarioConfig): FakeRunScript {
  const session = sessionRefFor(context);
  const steps = 5;
  const paths = Object.keys(config.files);

  return {
    async *stream(ctx: FakeStreamContext): AsyncIterable<HarnessEvent> {
      yield { type: "started", sessionRef: session };
      for (let step = 1; step <= steps; step += 1) {
        await ctx.sleep(Math.round(config.slowMs / steps));
        if (ctx.cancelled()) return;
        yield { type: "assistant_text", text: `step ${step} of ${steps}` };
      }
      await ctx.writeFiles(config.files);
      for (const file of paths) {
        yield { type: "file_changed", path: file, kind: "add" };
      }
      yield usageEvent(2000, 500);
      yield {
        type: "final",
        message: "Slow run finished.",
        structured: { files: paths, scenario: "slow" },
      };
      yield { type: "ended", exitCode: 0 };
    },
  };
}

function reviewScript(
  context: FakeRunContext,
  config: ScenarioConfig,
  findings: readonly FakeReviewFinding[],
): FakeRunScript {
  const structured = {
    summary: findings.length === 0 ? "No blocking issues found." : `${findings.length} findings.`,
    findings: findings.map((finding) => ({
      title: finding.title,
      severity: finding.severity,
      file: finding.file ?? null,
      line: finding.line ?? null,
      body: finding.body ?? finding.title,
    })),
  };

  return {
    delayMs: config.delayMs,
    events: [
      { type: "started", sessionRef: sessionRefFor(context) },
      { type: "assistant_text", text: "Reviewing the diff." },
      usageEvent(900, 150),
      { type: "final", message: JSON.stringify(structured), structured },
      { type: "ended", exitCode: 0 },
    ],
  };
}
