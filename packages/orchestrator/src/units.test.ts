/**
 * The pure pieces: ready-task selection, prompt composition, review
 * normalisation, the approval gate, pricing and the verification runner.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AcceptanceCriterion, Spec, Task } from "@nexestra/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateGate } from "./approvals.js";
import { addUsage, budgetState, priceUsage, ZERO_USAGE } from "./budget.js";
import { resolveConfig } from "./config.js";
import { selectReadyTasks } from "./engine.js";
import {
  buildExecuteInstructions,
  buildReviewInstructions,
  buildRunSpec,
  criteriaForTask,
} from "./instructions.js";
import { blockingFindings, extractReview } from "./review.js";
import { renderEvidence, runVerificationCommand, summariseEvidence } from "./verification.js";

const config = resolveConfig({ worktreeRoot: "/tmp/worktrees" });

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    workspaceId: "ws_1",
    threadId: "th_1",
    planId: "plan_1",
    title: "Add a CLI flag",
    description: "Add `--json` to the CLI",
    dependsOn: [],
    assignedHarness: "codex",
    harnessConfig: {
      reasoning: "medium",
      sandbox: "workspace-write",
      tools: [],
      skills: [],
      mcpServers: [],
      timeoutMs: 900_000,
    },
    status: "todo",
    attempts: 0,
    maxAttempts: 3,
    acceptanceCriteriaIds: [],
    costUSD: 0,
    order: 0,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...patch,
  } as Task;
}

const criterion: AcceptanceCriterion = {
  id: "ac_1",
  text: "`cli --json` prints JSON",
  verification: { kind: "command", command: "node cli.js --json", expectExitCode: 0 },
  satisfied: false,
};

function spec(patch: Partial<Spec> = {}): Spec {
  return {
    id: "spec_1",
    workspaceId: "ws_1",
    threadId: "th_1",
    version: 1,
    goal: "Ship a JSON mode",
    scope: { in: ["the CLI"], out: ["the web UI"] },
    constraints: ["No new dependencies"],
    expectedOutcome: "",
    acceptanceCriteria: [criterion],
    openQuestions: [],
    decisions: [],
    frozen: true,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...patch,
  } as Spec;
}

describe("selectReadyTasks", () => {
  it("only releases a task once every dependency is done", () => {
    const a = task({ id: "a", status: "running" });
    const b = task({ id: "b", dependsOn: ["a"] });
    const c = task({ id: "c" });
    expect(selectReadyTasks([a, b, c]).map((each) => each.id)).toEqual(["c"]);

    const done = task({ id: "a", status: "done" });
    expect(
      selectReadyTasks([done, b, c])
        .map((each) => each.id)
        .sort(),
    ).toEqual(["b", "c"]);
  });

  it("ignores tasks that already left todo/ready", () => {
    const statuses: Task["status"][] = [
      "running",
      "review",
      "verifying",
      "done",
      "failed",
      "blocked",
    ];
    for (const status of statuses) {
      expect(selectReadyTasks([task({ status })])).toHaveLength(0);
    }
  });

  it("returns tasks in board order", () => {
    const first = task({ id: "second", order: 1 });
    const second = task({ id: "first", order: 0 });
    expect(selectReadyTasks([first, second]).map((each) => each.id)).toEqual(["first", "second"]);
  });
});

describe("instructions", () => {
  it("carries the goal, constraints, scope and criteria into the execute prompt", () => {
    const text = buildExecuteInstructions({
      task: task({ acceptanceCriteriaIds: ["ac_1"] }),
      spec: spec(),
      criteria: [criterion],
    });
    expect(text).toContain("# Task: Add a CLI flag");
    expect(text).toContain("Ship a JSON mode");
    expect(text).toContain("No new dependencies");
    expect(text).toContain("in scope: the CLI");
    expect(text).toContain("out of scope: the web UI");
    expect(text).toContain("ac_1: `cli --json` prints JSON");
    expect(text).toContain("node cli.js --json");
    expect(text).toContain("Your final message is not evidence");
    expect(text).toContain("Do not commit");
  });

  it("appends the previous failure, the review findings and the failing verification", () => {
    const text = buildExecuteInstructions({
      task: task(),
      spec: spec(),
      criteria: [],
      failures: [{ attempt: 1, reason: "the test suite hung", detail: "timeout after 60s" }],
      reviewFindings: [
        {
          title: "SQL injection",
          severity: "critical",
          file: "db.ts",
          line: 12,
          body: "escape it",
        },
      ],
      verification: [
        { criterionId: "ac_1", passed: false, exitCode: 1, output: "1 test failed" },
        { criterionId: "ac_2", passed: true },
      ],
      extra: "focus on the parser",
    });
    expect(text).toContain("Attempt 1 failed");
    expect(text).toContain("The previous attempt failed because: the test suite hung");
    expect(text).toContain("timeout after 60s");
    expect(text).toContain("[critical] SQL injection (db.ts:12)");
    expect(text).toContain("ac_1 (exit 1)");
    expect(text).not.toContain("ac_2");
    expect(text).toContain("focus on the parser");
  });

  it("tells a reviewer not to edit and what counts as blocking", () => {
    const text = buildReviewInstructions({ task: task(), spec: spec(), criteria: [criterion] });
    expect(text).toContain("# Review: Add a CLI flag");
    expect(text).toContain("Do not edit files");
    expect(text).toContain("`critical` or `high`");
  });

  it("picks the criteria a task claims and no others", () => {
    const other: AcceptanceCriterion = { ...criterion, id: "ac_2" };
    const selected = criteriaForTask(spec({ acceptanceCriteria: [criterion, other] }), {
      acceptanceCriteriaIds: ["ac_2"],
    });
    expect(selected.map((each) => each.id)).toEqual(["ac_2"]);
    expect(criteriaForTask(null, { acceptanceCriteriaIds: ["ac_2"] })).toEqual([]);
  });
});

describe("buildRunSpec", () => {
  it("copies the harness config and forces a review to read-only", () => {
    const source = task({
      harnessConfig: {
        model: "gpt-5.1-codex",
        reasoning: "high",
        sandbox: "workspace-write",
        tools: ["shell"],
        skills: ["typescript"],
        mcpServers: [{ name: "github", transport: "stdio", args: [] }],
        timeoutMs: 60_000,
        budgetUSD: 3,
      },
    });

    const execute = buildRunSpec({
      task: source,
      kind: "execute",
      cwd: "/tmp/wt",
      instructions: "go",
      config,
    });
    expect(execute).toMatchObject({
      taskId: "task_1",
      kind: "execute",
      cwd: "/tmp/wt",
      model: "gpt-5.1-codex",
      reasoning: "high",
      sandbox: "workspace-write",
      tools: ["shell"],
      skills: ["typescript"],
      timeoutMs: 60_000,
      budgetUSD: 3,
    });
    expect(execute.mcpServers).toHaveLength(1);
    expect(execute.reviewTarget).toBeUndefined();

    const review = buildRunSpec({
      task: source,
      kind: "review",
      cwd: "/tmp/wt",
      instructions: "look",
      config,
    });
    expect(review.sandbox).toBe("read-only");
    expect(review.reviewTarget).toEqual({ mode: "uncommitted" });
  });

  it("lets a dispatch override the model, reasoning and sandbox", () => {
    const built = buildRunSpec({
      task: task(),
      kind: "execute",
      cwd: "/tmp/wt",
      instructions: "go",
      config,
      overrides: { model: "other", reasoning: "low", sandbox: "read-only", timeoutMs: 1000 },
    });
    expect(built).toMatchObject({
      model: "other",
      reasoning: "low",
      sandbox: "read-only",
      timeoutMs: 1000,
    });
  });
});

describe("review normalisation", () => {
  it("reads structured findings", () => {
    const result = extractReview({
      message: "{}",
      structured: {
        reviewSummary: "two problems",
        findings: [
          { title: "a", severity: "critical", file: "x.ts", line: 3, body: "bad" },
          { title: "b", severity: "nit", file: null, line: null, body: "" },
        ],
      },
    });
    expect(result.summary).toBe("two problems");
    expect(result.findings).toHaveLength(2);
    expect(result.findings[1]?.severity).toBe("info");
    expect(result.blocking.map((each) => each.title)).toEqual(["a"]);
  });

  it("falls back to JSON in the final message, then to prose", () => {
    const json = extractReview({
      message: JSON.stringify({ summary: "s", findings: [{ title: "t", severity: "high" }] }),
    });
    expect(json.blocking).toHaveLength(1);

    const prose = extractReview({ message: "Looks fine to me." });
    expect(prose.findings).toHaveLength(0);
    expect(prose.summary).toBe("Looks fine to me.");
  });

  it("maps loose severity words onto the enum", () => {
    const result = extractReview({
      message: JSON.stringify([
        { title: "a", severity: "blocker" },
        { title: "b", severity: "warning" },
        { title: "c" },
      ]),
    });
    expect(result.findings.map((each) => each.severity)).toEqual(["critical", "medium", "info"]);
    expect(blockingFindings(result.findings)).toHaveLength(1);
  });
});

describe("the approval gate", () => {
  const harnessConfig = { sandbox: "workspace-write" } as const;

  it("lets a workspace-write run through", () => {
    expect(
      evaluateGate({ sandbox: "workspace-write" }, harnessConfig, {
        allowedMcpServers: [],
        allowedTools: undefined,
      }).allowed,
    ).toBe(true);
  });

  it("stops danger-full-access", () => {
    const decision = evaluateGate({ sandbox: "danger-full-access" }, harnessConfig, {
      allowedMcpServers: [],
      allowedTools: undefined,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.kind).toBe("sandbox_escalation");
    expect(decision.risk).toBe("high");
  });

  it("stops an MCP server that is not allow-listed, and lets a listed one through", () => {
    const mcpServers = [{ name: "github", transport: "stdio" as const, args: [] }];
    expect(
      evaluateGate({ sandbox: "workspace-write", mcpServers }, harnessConfig, {
        allowedMcpServers: [],
        allowedTools: undefined,
      }).allowed,
    ).toBe(false);
    expect(
      evaluateGate({ sandbox: "workspace-write", mcpServers }, harnessConfig, {
        allowedMcpServers: ["github"],
        allowedTools: undefined,
      }).allowed,
    ).toBe(true);
  });

  it("only checks tools when an allow-list is configured", () => {
    const tools = ["shell"];
    expect(
      evaluateGate({ sandbox: "workspace-write", tools }, harnessConfig, {
        allowedMcpServers: [],
        allowedTools: undefined,
      }).allowed,
    ).toBe(true);
    expect(
      evaluateGate({ sandbox: "workspace-write", tools }, harnessConfig, {
        allowedMcpServers: [],
        allowedTools: ["read"],
      }).allowed,
    ).toBe(false);
  });
});

describe("pricing", () => {
  it("prefers the harness' own number", () => {
    expect(
      priceUsage({ type: "usage", inputTokens: 1000, outputTokens: 10, costUSD: 7 }, "m", {
        m: { inputPerMTok: 5, outputPerMTok: 25 },
      }),
    ).toBe(7);
  });

  it("prices tokens from the table and charges nothing for an unknown model", () => {
    const table = { "gpt-5.1-codex": { inputPerMTok: 5, outputPerMTok: 25 } };
    expect(
      priceUsage(
        { type: "usage", inputTokens: 1_000_000, outputTokens: 100_000 },
        "gpt-5.1-codex",
        table,
      ),
    ).toBeCloseTo(7.5, 6);
    expect(
      priceUsage({ type: "usage", inputTokens: 1_000_000, outputTokens: 0 }, "who?", table),
    ).toBe(0);
    expect(
      priceUsage({ type: "usage", inputTokens: 1_000_000, outputTokens: 0 }, undefined, table),
    ).toBe(0);
  });

  it("accumulates and reports the budget level", () => {
    const total = addUsage(ZERO_USAGE, { type: "usage", inputTokens: 10, outputTokens: 2 }, 0.5);
    expect(total).toMatchObject({ inputTokens: 10, outputTokens: 2, costUSD: 0.5 });

    expect(budgetState(0.5, 10, 0.8).level).toBe("ok");
    expect(budgetState(8, 10, 0.8).level).toBe("warning");
    expect(budgetState(10, 10, 0.8).level).toBe("exceeded");
    // No budget means the loop is never blocked on money.
    expect(budgetState(1000, 0, 0.8).level).toBe("ok");
  });
});

describe("running a verification", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "nexestra-verify-"));
    await writeFile(path.join(dir, "present.txt"), "hello\n", "utf8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes on the expected exit code and captures the output", async () => {
    const evidence = await runVerificationCommand({
      verification: {
        kind: "command",
        command: "echo ok && test -f present.txt",
        expectExitCode: 0,
      },
      cwd: dir,
      timeoutMs: 10_000,
    });
    expect(evidence.passed).toBe(true);
    expect(evidence.exitCode).toBe(0);
    expect(evidence.stdout).toContain("ok");
    expect(renderEvidence(criterion, evidence, dir)).toContain("result: PASS");
  });

  it("fails on the wrong exit code and says so", async () => {
    const evidence = await runVerificationCommand({
      verification: { kind: "command", command: "test -f missing.txt", expectExitCode: 0 },
      cwd: dir,
      timeoutMs: 10_000,
    });
    expect(evidence.passed).toBe(false);
    expect(evidence.reason).toContain("exit code 1");
    expect(summariseEvidence(evidence)).toContain("$ test -f missing.txt");
  });

  it("honours a non-zero expected exit code", async () => {
    const evidence = await runVerificationCommand({
      verification: { kind: "command", command: "exit 3", expectExitCode: 3 },
      cwd: dir,
      timeoutMs: 10_000,
    });
    expect(evidence.passed).toBe(true);
  });

  it("checks expectStdoutMatch", async () => {
    const ok = await runVerificationCommand({
      verification: {
        kind: "command",
        command: "echo version 1.2.3",
        expectExitCode: 0,
        expectStdoutMatch: "version \\d+\\.\\d+",
      },
      cwd: dir,
      timeoutMs: 10_000,
    });
    expect(ok.passed).toBe(true);

    const bad = await runVerificationCommand({
      verification: {
        kind: "command",
        command: "echo nope",
        expectExitCode: 0,
        expectStdoutMatch: "version",
      },
      cwd: dir,
      timeoutMs: 10_000,
    });
    expect(bad.passed).toBe(false);
    expect(bad.reason).toContain("stdout does not match");
  });

  it("appends testPath for a test verification", async () => {
    const evidence = await runVerificationCommand({
      verification: { kind: "test", command: "echo", testPath: "spec/foo.test.ts" },
      cwd: dir,
      timeoutMs: 10_000,
    });
    expect(evidence.command).toBe("echo spec/foo.test.ts");
    expect(evidence.stdout).toContain("spec/foo.test.ts");
  });

  it("fails a command that outlives its timeout", async () => {
    const evidence = await runVerificationCommand({
      verification: { kind: "command", command: "sleep 5", expectExitCode: 0 },
      cwd: dir,
      timeoutMs: 150,
    });
    expect(evidence.passed).toBe(false);
    expect(evidence.reason).toContain("timed out");
  });
});

describe("resolveConfig", () => {
  it("fills in the documented defaults", () => {
    const resolved = resolveConfig({ worktreeRoot: "/tmp/wt" });
    expect(resolved).toMatchObject({
      concurrency: 2,
      maxAttempts: 3,
      reviewEnabled: true,
      verifyEnabled: true,
      autoMerge: false,
    });
  });

  it("refuses to run without a worktree root", () => {
    expect(() => resolveConfig({ worktreeRoot: "  " })).toThrow(TypeError);
  });
});
