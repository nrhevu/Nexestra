/**
 * Running an acceptance criterion (PLAN.md §9: "verification is a command run
 * by the orchestrator in the worktree, not something the harness claims").
 *
 * Nothing here trusts a harness. The evidence is the exit code, the stdout and
 * the stderr of a process this package spawned, captured verbatim.
 */
import type { AcceptanceCriterion, Verification } from "@nexestra/core";
import { execa } from "execa";

export interface CommandEvidence {
  command: string;
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  passed: boolean;
  /** Why it failed, when it did. */
  reason?: string;
}

const MAX_CAPTURE = 200_000;

function clip(value: string): string {
  return value.length > MAX_CAPTURE
    ? `${value.slice(0, MAX_CAPTURE)}\n… output truncated at ${MAX_CAPTURE} characters\n`
    : value;
}

/**
 * Run one `command` / `test` verification.
 *
 * The command goes through a shell because acceptance criteria are written as
 * shell one-liners (`pnpm test -- foo && node dist/cli.js --help`), not argv
 * arrays. It runs with the worktree as cwd and a hard timeout.
 */
export async function runVerificationCommand(options: {
  verification: Extract<Verification, { kind: "command" | "test" }>;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<CommandEvidence> {
  const { verification } = options;
  const command =
    verification.kind === "test" && verification.testPath
      ? `${verification.command} ${verification.testPath}`
      : verification.command;

  const startedAt = Date.now();
  const subprocess = execa(command, {
    shell: true,
    cwd: options.cwd,
    reject: false,
    stdin: "ignore",
    all: false,
    // A shell can spawn grandchildren that keep stdout/stderr open after the
    // shell itself dies. Give the command its own process group so a hard
    // timeout terminates the complete verification tree, not just `/bin/sh`.
    detached: process.platform !== "win32",
    ...(options.signal ? { cancelSignal: options.signal } : {}),
    env: { ...options.env, CI: "1", NEXESTRA_VERIFICATION: "1" },
  });

  let deadlineExpired = false;
  const terminateTree = () => {
    const pid = subprocess.pid;
    if (!pid) return;
    try {
      if (process.platform === "win32") subprocess.kill("SIGKILL");
      else process.kill(-pid, "SIGKILL");
    } catch {
      // The command won the race and already exited.
    }
  };
  const timeout = setTimeout(() => {
    deadlineExpired = true;
    terminateTree();
  }, options.timeoutMs);
  timeout.unref();
  options.signal?.addEventListener("abort", terminateTree, { once: true });

  const result = await subprocess.finally(() => {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", terminateTree);
  });

  const durationMs = Date.now() - startedAt;
  const stdout = clip(typeof result.stdout === "string" ? result.stdout : "");
  const stderr = clip(typeof result.stderr === "string" ? result.stderr : "");
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : undefined;
  const timedOut = deadlineExpired || result.timedOut === true;

  const expected = verification.kind === "command" ? verification.expectExitCode : 0;
  let passed = !timedOut && exitCode === expected;
  let reason: string | undefined;
  if (timedOut) reason = `timed out after ${options.timeoutMs}ms`;
  else if (exitCode !== expected)
    reason = `exit code ${exitCode ?? "unknown"}, expected ${expected}`;

  if (passed && verification.kind === "command" && verification.expectStdoutMatch) {
    const pattern = safeRegExp(verification.expectStdoutMatch);
    if (!pattern) {
      passed = false;
      reason = `expectStdoutMatch "${verification.expectStdoutMatch}" is not a valid regular expression`;
    } else if (!pattern.test(stdout)) {
      passed = false;
      reason = `stdout does not match /${verification.expectStdoutMatch}/`;
    }
  }

  return {
    command,
    exitCode,
    stdout,
    stderr,
    durationMs,
    timedOut,
    passed,
    ...(reason ? { reason } : {}),
  };
}

function safeRegExp(source: string): RegExp | undefined {
  try {
    return new RegExp(source);
  } catch {
    return undefined;
  }
}

/** The text written into the evidence artifact. Stable, so tests can assert it. */
export function renderEvidence(
  criterion: AcceptanceCriterion,
  evidence: CommandEvidence,
  cwd: string,
): string {
  return [
    `criterion: ${criterion.id}`,
    `text: ${criterion.text}`,
    `kind: ${criterion.verification.kind}`,
    `cwd: ${cwd}`,
    `command: ${evidence.command}`,
    `exit code: ${evidence.exitCode ?? "unknown"}`,
    `duration: ${evidence.durationMs}ms`,
    `result: ${evidence.passed ? "PASS" : "FAIL"}`,
    ...(evidence.reason ? [`reason: ${evidence.reason}`] : []),
    "",
    "--- stdout ---",
    evidence.stdout,
    "--- stderr ---",
    evidence.stderr,
    "",
  ].join("\n");
}

/** A short line for `VerificationOutcome.output`, which the Master reads. */
export function summariseEvidence(evidence: CommandEvidence): string {
  const tail = (evidence.stderr.trim() || evidence.stdout.trim()).split("\n").slice(-20).join("\n");
  return [
    `$ ${evidence.command}`,
    `exit ${evidence.exitCode ?? "unknown"}${evidence.reason ? ` — ${evidence.reason}` : ""}`,
    tail,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
