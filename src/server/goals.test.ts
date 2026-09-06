import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, RuntimeStatus } from "../shared/contracts.js";
import { createApp } from "./app.js";
import { AgentDispatcher } from "./dispatcher.js";
import { GoalController } from "./goal-controller.js";
import type { AgentInvocation, AgentRunner } from "./runtime.js";
import { FileStore } from "./store.js";

const runtime: RuntimeStatus = {
  chatgpt: { installed: true, connected: true, message: "fixture" },
  harnesses: {
    codex: { installed: true, version: "fixture" },
    opencode: { installed: true, version: "fixture" },
  },
};
class GoalRunner implements AgentRunner {
  calls: AgentInvocation[] = [];
  block = false;
  fail = false;
  async runtimeStatus() {
    return runtime;
  }
  async invoke(_agent: Agent, invocation: AgentInvocation) {
    this.calls.push(invocation);
    if (this.fail) throw new Error("Fixture worker unavailable");
    if (this.block)
      await new Promise<void>((_resolve, reject) => {
        if (invocation.signal?.aborted) reject(new Error("Stopped"));
        else
          invocation.signal?.addEventListener("abort", () => reject(new Error("Stopped")), {
            once: true,
          });
      });
    await writeFile(
      join(invocation.workingDirectory ?? "", "outputs", "result.md"),
      `# Fixture output\n\n${invocation.trigger.content}`,
    );
    return "Submitted fixture output for independent review.";
  }
}
const roots: string[] = [];
const controllers: GoalController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(count = 2, attemptLimit = count * 2) {
  const root = await mkdtemp(join(tmpdir(), "nexestra-goals-"));
  roots.push(root);
  const store = await FileStore.open({ root, workspacePath: root });
  const thread = required(store.listThreads()[0]);
  const worker = await store.createAgent({
    kind: "worker",
    name: "Writer",
    handle: "writer",
    harness: "codex",
  });
  const tasks = [];
  for (let index = 0; index < count; index++)
    tasks.push(
      await store.createTask({
        title: `Document ${index + 1}`,
        kind: "document",
        threadId: thread.id,
        acceptanceCriteria: [
          { behavior: "Identifies the fixture", verification: "Read the captured document" },
        ],
      }),
    );
  const goal = await store.createGoal({
    threadId: thread.id,
    objective: "Prepare the document set",
    steps: tasks.map((task) => ({
      taskId: task.id,
      expectedRevision: task.revision,
      workerHandle: worker.handle,
    })),
    attemptLimit,
    timeLimitMinutes: 20,
  });
  const runner = new GoalRunner();
  const dispatcher = new AgentDispatcher(store, runner);
  const controller = new GoalController(store, dispatcher);
  controllers.push(controller);
  const idle = async () => {
    await controller.waitForIdle();
    await dispatcher.waitForIdle();
    await controller.waitForIdle();
  };
  const current = () => required(store.getGoal(goal.id));
  const control = (action: "start" | "pause" | "cancel") =>
    controller.control(goal.id, { action, expectedRevision: current().revision });
  const review = async (outcome: "accepted" | "changes_requested") => {
    const assignment = required(
      store.listAssignments().find((entry) => entry.id === current().activeAssignmentId),
    );
    const task = required(store.getTask(assignment.taskId));
    await store.reviewTask(task.id, {
      assignmentId: assignment.id,
      expectedRevision: task.revision,
      outcome,
      evidence:
        outcome === "accepted"
          ? [
              {
                criterionIndex: 0,
                observation: "Read the fixture output and verified its heading.",
              },
            ]
          : [],
      notes:
        outcome === "accepted"
          ? "Fixture evidence inspected."
          : "Please add more detail in the document.",
    });
    await controller.taskReviewed(task.id);
    await idle();
  };
  return {
    store,
    root,
    thread,
    worker,
    tasks,
    goal,
    runner,
    dispatcher,
    controller,
    idle,
    current,
    control,
    review,
  };
}

