/**
 * Composing what a harness is actually told, and the `RunSpec` around it.
 *
 * Everything here is pure and deterministic so the prompt a task produces is
 * assertable in a test rather than "whatever the loop happened to build".
 */
import type { AcceptanceCriterion, RunKind, RunSpec, Spec, Task } from "@nexestra/core";
import type { ResolvedConfig } from "./config.js";
import type { ReviewFinding, VerificationOutcome } from "./types.js";

/** Criteria of the spec this task is answerable for. */
export function criteriaForTask(
  spec: Spec | null,
  task: Pick<Task, "acceptanceCriteriaIds">,
): AcceptanceCriterion[] {
  if (!spec) return [];
  const wanted = new Set(task.acceptanceCriteriaIds);
  return spec.acceptanceCriteria.filter((criterion) => wanted.has(criterion.id));
}

function renderVerification(criterion: AcceptanceCriterion): string {
  const verification = criterion.verification;
  switch (verification.kind) {
    case "command":
      return `verified by running \`${verification.command}\` (expected exit code ${verification.expectExitCode}${
        verification.expectStdoutMatch
          ? `, stdout matching /${verification.expectStdoutMatch}/`
          : ""
      })`;
    case "test":
      return `verified by running \`${verification.command}\`${
        verification.testPath ? ` (${verification.testPath})` : ""
      }`;
    case "manual_review":
      return `verified by human review: ${verification.instructions}`;
    default:
      return "verification unspecified";
  }
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trim()}\n`;
}

function bullets(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join("\n");
}

export interface FailureContext {
  /** 1-based number of the attempt that failed. */
  attempt: number;
  /** `error.message` from the run, or the verification summary. */
  reason: string;
  /** Trimmed stdout/stderr, diff excerpt — whatever helps the next attempt. */
  detail?: string;
}

export interface InstructionContext {
  task: Task;
  spec: Spec | null;
  criteria: readonly AcceptanceCriterion[];
  /** Failures of previous attempts, oldest first. */
  failures?: readonly FailureContext[];
  /** Blocking findings the reviewer raised on the previous attempt. */
  reviewFindings?: readonly ReviewFinding[];
  /** Verification outcomes of the previous attempt. */
  verification?: readonly VerificationOutcome[];
  /** Extra text from `dispatch(taskId, {instructions})`. */
  extra?: string;
}

/** The prompt for a `kind: "execute"` run. */
export function buildExecuteInstructions(context: InstructionContext): string {
  const { task, spec, criteria } = context;
  const parts: string[] = [
    `# Task: ${task.title}\n`,
    section("What to do", task.description || task.title),
  ];

  if (spec?.goal) parts.push(section("Goal of the thread", spec.goal));

  const constraints = spec?.constraints ?? [];
  if (constraints.length > 0) parts.push(section("Constraints", bullets(constraints)));

  if (spec && (spec.scope.in.length > 0 || spec.scope.out.length > 0)) {
    const lines: string[] = [];
    for (const item of spec.scope.in) lines.push(`in scope: ${item}`);
    for (const item of spec.scope.out) lines.push(`out of scope: ${item}`);
    parts.push(section("Scope", bullets(lines)));
  }

  if (criteria.length > 0) {
    parts.push(
      section(
        "Acceptance criteria",
        criteria
          .map(
            (criterion) => `${criterion.id}: ${criterion.text}\n  ${renderVerification(criterion)}`,
          )
          .map((line) => `- ${line}`)
          .join("\n"),
      ),
    );
    parts.push(
      section(
        "How this is checked",
        "Nexestra runs the verification of every criterion above itself, in this " +
          "worktree, after you finish. Your final message is not evidence — the exit " +
          "code is. Make the commands pass.",
      ),
    );
  }

  for (const failure of context.failures ?? []) {
    parts.push(
      section(
        `Attempt ${failure.attempt} failed`,
        `The previous attempt failed because: ${failure.reason}` +
          (failure.detail ? `\n\n\`\`\`\n${failure.detail.trim()}\n\`\`\`` : ""),
      ),
    );
  }

  const findings = context.reviewFindings ?? [];
  if (findings.length > 0) {
    parts.push(
      section(
        "Blocking review findings",
        `A reviewer running a different harness raised these. Address every one.\n\n${findings
          .map(
            (finding) =>
              `- [${finding.severity}] ${finding.title}` +
              (finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : "") +
              (finding.body ? `\n  ${finding.body.replaceAll("\n", "\n  ")}` : ""),
          )
          .join("\n")}`,
      ),
    );
  }

  const failed = (context.verification ?? []).filter((outcome) => !outcome.passed);
  if (failed.length > 0) {
    parts.push(
      section(
        "Failing verification",
        failed
          .map(
            (outcome) =>
              `- ${outcome.criterionId} (exit ${outcome.exitCode ?? "n/a"})` +
              (outcome.output ? `\n\`\`\`\n${outcome.output.trim()}\n\`\`\`` : ""),
          )
          .join("\n"),
      ),
    );
  }

  if (context.extra?.trim()) parts.push(section("Additional instructions", context.extra));

  parts.push(
    section(
      "Working agreement",
      "Work only inside this worktree. Do not commit — Nexestra commits and merges. " +
        "Do not touch the `.nexestra` directory.",
    ),
  );

  return parts.join("\n");
}

