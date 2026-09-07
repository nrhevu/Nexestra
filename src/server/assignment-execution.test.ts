import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Task } from "../shared/contracts.js";
import { createApp } from "./app.js";
import type { AgentInvocation, AgentRunner } from "./runtime.js";
import { FileStore, MAX_UPLOAD_BYTES } from "./store.js";

const ready = {
  chatgpt: { installed: false, connected: false, message: "Offline tests" },
  harnesses: {
    codex: { installed: true, version: "fixture" },
    opencode: { installed: true, version: "fixture" },
  },
};
const checks = [
  {
    behavior: "The memo explains its sources",
    verification: "Read the memo and inspect its citations",
  },
];

describe("General-purpose assignment execution", () => {
  let root: string;
  let store: FileStore;
  let task: Task;
  let worker: Agent;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nexestra-general-work-"));
    store = await FileStore.open({ root, workspacePath: root });
    worker = await store.createAgent({
      kind: "worker",
      name: "Researcher",
      handle: "researcher",
      harness: "codex",
    });
    task = await store.createTask({
      title: "Write a research memo",
      kind: "research",
      threadId: store.listThreads()[0]?.id,
      acceptanceCriteria: checks,
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const launch = (app: ReturnType<typeof createApp>, selected: Task = task) =>
    app.request(`/api/tasks/${selected.id}/delegate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerHandle: worker.handle, expectedRevision: selected.revision }),
    });

  it("persists the user mention before execution, captures immutable outputs, and binds acceptance to their hashes", async () => {
    let invocation: AgentInvocation | undefined;
    const runner: AgentRunner = {
      runtimeStatus: async () => ready,
      invoke: async (_agent, input) => {
        invocation = input;
        const userMessage = (await store.threadData(task.threadId ?? "")).messages.find(
          (message) => message.id === input.trigger.id,
        );
        expect(userMessage).toMatchObject({
          author: { kind: "user" },
          mentions: [{ agentId: worker.id, handle: worker.handle }],
        });
        expect(input).toMatchObject({ mode: "task", executionEnvironment: "directory" });
        expect(await readFile(join(input.workingDirectory ?? "", "TASK.md"), "utf8")).toContain(
          checks[0]?.verification,
        );
        await writeFile(
          join(input.workingDirectory ?? "", "outputs", "memo.md"),
          "# Research memo\nA captured deliverable.\n",
        );
        return "The memo is ready for review.";
      },
    };
    const app = createApp({ store, runner });
    const response = await launch(app);
    expect(response.status).toBe(202);
    const receipt = await response.json();
    expect(receipt).toMatchObject({
      status: "queued",
      repositoryId: null,
      environment: "directory",
      branch: "",
    });
    await app.dispatcher.waitForIdle();
    const process = await app.dispatcher.taskProcess(task.id);
    expect(process).toMatchObject({
      task: { status: "in_review" },
      run: { status: "completed" },
      assignment: {
        outputs: [{ name: "memo.md", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
      },
      artifacts: [{ source: "generated", name: "memo.md" }],
    });
    const artifact = process.artifacts?.[0];
    if (!artifact || !process.assignment) throw new Error("Expected captured output");
    await writeFile(
      join(invocation?.workingDirectory ?? "", "outputs", "memo.md"),
      "Changed after submission",
    );
    const download = await app.request(
      `/api/threads/${task.threadId}/artifacts/${artifact.id}/content`,
    );
    expect(download.headers.get("content-disposition")).toContain("attachment;");
    expect(await download.text()).toContain("A captured deliverable");
    await store.reviewTask(task.id, {
      assignmentId: process.assignment.id,
      expectedRevision: 1,
      outcome: "accepted",
      notes: "Inspected the captured memo.",
      evidence: [
        { criterionIndex: 0, observation: "Read memo.md and inspected its stated sources." },
      ],
    });
    const reopened = await FileStore.open({ root, workspacePath: root });
    expect(reopened.listAssignments()[0]?.review?.outputs).toEqual(process.assignment.outputs);
    expect(reopened.getTask(task.id)?.status).toBe("done");
    expect((await reopened.threadData(task.threadId ?? "")).messages).toHaveLength(2);
  });

  it("rejects acceptance if captured bytes are modified outside the app", async () => {
    const runner: AgentRunner = {
      runtimeStatus: async () => ready,
      invoke: async (_agent, input) => {
        await writeFile(join(input.workingDirectory ?? "", "outputs", "memo.md"), "Original memo");
        return "Submitted";
      },
    };
    const app = createApp({ store, runner });
    await launch(app);
    await app.dispatcher.waitForIdle();
    const process = await app.dispatcher.taskProcess(task.id);
    const artifact = process.artifacts?.[0];
    if (!artifact || !process.assignment) throw new Error("Expected captured output");
    const { file } = await store.artifactContent(task.threadId ?? "", artifact.id);
    await writeFile(file, "Modified snapshot");
    await expect(
      store.reviewTask(task.id, {
        assignmentId: process.assignment.id,
        expectedRevision: 1,
        outcome: "accepted",
        notes: "Accept",
        evidence: [{ criterionIndex: 0, observation: "Checked" }],
      }),
    ).rejects.toThrow("captured output changed");
    expect(store.getTask(task.id)?.status).toBe("in_review");
  });

  it("restores reviewed document inputs across a failed retry and restart without carrying them into changed scope", async () => {
    let calls = 0;
    let firstDirectory = "";
    const runner: AgentRunner = {
      runtimeStatus: async () => ready,
      invoke: async (_agent, input) => {
        calls += 1;
        if (calls === 1 || calls >= 4) {
          expect(input.artifacts).toEqual([]);
          expect(input.trigger.content).not.toContain("Previous review");
          firstDirectory = input.workingDirectory ?? "";
        } else {
          expect(input.artifacts).toHaveLength(1);
          const path = input.artifacts?.[0]?.localPath;
          expect(path).toContain(`${input.workingDirectory}/inputs/`);
          expect(await readFile(path ?? "", "utf8")).toBe("Original reviewed memo");
          expect(input.trigger.content).toContain("Add primary sources.");
          expect(await readFile(join(input.workingDirectory ?? "", "TASK.md"), "utf8")).toContain(
            "Add primary sources.",
          );
          if (calls === 2) {
            await writeFile(path ?? "", "An abandoned edit to the input copy");
            throw new Error("Interrupted fixture revision");
          }
        }
        await writeFile(
          join(input.workingDirectory ?? "", "outputs", "memo.md"),
          calls === 1 ? "Original reviewed memo" : "Revised memo with sources",
        );
        return "Submitted for review";
      },
    };
    let app = createApp({ store, runner });
    await launch(app);
    await app.dispatcher.waitForIdle();
    const first = store.listAssignments()[0];
    if (!first?.outputs?.[0]) throw new Error("Expected first output");
    await store.reviewTask(task.id, {
      assignmentId: first.id,
      expectedRevision: 1,
      outcome: "changes_requested",
      notes: "Add primary sources.",
      evidence: [],
    });
    const review = store.listAssignments()[0]?.review;
    await writeFile(join(firstDirectory, "outputs", "memo.md"), "Changed after capture");
    await launch(app);
    await app.dispatcher.waitForIdle();
    expect(store.listAssignments()[0]?.status).toBe("failed");
    store = await FileStore.open({ root, workspacePath: root });
    app = createApp({ store, runner });
    await launch(app);
    await app.dispatcher.waitForIdle();
    const third = store.listAssignments()[0];
    expect(third?.inputSource).toEqual({
      assignmentId: first.id,
      reviewId: review?.id,
      taskRevision: 1,
      outputs: first.outputs,
    });
    const history = await app.request(`/api/tasks/${task.id}/process?assignmentId=${first.id}`);
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toMatchObject({
      isLatestAttempt: false,
      assignment: { id: first.id, review: { outcome: "changes_requested" } },
      artifacts: [{ id: first.outputs[0].artifactId }],
      attempts: [{ ordinal: 3 }, { ordinal: 2 }, { ordinal: 1 }],
    });
    const unrelated = await store.createTask({ title: "Unrelated task", threadId: task.threadId });
    expect(
      (await app.request(`/api/tasks/${unrelated.id}/process?assignmentId=${first.id}`)).status,
    ).toBe(404);
    const original = await store.artifactContent(task.threadId ?? "", first.outputs[0].artifactId);
    expect(await readFile(original.file, "utf8")).toBe("Original reviewed memo");
    if (!third) throw new Error("Expected revised assignment");
    await store.reviewTask(task.id, {
      assignmentId: third.id,
      expectedRevision: 1,
      outcome: "accepted",
      notes: "Read the revised sources.",
      evidence: [{ criterionIndex: 0, observation: "Sources checked." }],
    });
    task = await store.updateTask(task.id, { status: "todo" });
    await launch(app);
    await app.dispatcher.waitForIdle();
    expect(store.listAssignments()[0]?.inputSource).toBeUndefined();
    task = await store.updateTask(task.id, {
      status: "todo",
      description: "Changed scope: a new audience",
    });
    expect(task.revision).toBe(2);
    await launch(app);
    await app.dispatcher.waitForIdle();
    expect(calls).toBe(5);
    expect(store.listAssignments()[0]?.inputSource).toBeUndefined();
  });

  it.each(["modified", "oversized", "symbolic-link", "hard-link"] as const)(
    "blocks a revision before invoking the Worker when its captured source is %s",
    async (damage) => {
      const invoke = vi.fn(async (_agent: Agent, input: AgentInvocation) => {
        await writeFile(join(input.workingDirectory ?? "", "outputs", "memo.md"), "Original memo");
        return "Submitted";
      });
      const app = createApp({ store, runner: { runtimeStatus: async () => ready, invoke } });
      await launch(app);
      await app.dispatcher.waitForIdle();
      const first = store.listAssignments()[0];
      if (!first?.outputs?.[0]) throw new Error("Expected output");
      await store.reviewTask(task.id, {
        assignmentId: first.id,
        expectedRevision: 1,
        outcome: "changes_requested",
        notes: "Add sources",
        evidence: [],
      });
      const { file } = await store.artifactContent(
        task.threadId ?? "",
        first.outputs[0].artifactId,
      );
      if (damage === "modified") await writeFile(file, "Changed bytes");
      else if (damage === "oversized") await truncate(file, MAX_UPLOAD_BYTES + 1);
      else {
        const outside = join(root, "unrelated-file");
        await writeFile(outside, "Original memo");
        await rm(file);
        if (damage === "symbolic-link") await symlink(outside, file);
        else await link(outside, file);
      }
      expect((await launch(app)).status).toBe(202);
      await app.dispatcher.waitForIdle();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(store.listAssignments()[0]).toMatchObject({
        status: "failed",
        error: expect.stringContaining("captured output"),
      });
      expect(store.getTask(task.id)?.status).toBe("todo");
    },
  );

  it("serializes manual assignments on one Worker and can stop a queued attempt without invoking it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invocations: AgentInvocation[] = [];
    const runner: AgentRunner = {
      runtimeStatus: async () => ready,
      invoke: async (_agent, input) => {
        invocations.push(input);
        await gate;
        return "Submitted";
      },
    };
    const app = createApp({ store, runner });
    const second = await store.createTask({
      title: "Design a diagram",
      kind: "design",
      threadId: task.threadId,
      acceptanceCriteria: checks,
    });
    try {
      expect((await launch(app)).status).toBe(202);
      expect((await launch(app, second)).status).toBe(202);
      await vi.waitFor(() => expect(invocations).toHaveLength(1));
      await app.dispatcher.stopTask(second.id);
      expect(store.getTask(second.id)?.status).toBe("todo");
    } finally {
      release();
      await app.dispatcher.waitForIdle();
    }
    expect(invocations).toHaveLength(1);
    expect(store.getTask(task.id)?.status).toBe("in_review");
    expect((await app.dispatcher.taskProcess(second.id)).assignment?.status).toBe("interrupted");
  });

  it("rejects duplicate dispatch without resetting the winning assignment", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner: AgentRunner = {
      runtimeStatus: async () => ready,
      invoke: async () => {
        await gate;
        return "Submitted";
      },
    };
    const app = createApp({ store, runner });
    try {
      const statuses = await Promise.all([launch(app), launch(app)]).then((responses) =>
        responses.map((response) => response.status).sort(),
      );
      expect(statuses).toEqual([202, 409]);
      expect(store.getTask(task.id)?.status).toBe("in_progress");
      expect(store.listAssignments()).toHaveLength(1);
    } finally {
      release();
      await app.dispatcher.waitForIdle();
    }
  });

  it("retains the invoked Worker profile after deletion, handle reuse and restart", async () => {
    worker = await store.createAgent({
      kind: "worker",
      name: "Original writer",
      handle: "writer",
      harness: "opencode",
      model: "fixture/glm",
      reasoningEffort: "high",
      instructions: "Use offline evidence only.",
    });
    const invoke = vi.fn(async (agent: Agent) => {
      expect(agent).toMatchObject({
        harness: "opencode",
        model: "fixture/glm",
        reasoningEffort: "high",
      });
      return "Offline submission";
    });
    const app = createApp({ store, runner: { runtimeStatus: async () => ready, invoke } });
    await launch(app);
    await app.dispatcher.waitForIdle();
    const profile = store.listAssignments()[0]?.executionProfile;
    expect(profile).toMatchObject({
      name: "Original writer",
      handle: "writer",
      harness: "opencode",
      model: "fixture/glm",
      reasoningEffort: "high",
      instructionsSha256: createHash("sha256").update(worker.instructions).digest("hex"),
    });
    await store.deleteAgent(worker.id);
    await store.createAgent({
      kind: "worker",
      name: "Replacement writer",
      handle: "writer",
      harness: "codex",
    });
    const reopened = await FileStore.open({ root, workspacePath: root });
    expect(reopened.listAssignments()[0]?.executionProfile).toEqual(profile);
    expect(reopened.listAssignments()[0]?.workerAgentId).toBe(worker.id);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("records failed manual runs and preserves their feedback for a later attempt", async () => {
    let fail = true;
    const runner: AgentRunner = {
      runtimeStatus: async () => ready,
      invoke: async () => {
        if (fail) throw new Error("Fixture worker failed");
        return "A revised submission";
      },
    };
    const app = createApp({ store, runner });
    await launch(app);
    await app.dispatcher.waitForIdle();
    expect(await app.dispatcher.taskProcess(task.id)).toMatchObject({
      task: { status: "todo" },
      assignment: { status: "failed", error: "Fixture worker failed" },
      run: { status: "failed" },
    });
    fail = false;
    await launch(app);
    await app.dispatcher.waitForIdle();
    expect(store.listAssignments()).toHaveLength(2);
    expect(store.getTask(task.id)?.status).toBe("in_review");
  });

  it("rejects code without a repository and stale starts before invoking a Worker", async () => {
    const runner: AgentRunner = { runtimeStatus: async () => ready, invoke: vi.fn() };
    const app = createApp({ store, runner });
    const revised = await store.updateTask(task.id, { kind: "code" });
    expect((await launch(app)).status).toBe(409);
    const code = await launch(app, revised);
    expect(code.status).toBe(400);
    expect(await code.text()).toContain("Code tasks require a ready repository");
    expect(runner.invoke).not.toHaveBeenCalled();
    expect(store.listAssignments()).toHaveLength(0);
  });
});