describe("Durable bounded goals", () => {
  it("pins the brief when the goal is drafted instead of silently changing intent between attempts", async () => {
    const f = await fixture(1, 2);
    await f.store.saveWorkBrief(f.thread.id, {
      expectedRevision: 0,
      title: "Original brief",
      outcome: "Original desired outcome",
    });
    const goal = await f.store.createGoal({
      threadId: f.thread.id,
      objective: "Preserve the agreed direction",
      steps: [
        { taskId: required(f.tasks[0]).id, expectedRevision: 1, workerHandle: f.worker.handle },
      ],
      attemptLimit: 2,
      timeLimitMinutes: 20,
    });
    await f.store.saveWorkBrief(f.thread.id, {
      expectedRevision: 1,
      title: "New direction",
      outcome: "Different desired outcome",
    });
    await f.controller.control(goal.id, { action: "start", expectedRevision: 1 });
    await f.idle();
    expect(f.runner.calls[0]?.workBrief).toMatchObject({
      revision: 1,
      outcome: "Original desired outcome",
    });
    expect(f.store.getGoal(goal.id)?.workBrief?.revision).toBe(1);
  });

  it("records reviews while paused without launching work, and recognizes final acceptance", async () => {
    const f = await fixture(2, 3);
    await f.control("start");
    await f.idle();
    await f.control("pause");
    await f.review("accepted");
    expect(f.current()).toMatchObject({ status: "paused", attemptsUsed: 1 });
    expect(f.current().accepted).toHaveLength(1);
    expect(f.runner.calls).toHaveLength(1);
    await f.control("start");
    await f.idle();
    await f.control("pause");
    await f.review("accepted");
    expect(f.current()).toMatchObject({ status: "completed", attemptsUsed: 2 });
    expect(f.runner.calls).toHaveLength(2);
  });

  it("does not let a Master execute draft-goal tasks before human authorization", async () => {
    const f = await fixture(1, 2);
    const now = new Date().toISOString();
    await expect(
      f.store.createAssignment(
        {
          id: crypto.randomUUID(),
          workspaceId: f.goal.workspaceId,
          taskId: required(f.tasks[0]).id,
          threadId: f.thread.id,
          masterRunId: "master-run",
          workerAgentId: f.worker.id,
          repositoryId: null,
          environment: "directory",
          status: "queued",
          branch: "",
          worktreePath: "fixture/work",
          createdAt: now,
          updatedAt: now,
        },
        1,
      ),
    ).rejects.toThrow("draft goal");
    expect(f.current()).toMatchObject({ status: "draft", attemptsUsed: 0 });
    expect(f.store.listAssignments()).toHaveLength(0);
  });

  it("attributes agent-authored drafts and rejects cross-workspace or changed task scope", async () => {
    const f = await fixture(1, 2);
    const other = await f.store.createWorkspace({ name: "Other" });
    const foreign = await f.store.createAgent({
      workspaceId: other.id,
      kind: "worker",
      name: "Other writer",
      handle: "otherwriter",
      harness: "codex",
    });
    const input = {
      objective: "Another draft",
      threadId: f.thread.id,
      steps: [
        { taskId: required(f.tasks[0]).id, expectedRevision: 1, workerHandle: f.worker.handle },
      ],
      attemptLimit: 2,
      timeLimitMinutes: 20,
    };
    await expect(f.store.createGoal(input, foreign.id)).rejects.toThrow("in its workspace");
    expect((await f.store.createGoal(input, f.worker.id)).createdBy).toEqual({
      kind: "agent",
      id: f.worker.id,
    });
    await f.store.updateTask(required(f.tasks[0]).id, { title: "Revised contract" });
    await expect(f.control("start")).rejects.toThrow("requirements changed");
    expect(f.runner.calls).toHaveLength(0);
  });

  it("runs one task at a time and advances only after a separate matching human acceptance", async () => {
    const f = await fixture();
    expect(f.current().status).toBe("draft");
    expect(f.runner.calls).toHaveLength(0);
    await f.control("start");
    await f.idle();
    expect(f.current()).toMatchObject({ status: "waiting_review", attemptsUsed: 1 });
    expect(f.runner.calls).toHaveLength(1);
    expect(f.store.getTask(required(f.tasks[0]).id)?.status).toBe("in_review");
    const transcript = await f.store.threadData(f.thread.id);
    expect(transcript.messages[0]).toMatchObject({
      author: { kind: "user" },
      mentions: [{ agentId: f.worker.id }],
    });
    expect(transcript.messages[0]?.content).toContain(`Authorized goal ${f.goal.id}`);
    await f.review("accepted");
    expect(f.current()).toMatchObject({ status: "waiting_review", attemptsUsed: 2 });
    expect(f.runner.calls).toHaveLength(2);
    await f.review("accepted");
    expect(f.current()).toMatchObject({ status: "completed", attemptsUsed: 2 });
    expect(f.current().accepted).toHaveLength(2);
    expect(f.current().events.some((event) => event.detail.includes("human acceptance"))).toBe(
      true,
    );
    await expect(f.control("start")).rejects.toThrow("already ended");
  });

  it("retries changes requested within the same budget, then exhausts without self-accepting", async () => {
    const f = await fixture(1, 2);
    await f.control("start");
    await f.idle();
    await f.review("changes_requested");
    expect(f.current()).toMatchObject({ status: "waiting_review", attemptsUsed: 2 });
    expect(f.runner.calls[1]?.trigger.content).toContain("more detail");
    await f.review("changes_requested");
    expect(f.current()).toMatchObject({ status: "exhausted", attemptsUsed: 2 });
    expect(f.runner.calls).toHaveLength(2);
    expect(f.store.getTask(required(f.tasks[0]).id)?.status).toBe("todo");
  });

  it("serializes duplicate starts and rejects bypassing the goal's task scope", async () => {
    const f = await fixture();
    const starts = await Promise.allSettled([f.control("start"), f.control("start")]);
    await f.idle();
    expect(starts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(f.current().attemptsUsed).toBe(1);
    await expect(
      f.dispatcher.delegateFromTask(required(f.tasks[1]).id, f.worker.handle),
    ).rejects.toThrow("authorized goal");
    await expect(
      f.store.updateTask(required(f.tasks[1]).id, { title: "Changed scope" }),
    ).rejects.toThrow("frozen requirements");
    await expect(f.store.deleteTask(required(f.tasks[1]).id)).rejects.toThrow("authorized goal");
    expect(f.current().attemptsUsed).toBe(1);
    expect(f.runner.calls).toHaveLength(1);
  });

  it("pauses an active process, preserves attempts and deadline, and requires explicit resumption", async () => {
    const f = await fixture(1, 3);
    f.runner.block = true;
    await f.control("start");
    await vi.waitFor(() => expect(f.runner.calls).toHaveLength(1));
    const deadline = f.current().deadlineAt;
    await f.control("pause");
    await f.idle();
    expect(f.current()).toMatchObject({ status: "paused", attemptsUsed: 1, deadlineAt: deadline });
    expect(f.store.listAssignments()[0]?.status).toBe("interrupted");
    f.runner.block = false;
    await f.control("start");
    await f.idle();
    expect(f.current()).toMatchObject({
      status: "waiting_review",
      attemptsUsed: 2,
      deadlineAt: deadline,
    });
    await f.review("accepted");
    expect(f.current().status).toBe("completed");
  });

  it("stops on a worker failure and never turns a pause/resume into a fresh budget", async () => {
    const f = await fixture(1, 2);
    f.runner.fail = true;
    await f.control("start");
    await f.idle();
    expect(f.current()).toMatchObject({ status: "blocked", attemptsUsed: 1 });
    await f.control("start");
    await f.idle();
    expect(f.current().attemptsUsed).toBe(2);
    await f.control("start");
    await f.idle();
    expect(f.current()).toMatchObject({ status: "exhausted", attemptsUsed: 2 });
    expect(f.runner.calls).toHaveLength(2);
  });

  it("recovers interrupted assignments and pauses goals without replaying work after restart", async () => {
    const f = await fixture(1, 2);
    await f.store.controlGoal(f.goal.id, { action: "start", expectedRevision: f.goal.revision });
    const now = new Date().toISOString();
    await f.store.createAssignment(
      {
        id: crypto.randomUUID(),
        goalId: f.goal.id,
        workspaceId: f.goal.workspaceId,
        taskId: required(f.tasks[0]).id,
        threadId: f.thread.id,
        masterRunId: "",
        workerAgentId: f.worker.id,
        repositoryId: null,
        environment: "directory",
        status: "queued",
        branch: "",
        worktreePath: "fixture/work",
        createdAt: now,
        updatedAt: now,
      },
      1,
    );
    const before = required(f.store.getGoal(f.goal.id));
    const reopened = await FileStore.open({ root: f.root, workspacePath: f.root });
    expect(reopened.getGoal(f.goal.id)).toMatchObject({
      status: "paused",
      attemptsUsed: 1,
      deadlineAt: before.deadlineAt,
    });
    expect(reopened.listAssignments()[0]).toMatchObject({ status: "interrupted" });
    expect(reopened.getTask(required(f.tasks[0]).id)?.status).toBe("todo");
    expect(f.runner.calls).toHaveLength(0);
    const durable = JSON.parse(await readFile(reopened.stateFile, "utf8"));
    expect(durable.goals[0].events.at(-1).detail).toContain("No work was replayed");
  });

  it("enforces the elapsed-time limit during a running task", async () => {
    const f = await fixture(1, 3);
    f.runner.block = true;
    await f.control("start");
    await vi.waitFor(() => expect(f.runner.calls).toHaveLength(1));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.parse(f.current().deadlineAt ?? "") + 1));
    await f.controller.kick(f.goal.id);
    await f.idle();
    expect(f.current()).toMatchObject({ status: "exhausted", attemptsUsed: 1 });
    expect(f.store.listAssignments()[0]?.status).toBe("interrupted");
  });

  it("exposes explicit goal controls and independent review continuation through HTTP", async () => {
    const f = await fixture(1, 2);
    f.controller.dispose();
    const app = createApp({ store: f.store, runner: f.runner });
    controllers.push(app.goals);
    const denied = await app.request(`/api/goals/${f.goal.id}/control`, {
      method: "POST",
      headers: { origin: "https://untrusted.example", "content-type": "application/json" },
      body: JSON.stringify({ action: "start", expectedRevision: 1 }),
    });
    expect(denied.status).toBe(403);
    const started = await app.request(`/api/goals/${f.goal.id}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "start", expectedRevision: 1 }),
    });
    expect(started.status).toBe(200);
    await app.dispatcher.waitForIdle();
    await app.goals.waitForIdle();
    const assignment = required(f.store.listAssignments()[0]);
    const accepted = await app.request(`/api/tasks/${assignment.taskId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assignmentId: assignment.id,
        expectedRevision: 1,
        outcome: "accepted",
        evidence: [{ criterionIndex: 0, observation: "Read and verified the fixture heading." }],
        notes: "Accepted fixture.",
      }),
    });
    expect(accepted.status).toBe(200);
    const read = await app.request(`/api/goals/${f.goal.id}`);
    expect(await read.json()).toMatchObject({ status: "completed", attemptsUsed: 1 });
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