/** The prompt for a `kind: "review"` run, executed by a different harness. */
export function buildReviewInstructions(context: InstructionContext): string {
  const { task, criteria } = context;
  const parts: string[] = [
    `# Review: ${task.title}\n`,
    section(
      "What was asked for",
      `${task.description || task.title}\n\nThe uncommitted changes in this worktree are the ` +
        "attempt. You did not write them; another harness did.",
    ),
  ];

  if (criteria.length > 0) {
    parts.push(
      section(
        "Acceptance criteria",
        criteria
          .map(
            (criterion) =>
              `- ${criterion.id}: ${criterion.text}\n  ${renderVerification(criterion)}`,
          )
          .join("\n"),
      ),
    );
  }

  const constraints = context.spec?.constraints ?? [];
  if (constraints.length > 0) parts.push(section("Constraints", bullets(constraints)));

  parts.push(
    section(
      "What to report",
      "Report correctness bugs, missed acceptance criteria and violated constraints. " +
        "Use severity `critical` or `high` only for something that must change before " +
        "this can land; anything else is `medium`, `low` or `info`. Do not edit files.",
    ),
  );

  if (context.extra?.trim()) parts.push(section("Additional instructions", context.extra));
  return parts.join("\n");
}

/** Assemble the `RunSpec` a harness adapter is handed. */
export function buildRunSpec(options: {
  task: Task;
  kind: RunKind;
  cwd: string;
  instructions: string;
  config: ResolvedConfig;
  overrides?: {
    model?: string;
    reasoning?: RunSpec["reasoning"];
    sandbox?: RunSpec["sandbox"];
    tools?: string[];
    skills?: string[];
    timeoutMs?: number;
    budgetUSD?: number;
  };
}): RunSpec {
  const { task, overrides } = options;
  const harnessConfig = task.harnessConfig;
  const model = overrides?.model ?? harnessConfig.model;
  const budgetUSD = overrides?.budgetUSD ?? harnessConfig.budgetUSD;
  const tools = overrides?.tools ?? harnessConfig.tools;
  const skills = overrides?.skills ?? harnessConfig.skills;

  const spec: RunSpec = {
    taskId: task.id,
    kind: options.kind,
    cwd: options.cwd,
    instructions: options.instructions,
    ...(model ? { model } : {}),
    reasoning: overrides?.reasoning ?? harnessConfig.reasoning,
    // A review never needs to write, whatever the task asked for.
    sandbox:
      options.kind === "review" ? "read-only" : (overrides?.sandbox ?? harnessConfig.sandbox),
    ...(tools.length > 0 ? { tools: [...tools] } : {}),
    ...(harnessConfig.mcpServers.length > 0 ? { mcpServers: [...harnessConfig.mcpServers] } : {}),
    ...(skills.length > 0 ? { skills: [...skills] } : {}),
    timeoutMs: overrides?.timeoutMs ?? harnessConfig.timeoutMs ?? options.config.runTimeoutMs,
    ...(budgetUSD !== undefined ? { budgetUSD } : {}),
    ...(options.kind === "review" ? { reviewTarget: { mode: "uncommitted" as const } } : {}),
  };
  return spec;
}
