/**
 * The M5 acceptance criteria, end to end against `FakeHarnessAdapter`:
 * a three-task DAG, retry, cross-review, verification, approvals, budget,
 * recovery and cancellation.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessEvent } from "@nexestra/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakeHarnessAdapter,
  type FakeRunScript,
  fatalFailure,
  retryableFailure,
  reviewFindings,
  writesFiles,
} from "./fake-adapter.js";
import { createOrchestrator } from "./orchestrator.js";
import {
  commandCriterion,
  createTestBed,
  manualCriterion,
  type TestBed,
  waitFor,
} from "./test-support.js";
import type { OrchestratorEvent, ReplanEvidence } from "./types.js";

let bed: TestBed | undefined;

afterEach(async () => {
  await bed?.cleanup();
  bed = undefined;
});

function recorder() {
  const events: OrchestratorEvent[] = [];
  const replans: { taskId: string; reason: string; evidence: ReplanEvidence }[] = [];
  return {
    events,
    replans,
    bridge: {
      notify(event: OrchestratorEvent) {
        events.push(event);
      },
      requestReplan(taskId: string, reason: string, evidence: ReplanEvidence) {
        replans.push({ taskId, reason, evidence });
      },
    },
  };
}

const usage: HarnessEvent = { type: "usage", inputTokens: 90_000, outputTokens: 0 };

describe("the scheduler", () => {
  it("runs a three-task DAG in dependency order, two at a time", async () => {
    bed = await createTestBed();
    const a = bed.addTask({ id: "task_a", title: "A" });
    const b = bed.addTask({ id: "task_b", title: "B", dependsOn: [a.id] });
    const c = bed.addTask({ id: "task_c", title: "C", dependsOn: [a.id] });
    bed.addTask({ id: "task_d", title: "D", dependsOn: [b.id, c.id] });

    const adapter = createFakeHarnessAdapter({
      script: ({ spec }) => writesFiles({ [`${spec.taskId}.txt`]: spec.taskId }),
      defaultScript: { delayMs: 5 },
    });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: {
        worktreeRoot: bed.worktreeRoot,
        concurrency: 2,
        reviewEnabled: false,
        verifyEnabled: false,
      },
    });

    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    const order = adapter.calls.map((call) => call.taskId);
    expect(order[0]).toBe("task_a");
    expect(order.at(-1)).toBe("task_d");
    expect(order.slice(1, 3).sort()).toEqual(["task_b", "task_c"]);
    expect(adapter.maxConcurrent).toBeLessThanOrEqual(2);

    const tasks = bed.store.listTasks(bed.thread.id);
    expect(tasks.map((task) => task.status)).toEqual(["done", "done", "done", "done"]);
    expect(bed.store.listRuns(bed.thread.id)).toHaveLength(4);

    // Every task got its own worktree on its own branch.
    for (const task of tasks) {
      expect(existsSync(path.join(bed.worktreeRoot, bed.thread.id, task.id))).toBe(true);
    }
    const branches = await bed.git("branch", "--format=%(refname:short)");
    expect(branches).toContain(`nexestra/${bed.thread.id}/task_a`);

    const status = orchestrator.status(bed.thread.id);
    expect(status.lastOutcome).toBe("completed");
    expect(status.tasks.done).toBe(4);
    await orchestrator.close();
  });

  it("honours the concurrency limit when four tasks are ready at once", async () => {
    bed = await createTestBed();
    for (const title of ["A", "B", "C", "D"]) bed.addTask({ title });

    const adapter = createFakeHarnessAdapter({
      script: () => ({ delayMs: 15, events: undefined }),
    });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: {
        worktreeRoot: bed.worktreeRoot,
        concurrency: 2,
        reviewEnabled: false,
        verifyEnabled: false,
      },
    });

    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    expect(adapter.calls).toHaveLength(4);
    expect(adapter.maxConcurrent).toBe(2);
    await orchestrator.close();
  });
});

describe("retry", () => {
  it("retries a retryable failure and tells the next attempt why", async () => {
    bed = await createTestBed();
    bed.addTask({ id: "task_a", title: "A" });

    const adapter = createFakeHarnessAdapter({
      script: ({ attempt }) =>
        attempt === 1
          ? retryableFailure("the sandbox denied the write")
          : writesFiles({ "hello.txt": "hello\n" }),
    });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: {
        worktreeRoot: bed.worktreeRoot,
        reviewEnabled: false,
        verifyEnabled: false,
      },
    });

    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.instructions).toContain("Attempt 1 failed");
    expect(adapter.calls[1]?.instructions).toContain("the sandbox denied the write");

    const task = bed.store.getTask("task_a");
    expect(task?.status).toBe("done");
    expect(task?.attempts).toBe(2);

    const runs = bed.store.listRuns(bed.thread.id);
    expect(runs.map((run) => run.status)).toEqual(["failed", "succeeded"]);
    await orchestrator.close();
  });

  it("stops at maxAttempts and asks the Master to replan", async () => {
    bed = await createTestBed();
    bed.addTask({ id: "task_a", title: "A", maxAttempts: 2 });
    const master = recorder();

    const adapter = createFakeHarnessAdapter({ script: () => retryableFailure("still broken") });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      master: master.bridge,
      config: { worktreeRoot: bed.worktreeRoot, reviewEnabled: false, verifyEnabled: false },
    });

    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    expect(adapter.calls).toHaveLength(2);
    expect(bed.store.getTask("task_a")?.status).toBe("failed");
    expect(master.replans).toHaveLength(1);
    expect(master.replans[0]?.taskId).toBe("task_a");
    expect(master.replans[0]?.evidence.runIds).toHaveLength(2);
    expect(master.replans[0]?.evidence.artifactIds.length).toBeGreaterThan(0);
    expect(orchestrator.status(bed.thread.id).lastOutcome).toBe("failed");
    await orchestrator.close();
  });

  it("does not retry a non-retryable failure", async () => {
    bed = await createTestBed();
    bed.addTask({ id: "task_a", title: "A" });
    const master = recorder();

    const adapter = createFakeHarnessAdapter({ script: () => fatalFailure("model refused") });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      master: master.bridge,
      config: { worktreeRoot: bed.worktreeRoot, reviewEnabled: false, verifyEnabled: false },
    });

    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    expect(adapter.calls).toHaveLength(1);
    expect(bed.store.getTask("task_a")?.status).toBe("failed");
    expect(master.replans[0]?.reason).toContain("model refused");
    await orchestrator.close();
  });
});

describe("cross-review", () => {
  it("reviews with a different harness and bounces blocking findings back", async () => {
    bed = await createTestBed();
    bed.addTask({ id: "task_a", title: "A", harness: "codex" });
    const master = recorder();

    const executor = createFakeHarnessAdapter({
      id: "codex",
      script: ({ attempt }) => writesFiles({ "hello.txt": `attempt ${attempt}\n` }),
    });
    const reviewer = createFakeHarnessAdapter({
      id: "opencode",
      script: ({ attempt }) =>
        attempt === 1
          ? reviewFindings([{ title: "hello.txt is empty", severity: "critical" }])
          : reviewFindings([{ title: "nit: trailing newline", severity: "low" }]),
    });

    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: executor, opencode: reviewer },
      master: master.bridge,
      config: { worktreeRoot: bed.worktreeRoot, verifyEnabled: false },
    });

    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    expect(executor.calls).toHaveLength(2);
    expect(reviewer.calls).toHaveLength(2);
    expect(reviewer.calls[0]?.kind).toBe("review");
    // A review never needs write access.
    expect(reviewer.calls[0]?.sandbox).toBe("read-only");
    expect(executor.calls[1]?.instructions).toContain("Blocking review findings");
    expect(executor.calls[1]?.instructions).toContain("hello.txt is empty");

    expect(bed.store.getTask("task_a")?.status).toBe("done");
    const artifacts = bed.store.listArtifacts(bed.thread.id);
    expect(artifacts.some((artifact) => artifact.kind === "review")).toBe(true);
    expect(artifacts.some((artifact) => artifact.kind === "diff")).toBe(true);

    const found = master.events.filter((event) => event.type === "review_findings");
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ blocking: 1 });
    await orchestrator.close();
  });

  it("skips review when only one harness is registered", async () => {
    bed = await createTestBed();
    bed.addTask({ id: "task_a", title: "A" });

    const adapter = createFakeHarnessAdapter({ script: () => writesFiles({ "a.txt": "a" }) });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: { worktreeRoot: bed.worktreeRoot, verifyEnabled: false },
    });

    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    expect(adapter.calls.every((call) => call.kind === "execute")).toBe(true);
    expect(bed.store.getTask("task_a")?.status).toBe("done");
    await orchestrator.close();
  });
});

describe("verification", () => {
  it("retries a failing acceptance criterion and records evidence for both runs", async () => {
    bed = await createTestBed({
      criteria: [commandCriterion("ac_1", "test -f hello.txt", "hello.txt exists")],
    });
    bed.addTask({ id: "task_a", title: "A", criteria: ["ac_1"] });

    const adapter = createFakeHarnessAdapter({
      script: ({ attempt }) =>
        attempt === 1
          ? writesFiles({ "other.txt": "wrong file\n" })
          : writesFiles({ "hello.txt": "hello\n" }),
    });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: { worktreeRoot: bed.worktreeRoot, reviewEnabled: false },
    });

    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.instructions).toContain("Failing verification");
    expect(adapter.calls[1]?.instructions).toContain("ac_1");
    expect(bed.store.getTask("task_a")?.status).toBe("done");

    const evidence = bed.store
      .listArtifacts(bed.thread.id)
      .filter((artifact) => artifact.title.startsWith("Verification"));
    expect(evidence).toHaveLength(2);
    expect(evidence[0]?.title).toContain("fail");
    expect(evidence[1]?.title).toContain("pass");
    expect(evidence[1]?.preview).toContain("result: PASS");

    // The evidence bytes really are on disk where the API reads them from.
    const bytes = await readFile(path.join(bed.store.dataDir, evidence[1]?.path ?? ""), "utf8");
    expect(bytes).toContain("command: test -f hello.txt");

    const spec = bed.store.getSpec(bed.thread.id);
    expect(spec?.acceptanceCriteria[0]?.satisfied).toBe(true);
    expect(spec?.acceptanceCriteria[0]?.evidenceArtifactId).toBe(evidence[1]?.id);
    await orchestrator.close();
  });

  it("raises a manual_verification approval for a manual criterion", async () => {
    bed = await createTestBed({ criteria: [manualCriterion("ac_m", "Look at the screenshot")] });
    bed.addTask({ id: "task_a", title: "A", criteria: ["ac_m"] });

    const adapter = createFakeHarnessAdapter({ script: () => writesFiles({ "a.txt": "a" }) });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: { worktreeRoot: bed.worktreeRoot, reviewEnabled: false },
    });

    await orchestrator.start(bed.thread.id);

    const store = bed.store;
    const threadId = bed.thread.id;
    await waitFor(
      () =>
        store
          .listApprovals({ threadId, status: "pending" })
          .some((approval) => approval.kind === "manual_verification"),
      5000,
      "manual verification approval",
    );
    const approval = store
      .listApprovals({ threadId, status: "pending" })
      .find((each) => each.kind === "manual_verification");
    store.resolveApproval(approval?.id ?? "", { status: "approved", resolvedBy: "tester" });

    await orchestrator.drain(threadId);
    expect(store.getTask("task_a")?.status).toBe("done");
    expect(store.getSpec(threadId)?.acceptanceCriteria[0]?.satisfied).toBe(true);
    await orchestrator.close();
  });

  it("runs verification on demand through the ExecutionHost", async () => {
    bed = await createTestBed({
      criteria: [commandCriterion("ac_1", "test -f README.md", "README exists")],
    });
    bed.addTask({ id: "task_a", title: "A", criteria: ["ac_1"] });

    const adapter = createFakeHarnessAdapter({ script: () => writesFiles({ "a.txt": "a" }) });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: { worktreeRoot: bed.worktreeRoot, reviewEnabled: false, verifyEnabled: false },
    });

    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    const result = await orchestrator.host.runVerification({ taskId: "task_a" });
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]?.passed).toBe(true);
    expect(result.outcomes[0]?.evidenceArtifactId).toBeTruthy();

    const artifact = await orchestrator.host.readArtifact({
      artifactId: result.outcomes[0]?.evidenceArtifactId ?? "",
    });
    expect(artifact.content).toContain("result: PASS");
    await orchestrator.close();
  });
});

describe("approval gates", () => {
  it("blocks a danger-full-access run until it is approved", async () => {
    bed = await createTestBed();
    bed.addTask({ id: "task_a", title: "A", sandbox: "danger-full-access" });
    const master = recorder();

    const adapter = createFakeHarnessAdapter({ script: () => writesFiles({ "a.txt": "a" }) });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      master: master.bridge,
      config: { worktreeRoot: bed.worktreeRoot, reviewEnabled: false, verifyEnabled: false },
    });

    const store = bed.store;
    const threadId = bed.thread.id;
    await orchestrator.start(threadId);
    await waitFor(
      () => store.listApprovals({ threadId, status: "pending" }).length === 1,
      5000,
      "sandbox approval",
    );

    // Nothing has been spawned while the approval is pending.
    expect(adapter.calls).toHaveLength(0);
    const approval = store.listApprovals({ threadId, status: "pending" })[0];
    expect(approval?.kind).toBe("sandbox_escalation");
    expect(approval?.risk).toBe("high");

    store.resolveApproval(approval?.id ?? "", { status: "approved" });
    await orchestrator.drain(threadId);

    expect(adapter.calls).toHaveLength(1);
    expect(store.getTask("task_a")?.status).toBe("done");
    await orchestrator.close();
  });

  it("blocks the task when the approval is rejected", async () => {
    bed = await createTestBed();
    bed.addTask({ id: "task_a", title: "A", sandbox: "danger-full-access" });

    const adapter = createFakeHarnessAdapter({ script: () => writesFiles({ "a.txt": "a" }) });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: { worktreeRoot: bed.worktreeRoot, reviewEnabled: false, verifyEnabled: false },
    });

    const store = bed.store;
    const threadId = bed.thread.id;
    await orchestrator.start(threadId);
    await waitFor(() => store.listApprovals({ threadId, status: "pending" }).length === 1);
    const approval = store.listApprovals({ threadId, status: "pending" })[0];
    store.resolveApproval(approval?.id ?? "", { status: "rejected" });
    await orchestrator.drain(threadId);

    expect(adapter.calls).toHaveLength(0);
    expect(store.getTask("task_a")?.status).toBe("blocked");
    expect(orchestrator.status(threadId).lastOutcome).toBe("blocked");
    await orchestrator.close();
  });

  it("gates MCP servers the workspace has not allow-listed", async () => {
    bed = await createTestBed();
    bed.addTask({
      id: "task_a",
      title: "A",
      mcpServers: [{ name: "github", transport: "stdio", args: [] }],
    });

    const adapter = createFakeHarnessAdapter({ script: () => writesFiles({ "a.txt": "a" }) });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: { worktreeRoot: bed.worktreeRoot, reviewEnabled: false, verifyEnabled: false },
    });

    const store = bed.store;
    const threadId = bed.thread.id;
    await orchestrator.start(threadId);
    await waitFor(() => store.listApprovals({ threadId, status: "pending" }).length === 1);
    const approval = store.listApprovals({ threadId, status: "pending" })[0];
    expect(approval?.kind).toBe("permission");
    expect(approval?.description).toContain("github");
    store.resolveApproval(approval?.id ?? "", { status: "approved" });
    await orchestrator.drain(threadId);
    expect(store.getTask("task_a")?.status).toBe("done");
    await orchestrator.close();
  });

  it("answers a mid-run permission request through an approval", async () => {
    bed = await createTestBed();
    bed.addTask({ id: "task_a", title: "A" });

    const script: FakeRunScript = {
      files: { "a.txt": "a" },
      delayMs: 5,
      events: [
        { type: "started", sessionRef: "s" },
        {
          type: "permission_request",
          requestId: "perm_1",
          description: "run `rm -rf build`",
          risk: "high",
        },
        { type: "final", message: "done" },
        { type: "ended", exitCode: 0 },
      ],
    };
    const adapter = createFakeHarnessAdapter({ script: () => script });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: { worktreeRoot: bed.worktreeRoot, reviewEnabled: false, verifyEnabled: false },
    });

    const store = bed.store;
    const threadId = bed.thread.id;
    await orchestrator.start(threadId);
    await waitFor(
      () =>
        store
          .listApprovals({ threadId, status: "pending" })
          .some((approval) => approval.kind === "permission"),
      5000,
      "permission approval",
    );
    const approval = store
      .listApprovals({ threadId, status: "pending" })
      .find((each) => each.kind === "permission");
    store.resolveApproval(approval?.id ?? "", { status: "approved" });

    await orchestrator.drain(threadId);
    expect(adapter.answers.get("perm_1")).toBe(true);
    expect(store.getTask("task_a")?.status).toBe("done");
    await orchestrator.close();
  });
});

describe("budget", () => {
  it("raises a spend approval at 80% and pauses the thread at 100%", async () => {
    bed = await createTestBed({ budgetUSD: 1 });
    for (const title of ["A", "B", "C", "D"]) bed.addTask({ title });
    const master = recorder();

    // 90k input tokens at $5/MTok = $0.45 per run.
    const adapter = createFakeHarnessAdapter({
      script: () => ({
        events: [
          { type: "started", sessionRef: "s" },
          usage,
          { type: "final", message: "done" },
          { type: "ended", exitCode: 0 },
        ],
      }),
    });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      master: master.bridge,
      config: {
        worktreeRoot: bed.worktreeRoot,
        concurrency: 1,
        reviewEnabled: false,
        verifyEnabled: false,
        priceTable: { "fake-model": { inputPerMTok: 5, outputPerMTok: 25 } },
      },
    });

    // The tasks carry no model, so give the price table something to match.
    for (const task of bed.store.listTasks(bed.thread.id)) {
      bed.store.updateTask(task.id, { harnessConfig: { model: "fake-model" } });
    }

    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    const status = orchestrator.status(bed.thread.id);
    expect(status.state).toBe("paused");
    expect(status.costUSD).toBeCloseTo(1.35, 5);
    expect(adapter.calls).toHaveLength(3);

    const spend = bed.store
      .listApprovals({ threadId: bed.thread.id })
      .filter((approval) => approval.kind === "spend");
    expect(spend).toHaveLength(1);
    expect(master.events.some((event) => event.type === "budget_warning")).toBe(true);
    expect(master.events.some((event) => event.type === "budget_exceeded")).toBe(true);

    // The unstarted task is still schedulable once the user raises the budget.
    expect(
      bed.store.listTasks(bed.thread.id).filter((task) => task.status === "done"),
    ).toHaveLength(3);
    await orchestrator.close();
  });

  it("accumulates cost onto the run, the task and the thread", async () => {
    bed = await createTestBed({ budgetUSD: 100 });
    bed.addTask({ id: "task_a", title: "A" });

    const adapter = createFakeHarnessAdapter({
      script: () => ({
        events: [
          { type: "started", sessionRef: "s" },
          { type: "usage", inputTokens: 0, outputTokens: 0, costUSD: 0.25 },
          { type: "final", message: "done" },
          { type: "ended", exitCode: 0 },
        ],
      }),
    });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: { worktreeRoot: bed.worktreeRoot, reviewEnabled: false, verifyEnabled: false },
    });

    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    expect(bed.store.listRuns(bed.thread.id)[0]?.usage.costUSD).toBeCloseTo(0.25, 5);
    expect(bed.store.getTask("task_a")?.costUSD).toBeCloseTo(0.25, 5);
    expect(bed.store.getThread(bed.thread.id)?.costUSD).toBeCloseTo(0.25, 5);
    await orchestrator.close();
  });
});

describe("merge", () => {
  it("fast-forwards the task branch into the base branch when autoMerge is on", async () => {
    bed = await createTestBed();
    bed.addTask({ id: "task_a", title: "A" });

    const adapter = createFakeHarnessAdapter({
      script: () => writesFiles({ "hello.txt": "hello\n" }),
    });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: {
        worktreeRoot: bed.worktreeRoot,
        reviewEnabled: false,
        verifyEnabled: false,
        autoMerge: true,
      },
    });

    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    const task = bed.store.getTask("task_a");
    expect(task?.status).toBe("done");
    expect(task?.mergeState).toBe("merged");
    expect(existsSync(path.join(bed.repo, "hello.txt"))).toBe(true);
    await orchestrator.close();
  });

  it("creates a merge approval and marks the task done-pending-merge otherwise", async () => {
    bed = await createTestBed();
    bed.addTask({ id: "task_a", title: "A" });

    const adapter = createFakeHarnessAdapter({
      script: () => writesFiles({ "hello.txt": "hello\n" }),
    });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: { worktreeRoot: bed.worktreeRoot, reviewEnabled: false, verifyEnabled: false },
    });

    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    const task = bed.store.getTask("task_a");
    expect(task?.status).toBe("done");
    expect(task?.mergeState).toBe("pending");
    expect(existsSync(path.join(bed.repo, "hello.txt"))).toBe(false);

    const merge = bed.store
      .listApprovals({ threadId: bed.thread.id })
      .find((approval) => approval.kind === "merge");
    expect(merge?.title).toContain(`nexestra/${bed.thread.id}/task_a`);
    await orchestrator.close();
  });

  it("raises a merge approval when the branches conflict", async () => {
    bed = await createTestBed();
    bed.addTask({ id: "task_a", title: "A" });

    const scratch = bed;
    const adapter = createFakeHarnessAdapter({
      script: () => ({
        ...writesFiles({ "conflict.txt": "from the harness\n" }),
        // The base branch grows its own version of the same file *after* the
        // task branch was cut, which is the only way to get a real conflict.
        before: async () => {
          await writeFile(path.join(scratch.repo, "conflict.txt"), "from main\n", "utf8");
          await scratch.git("add", "-A");
          await scratch.git("commit", "-q", "-m", "conflicting change");
        },
      }),
    });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: {
        worktreeRoot: bed.worktreeRoot,
        reviewEnabled: false,
        verifyEnabled: false,
        autoMerge: true,
      },
    });

    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    const task = bed.store.getTask("task_a");
    expect(task?.status).toBe("done");
    expect(task?.mergeState).toBe("conflict");
    const merge = bed.store
      .listApprovals({ threadId: bed.thread.id })
      .find((approval) => approval.kind === "merge");
    expect(merge?.risk).toBe("high");
    expect(await readFile(path.join(bed.repo, "conflict.txt"), "utf8")).toBe("from main\n");
    await orchestrator.close();
  });
});

describe("recovery", () => {
  it("marks interrupted runs, resets their tasks and prunes stale worktrees", async () => {
    bed = await createTestBed();
    const task = bed.addTask({ id: "task_a", title: "A" });
    bed.store.updateTask(task.id, { status: "running", attempts: 1 });
    const run = bed.store.recordRun({
      threadId: bed.thread.id,
      taskId: task.id,
      kind: "execute",
      harness: "codex",
      status: "running",
    });

    // A worktree left behind by a task the plan no longer has.
    const stale = path.join(bed.worktreeRoot, bed.thread.id, "task_gone");
    await mkdir(stale, { recursive: true });

    const adapter = createFakeHarnessAdapter({ script: () => writesFiles({ "a.txt": "a" }) });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: { worktreeRoot: bed.worktreeRoot, reviewEnabled: false, verifyEnabled: false },
    });

    const report = await orchestrator.recover(bed.thread.id);
    expect(report.interruptedRuns).toEqual([run.id]);
    expect(report.resetTasks).toEqual([task.id]);
    expect(report.removedWorktrees).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);

    expect(bed.store.getRun(run.id)?.status).toBe("interrupted");
    const reset = bed.store.getTask(task.id);
    expect(reset?.status).toBe("ready");
    // The attempt stays counted.
    expect(reset?.attempts).toBe(1);

    // …and the loop picks the task straight back up.
    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);
    expect(bed.store.getTask(task.id)?.status).toBe("done");
    expect(bed.store.getTask(task.id)?.attempts).toBe(2);
    await orchestrator.close();
  });
});

describe("cancellation", () => {
  it("kills a live run through the adapter and blocks the task", async () => {
    bed = await createTestBed();
    bed.addTask({ id: "task_a", title: "A" });

    const adapter = createFakeHarnessAdapter({
      script: () => ({
        hang: true,
        events: [{ type: "started", sessionRef: "s" }],
      }),
    });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: { worktreeRoot: bed.worktreeRoot, reviewEnabled: false, verifyEnabled: false },
    });

    await orchestrator.start(bed.thread.id);
    await waitFor(() => adapter.running.size === 1, 5000, "a live run");

    const status = await orchestrator.cancel(bed.thread.id);
    expect(status.state).toBe("cancelled");
    expect(adapter.controls.some((control) => control.action.action === "cancel")).toBe(true);

    const run = bed.store.listRuns(bed.thread.id)[0];
    expect(run?.status).toBe("cancelled");
    expect(bed.store.getTask("task_a")?.status).toBe("blocked");
    await orchestrator.close();
  });

  it("cancels a single run through controlRun", async () => {
    bed = await createTestBed();
    bed.addTask({ id: "task_a", title: "A" });

    const adapter = createFakeHarnessAdapter({
      script: () => ({ hang: true, events: [{ type: "started", sessionRef: "s" }] }),
    });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: { worktreeRoot: bed.worktreeRoot, reviewEnabled: false, verifyEnabled: false },
    });

    const dispatched = await orchestrator.dispatch("task_a");
    await waitFor(() => adapter.running.size === 1, 5000, "a live run");

    const result = await orchestrator.controlRun(dispatched.runId, { action: "cancel" });
    expect(result.ok).toBe(true);
    await orchestrator.drain(bed.thread.id);
    expect(bed.store.getRun(dispatched.runId)?.status).toBe("cancelled");
    await orchestrator.close();
  });

  it("pauses and resumes without killing anything", async () => {
    bed = await createTestBed();
    bed.addTask({ id: "task_a", title: "A" });
    bed.addTask({ id: "task_b", title: "B" });

    const adapter = createFakeHarnessAdapter({
      script: () => writesFiles({ "a.txt": "a" }),
      defaultScript: { delayMs: 2 },
    });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: {
        worktreeRoot: bed.worktreeRoot,
        concurrency: 1,
        reviewEnabled: false,
        verifyEnabled: false,
      },
    });

    await orchestrator.pause(bed.thread.id);
    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);
    const afterStart = adapter.calls.length;

    await orchestrator.pause(bed.thread.id);
    expect(orchestrator.status(bed.thread.id).state).toBe("paused");
    await orchestrator.resume(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    expect(adapter.calls.length).toBeGreaterThanOrEqual(afterStart);
    expect(bed.store.listTasks(bed.thread.id).every((task) => task.status === "done")).toBe(true);
    await orchestrator.close();
  });
});

describe("the ExecutionHost", () => {
  it("dispatches, reads run events and reads artifacts", async () => {
    bed = await createTestBed();
    bed.addTask({ id: "task_a", title: "A" });

    const adapter = createFakeHarnessAdapter({
      script: () => writesFiles({ "hello.txt": "hello\n" }, "wrote hello.txt"),
    });
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: adapter },
      config: { worktreeRoot: bed.worktreeRoot, reviewEnabled: false, verifyEnabled: false },
    });

    const dispatched = await orchestrator.host.dispatchTask({ taskId: "task_a" });
    expect(dispatched.runId).toBeTruthy();
    expect(dispatched.harness).toBe("codex");
    expect(dispatched.worktreePath).toContain("task_a");

    await orchestrator.drain(bed.thread.id);

    const events = await orchestrator.host.readRunEvents({ runId: dispatched.runId });
    expect(events.events.map((event) => event.type)).toContain("final");
    expect(events.nextSeq).toBe(events.events.length);

    const filtered = await orchestrator.host.readRunEvents({
      runId: dispatched.runId,
      types: ["file_changed"],
    });
    expect(filtered.events).toHaveLength(1);

    const diff = bed.store
      .listArtifacts(bed.thread.id)
      .find((artifact) => artifact.kind === "diff");
    const read = await orchestrator.host.readArtifact({ artifactId: diff?.id ?? "" });
    expect(read.content).toContain("hello.txt");
    expect(read.artifact.kind).toBe("diff");
    await orchestrator.close();
  });

  it("marks a criterion only when evidence is attached", async () => {
    bed = await createTestBed({ criteria: [commandCriterion("ac_1", "true")] });
    bed.addTask({ id: "task_a", title: "A", criteria: ["ac_1"] });

    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: { codex: createFakeHarnessAdapter() },
      config: { worktreeRoot: bed.worktreeRoot },
    });

    const refused = await orchestrator.host.markCriterion({ criterionId: "ac_1", passed: true });
    expect(refused.satisfied).toBe(false);

    const accepted = await orchestrator.host.markCriterion({
      criterionId: "ac_1",
      passed: true,
      evidenceArtifactId: "art_manual",
    });
    expect(accepted.satisfied).toBe(true);
    expect(bed.store.getSpec(bed.thread.id)?.acceptanceCriteria[0]?.evidenceArtifactId).toBe(
      "art_manual",
    );
    await orchestrator.close();
  });
});
