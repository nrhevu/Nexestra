import { mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentRun, RunHistoryRequest, Thread } from "../shared/contracts.js";
import { createApp } from "./app.js";
import type { RunHistorySummary } from "./conversation-history.js";
import { decodeRunHistoryCursor, encodeRunHistoryCursor } from "./run-history.js";
import type { AgentRunner } from "./runtime.js";
import { FileStore } from "./store.js";

async function openStore() {
  const root = await mkdtemp(join(tmpdir(), "nexestra-run-history-"));
  return FileStore.open({ root, workspacePath: root });
}

function makeRun(
  id: string,
  threadId: string,
  agentId: string,
  createdAt: string,
  status: AgentRun["status"] = "completed",
  error?: string,
): AgentRun {
  return {
    id,
    threadId,
    triggerMessageId: `trigger-${id}`,
    agentId,
    attempt: 1,
    status,
    ...(error ? { error } : {}),
    createdAt,
    updatedAt: createdAt,
  };
}

async function createWorkerAgent(
  store: FileStore,
  name = "Runner",
  handle = "runner",
): Promise<Agent> {
  return store.createAgent({
    kind: "worker",
    name,
    handle,
    description: "",
    instructions: "",
    harness: "codex",
  });
}

async function createThread(store: FileStore, name = "General"): Promise<Thread> {
  return store.createThread({ name });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run history server", () => {
  it("reports elapsed duration for terminal runs and omits it while active", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const agent = await createWorkerAgent(store);
    const thread = await createThread(store);
    const completed = makeRun(
      "run-duration",
      thread.id,
      agent.id,
      "2026-01-01T00:00:00.000Z",
      "completed",
    );
    await store.updateRun({
      ...completed,
      updatedAt: "2026-01-01T00:01:05.250Z",
      usage: { inputTokens: 1_000, outputTokens: 250, totalTokens: 1_250 },
    });
    await store.updateRun(
      makeRun("run-active", thread.id, agent.id, "2026-01-02T00:00:00.000Z", "running"),
    );

    const page = await store.listRunHistory({ workspaceId: workspace.id });
    expect(page.items.find((item) => item.run.id === "run-duration")?.run.durationMs).toBe(65_250);
    expect(page.items.find((item) => item.run.id === "run-duration")?.run.usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 250,
      totalTokens: 1_250,
    });
    expect(page.summary).toEqual({
      totalRuns: 2,
      terminalRuns: 1,
      totalDurationMs: 65_250,
      usageRuns: 1,
      totalTokens: 1_250,
      byAgent: [
        {
          agentId: agent.id,
          agentName: "Runner",
          totalRuns: 2,
          terminalRuns: 1,
          totalDurationMs: 65_250,
          usageRuns: 1,
          inputTokens: 1_000,
          outputTokens: 250,
          cachedInputTokens: 0,
          totalTokens: 1_250,
        },
      ],
    });
    expect(page.items.find((item) => item.run.id === "run-active")?.run.durationMs).toBeUndefined();
  });

  it("lists each run once with its latest status and deterministic newest-first order", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const agent = await createWorkerAgent(store);
    const thread = await createThread(store);
    const early = makeRun("run-early", thread.id, agent.id, "2026-01-01T00:00:00.000Z", "failed");
    const a = makeRun("run-a", thread.id, agent.id, "2026-01-02T00:00:00.000Z", "queued");
    await store.updateRun(a);
    await store.updateRun({ ...a, status: "running" });
    await store.updateRun({ ...a, status: "completed" });
    for (const run of [
      makeRun("run-b", thread.id, agent.id, "2026-01-02T00:00:00.000Z", "interrupted"),
      makeRun("run-c", thread.id, agent.id, "2026-01-03T00:00:00.000Z", "waiting_approval"),
      makeRun("run-d", thread.id, agent.id, "2026-01-04T00:00:00.000Z", "waiting_input"),
      makeRun("run-e", thread.id, agent.id, "2026-01-05T00:00:00.000Z", "queued"),
      makeRun("run-f", thread.id, agent.id, "2026-01-06T00:00:00.000Z", "running"),
      early,
    ]) {
      await store.updateRun(run);
    }
    const page = await store.listRunHistory({ workspaceId: workspace.id, limit: 50 });
    expect(page.page.nextCursor).toBeNull();
    expect(page.items.map((item) => item.run.id)).toEqual([
      "run-f",
      "run-e",
      "run-d",
      "run-c",
      "run-a",
      "run-b",
      "run-early",
    ]);
    expect(page.items.find((item) => item.run.id === "run-a")?.run.status).toBe("completed");
    expect(new Set(page.items.map((item) => item.run.status))).toEqual(
      new Set<AgentRun["status"]>([
        "queued",
        "running",
        "waiting_approval",
        "waiting_input",
        "completed",
        "failed",
        "interrupted",
      ]),
    );
    expect(page.coverage).toEqual({ complete: true, unavailableThreads: 0 });
  });

  it("filters by agent, thread, and status and includes archived threads with current labels", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const agentA = await createWorkerAgent(store, "Agent A", "agent-a");
    const agentB = await createWorkerAgent(store, "Agent B", "agent-b");
    const threadA = await createThread(store, "Thread A");
    const threadB = await createThread(store, "Thread B");
    await store.updateRun(
      makeRun("run-filter-a", threadA.id, agentA.id, "2026-01-01T00:00:00.000Z", "completed"),
    );
    await store.updateRun(
      makeRun("run-filter-b", threadB.id, agentB.id, "2026-01-02T00:00:00.000Z", "failed"),
    );
    await store.updateRun(
      makeRun("run-filter-c", threadB.id, agentA.id, "2026-01-03T00:00:00.000Z", "failed"),
    );
    await store.renameThread(threadB.id, { name: "Renamed B" });
    await store.archiveThread(threadB.id);
    const byAgent = await store.listRunHistory({
      workspaceId: workspace.id,
      agentId: agentA.id,
      limit: 50,
    });
    expect(byAgent.items.map((item) => item.run.id)).toEqual(["run-filter-c", "run-filter-a"]);
    const byThread = await store.listRunHistory({
      workspaceId: workspace.id,
      threadId: threadB.id,
      limit: 50,
    });
    expect(byThread.items.map((item) => item.run.id)).toEqual(["run-filter-c", "run-filter-b"]);
    for (const item of byThread.items) {
      expect(item.threadName).toBe("Renamed B");
      expect(item.threadArchived).toBe(true);
      expect(item.agentName).toBe(item.run.agentId === agentA.id ? "Agent A" : "Agent B");
      expect(item.agentHandle).toBe(item.run.agentId === agentA.id ? "agent-a" : "agent-b");
    }
    expect(byThread.summary.byAgent).toEqual([
      {
        agentId: agentA.id,
        agentName: "Agent A",
        totalRuns: 1,
        terminalRuns: 1,
        totalDurationMs: 0,
        usageRuns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
      },
      {
        agentId: agentB.id,
        agentName: "Agent B",
        totalRuns: 1,
        terminalRuns: 1,
        totalDurationMs: 0,
        usageRuns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
      },
    ]);
    const byStatus = await store.listRunHistory({
      workspaceId: workspace.id,
      status: "failed",
      limit: 50,
    });
    expect(byStatus.items.map((item) => item.run.id)).toEqual(["run-filter-c", "run-filter-b"]);
    const combined = await store.listRunHistory({
      workspaceId: workspace.id,
      agentId: agentA.id,
      threadId: threadB.id,
      status: "failed",
      limit: 50,
    });
    expect(combined.items.map((item) => item.run.id)).toEqual(["run-filter-c"]);
  });

  it("pages with a bounded opaque cursor and stays stable across updates and appends", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const agent = await createWorkerAgent(store);
    const thread = await createThread(store, "Paged");
    for (let i = 0; i < 120; i += 1) {
      const id = `run-${String(i).padStart(3, "0")}`;
      await store.updateRun(
        makeRun(
          id,
          thread.id,
          agent.id,
          `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
          i % 2 === 0 ? "failed" : "completed",
        ),
      );
    }
    const first = await store.listRunHistory({ workspaceId: workspace.id, limit: 50 });
    expect(first.page.nextCursor).not.toBeNull();
    expect(first.items.map((item) => item.run.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `run-${String(119 - index).padStart(3, "0")}`),
    );
    const second = await store.listRunHistory({
      workspaceId: workspace.id,
      limit: 50,
      cursor: first.page.nextCursor ?? undefined,
    });
    const secondIds = second.items.map((item) => item.run.id);
    expect(secondIds[0]).toBe("run-069");
    expect(secondIds.at(-1)).toBe("run-020");
    const third = await store.listRunHistory({
      workspaceId: workspace.id,
      limit: 50,
      cursor: second.page.nextCursor ?? undefined,
    });
    expect(third.items.map((item) => item.run.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `run-${String(19 - index).padStart(3, "0")}`),
    );
    expect(third.page.nextCursor).toBeNull();
    await store.updateRun(
      makeRun("run-050", thread.id, agent.id, "2026-01-01T00:00:50.000Z", "failed", "replaced"),
    );
    const secondAfterUpdate = await store.listRunHistory({
      workspaceId: workspace.id,
      limit: 50,
      cursor: first.page.nextCursor ?? undefined,
    });
    expect(secondAfterUpdate.items.map((item) => item.run.id)).toEqual(secondIds);
    await store.updateRun(
      makeRun("run-newest", thread.id, agent.id, "2026-02-01T00:00:00.000Z", "queued"),
    );
    const secondAfterAppend = await store.listRunHistory({
      workspaceId: workspace.id,
      limit: 50,
      cursor: first.page.nextCursor ?? undefined,
    });
    expect(secondAfterAppend.items.map((item) => item.run.id)).toEqual(secondIds);
  });

  it("recovers latest projections across reopen and after subsequent appends", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const agent = await createWorkerAgent(store);
    const thread = await createThread(store, "Recover");
    const a = makeRun("recover-a", thread.id, agent.id, "2026-01-01T00:00:00.000Z", "queued");
    await store.updateRun(a);
    await store.updateRun({ ...a, status: "running" });
    await store.updateRun({ ...a, status: "failed", error: "boom" });
    await store.updateRun(
      makeRun("recover-b", thread.id, agent.id, "2026-01-02T00:00:00.000Z", "completed"),
    );
    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const page = await reopened.listRunHistory({ workspaceId: workspace.id, limit: 50 });
    expect(page.items.map((item) => item.run.id)).toEqual(["recover-b", "recover-a"]);
    expect(page.items.find((item) => item.run.id === "recover-a")?.run.status).toBe("failed");
    await reopened.updateRun({ ...a, status: "interrupted" });
    const after = await reopened.listRunHistory({ workspaceId: workspace.id, limit: 50 });
    expect(after.items.find((item) => item.run.id === "recover-a")?.run.status).toBe("interrupted");
  });

  it("excludes corrupt and missing transcripts with coverage counts but not empty threads", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const agent = await createWorkerAgent(store);
    const good = await createThread(store, "Good");
    const corrupt = await createThread(store, "Corrupt");
    const missing = await createThread(store, "Missing");
    await createThread(store, "Empty");
    await store.updateRun(makeRun("good-run", good.id, agent.id, "2026-01-01T00:00:00.000Z"));
    await store.updateRun(makeRun("corrupt-run", corrupt.id, agent.id, "2026-01-02T00:00:00.000Z"));
    await store.updateRun(makeRun("missing-run", missing.id, agent.id, "2026-01-03T00:00:00.000Z"));
    await store.createUserMessage(missing.id, "one message", []);
    const indexMap = (
      store as unknown as {
        historyIndexes: Map<string, { missing?: boolean; unreliable?: boolean }>;
      }
    ).historyIndexes;
    const corruptIndex = indexMap.get(corrupt.id);
    const missingIndex = indexMap.get(missing.id);
    if (!corruptIndex || !missingIndex) {
      throw new Error("expected transcript indexes");
    }
    corruptIndex.unreliable = true;
    missingIndex.missing = true;
    const page = await store.listRunHistory({ workspaceId: workspace.id, limit: 50 });
    expect(page.coverage).toEqual({ complete: false, unavailableThreads: 2 });
    expect(page.items.map((item) => item.run.id)).toEqual(["good-run"]);
  });

  it("keeps a known nonempty missing transcript unavailable across reopens and filtered reads", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const agent = await createWorkerAgent(store);
    const missing = await createThread(store, "Missing");
    const empty = await createThread(store, "Empty");
    await store.createUserMessage(missing.id, "hello", []);
    await store.updateRun(makeRun("missing-run", missing.id, agent.id, "2026-01-01T00:00:00.000Z"));
    await unlink(store.transcriptPath(missing.id));
    const reopened = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    const page = await reopened.listRunHistory({ workspaceId: workspace.id, limit: 50 });
    expect(page.coverage).toEqual({ complete: false, unavailableThreads: 1 });
    expect(page.items).toEqual([]);
    const filtered = await reopened.listRunHistory({
      workspaceId: workspace.id,
      threadId: missing.id,
      limit: 50,
    });
    expect(filtered.coverage).toEqual({ complete: false, unavailableThreads: 1 });
    const emptyFiltered = await reopened.listRunHistory({
      workspaceId: workspace.id,
      threadId: empty.id,
      limit: 50,
    });
    expect(emptyFiltered.coverage).toEqual({ complete: true, unavailableThreads: 0 });
    const reopenedAgain = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    const again = await reopenedAgain.listRunHistory({ workspaceId: workspace.id, limit: 50 });
    expect(again.coverage).toEqual({ complete: false, unavailableThreads: 1 });
  });
  it("never leaks foreign owning thread or agent identities from crafted summaries", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const foreign = await store.createWorkspace({ name: "Foreign Leak" });
    const foreignAgent = await store.createAgent({
      workspaceId: foreign.id,
      kind: "worker",
      name: "Foreign Leak Agent",
      handle: "foreign-leak",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const foreignThread = await store.createThread({
      workspaceId: foreign.id,
      name: "Foreign Leak Thread",
    });
    const localAgent = await createWorkerAgent(store, "Local", "local");
    const localThread = await createThread(store, "Local Thread");
    await store.updateRun(
      makeRun("crafted-run", localThread.id, localAgent.id, "2026-01-01T00:00:00.000Z"),
    );
    const index = (
      store as unknown as {
        historyIndexes: Map<string, { runHistory: Map<string, RunHistorySummary> }>;
      }
    ).historyIndexes.get(localThread.id);
    if (!index) throw new Error("expected local index");
    index.runHistory.set("crafted-run", {
      id: "crafted-run",
      threadId: localThread.id,
      triggerMessageId: "trigger-crafted",
      agentId: foreignAgent.id,
      attempt: 1,
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const page = await store.listRunHistory({ workspaceId: workspace.id, limit: 50 });
    expect(page.coverage).toEqual({ complete: false, unavailableThreads: 1 });
    expect(page.items).toEqual([]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(foreignAgent.id);
    expect(serialized).not.toContain(foreignThread.id);
    expect(serialized).not.toContain("Foreign Leak");
  });

  it("redacts labels and never returns error contents or deleted agent labels", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const secret = "nexestra-run-history-secret";
    const agent = await store.createAgent({
      kind: "master",
      name: `Alpha ${secret}`,
      handle: "alpha",
      description: "",
      instructions: "",
      accessMode: "ask",
      provider: {
        type: "custom",
        name: "Provider",
        baseUrl: "https://example.com",
        model: "m",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });
    const thread = await createThread(store, `Sensitive ${secret}`);
    await store.updateRun(
      makeRun(
        "redact-run",
        thread.id,
        agent.id,
        "2026-01-01T00:00:00.000Z",
        "failed",
        `boom ${secret}`,
      ),
    );
    const ghost = await createWorkerAgent(store, "Soon Gone", "soongone");
    await store.updateRun(
      makeRun("ghost-run", thread.id, ghost.id, "2026-01-02T00:00:00.000Z", "completed"),
    );
    await store.deleteAgent(ghost.id);
    const page = await store.listRunHistory({ workspaceId: workspace.id, limit: 50 });
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(secret);
    const redacted = page.items.find((item) => item.run.id === "redact-run");
    expect(redacted?.agentName).toBe("Alpha [REDACTED]");
    expect(redacted?.threadName).toBe("Sensitive [REDACTED]");
    expect("error" in (redacted?.run ?? {})).toBe(false);
    const ghostItem = page.items.find((item) => item.run.id === "ghost-run");
    expect(ghostItem?.agentName).toBe("Unknown");
    expect(ghostItem?.agentHandle).toBeUndefined();
  });

  it("lists from the in-memory projection without reading whole transcripts", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const agent = await createWorkerAgent(store);
    const thread = await createThread(store, "No read");
    for (let i = 0; i < 30; i += 1) {
      await store.updateRun(
        makeRun(
          `run-${i}`,
          thread.id,
          agent.id,
          `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        ),
      );
    }
    const spy = vi.spyOn(
      FileStore.prototype as unknown as {
        readEvents: (...args: unknown[]) => Promise<unknown[]>;
      },
      "readEvents",
    );
    await store.listRunHistory({ workspaceId: workspace.id, limit: 50 });
    await store.listRunHistory({ workspaceId: workspace.id, limit: 20 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("serves the route with validation, scoped 404s, and mismatched cursor rejection", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const runner = {} as AgentRunner;
    const app = createApp({ store, runner });
    const agentA = await createWorkerAgent(store, "Agent A", "agent-a");
    const agentB = await createWorkerAgent(store, "Agent B", "agent-b");
    const foreign = await store.createWorkspace({ name: "Foreign" });
    const foreignAgent = await store.createAgent({
      workspaceId: foreign.id,
      kind: "worker",
      name: "Foreign Agent",
      handle: "foreign-agent",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const thread = await createThread(store, "HTTP");
    for (let i = 0; i < 60; i += 1) {
      await store.updateRun(
        makeRun(
          `http-run-${i}`,
          thread.id,
          agentA.id,
          `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        ),
      );
    }
    await store.updateRun(
      makeRun(
        "http-error-run",
        thread.id,
        agentA.id,
        "2026-02-01T00:00:00.000Z",
        "failed",
        "http-secret-leak",
      ),
    );
    const first = await app.request(`/api/runs?workspaceId=${workspace.id}`);
    expect(first.status).toBe(200);
    const firstRaw = await first.text();
    expect(firstRaw).not.toContain("http-secret-leak");
    expect(firstRaw).not.toMatch(/"error"\s*:/);
    const firstBody = JSON.parse(firstRaw) as {
      items: { run: { id: string } }[];
      page: { nextCursor: string | null };
      coverage: { complete: boolean; unavailableThreads: number };
    };
    expect(firstBody.items).toHaveLength(50);
    expect(firstBody.page.nextCursor).not.toBeNull();
    expect(firstBody.coverage).toEqual({ complete: true, unavailableThreads: 0 });
    const limitTooHigh = await app.request(`/api/runs?workspaceId=${workspace.id}&limit=101`);
    expect(limitTooHigh.status).toBe(400);
    const zeroLimit = await app.request(`/api/runs?workspaceId=${workspace.id}&limit=0`);
    expect(zeroLimit.status).toBe(400);
    const badStatus = await app.request(`/api/runs?workspaceId=${workspace.id}&status=finished`);
    expect(badStatus.status).toBe(400);
    const noWorkspace = await app.request("/api/runs");
    expect(noWorkspace.status).toBe(400);
    const missingWorkspace = await app.request("/api/runs?workspaceId=missing");
    expect(missingWorkspace.status).toBe(404);
    const foreignHistory = await app.request(`/api/runs?workspaceId=${foreign.id}`);
    expect(foreignHistory.status).toBe(200);
    const foreignBody = (await foreignHistory.json()) as { items: unknown[] };
    expect(foreignBody.items).toEqual([]);
    const missingThread = await app.request(
      `/api/runs?workspaceId=${workspace.id}&threadId=missing`,
    );
    expect(missingThread.status).toBe(404);
    const missingAgent = await app.request(`/api/runs?workspaceId=${workspace.id}&agentId=missing`);
    expect(missingAgent.status).toBe(404);
    const foreignAgentHistory = await app.request(
      `/api/runs?workspaceId=${workspace.id}&agentId=${foreignAgent.id}`,
    );
    expect(foreignAgentHistory.status).toBe(404);
    const agentFilter = await app.request(
      `/api/runs?workspaceId=${workspace.id}&agentId=${agentB.id}`,
    );
    expect(agentFilter.status).toBe(200);
    const agentBody = (await agentFilter.json()) as { items: { run: { id: string } }[] };
    expect(agentBody.items).toEqual([]);
    const mismatchedLimit = await app.request(
      `/api/runs?workspaceId=${workspace.id}&limit=10&cursor=${firstBody.page.nextCursor}`,
    );
    expect(mismatchedLimit.status).toBe(400);
    const mismatchedStatus = await app.request(
      `/api/runs?workspaceId=${workspace.id}&status=failed&cursor=${firstBody.page.nextCursor}`,
    );
    expect(mismatchedStatus.status).toBe(400);
    const invalidCursor = await app.request(
      `/api/runs?workspaceId=${workspace.id}&cursor=not-a-cursor`,
    );
    expect(invalidCursor.status).toBe(400);
    const second = await app.request(
      `/api/runs?workspaceId=${workspace.id}&cursor=${firstBody.page.nextCursor}`,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { items: { run: { id: string } }[] };
    expect(secondBody.items).toHaveLength(11);
  });
});

describe("run history cursor", () => {
  const request: RunHistoryRequest = {
    workspaceId: "workspace-1",
    agentId: "agent-1",
    threadId: "thread-1",
    status: "completed",
    limit: 25,
  };
  const last = { id: "run-9", threadId: "thread-1", createdAt: "2026-01-01T00:00:00.000Z" };

  function encode(payload: unknown): string {
    return Buffer.from(JSON.stringify(payload)).toString("base64url");
  }

  it("treats a missing cursor as undefined", () => {
    expect(decodeRunHistoryCursor(undefined)).toBeUndefined();
  });

  it("round-trips canonical cursors and keeps the request scope", () => {
    const cursor = encodeRunHistoryCursor(request, last);
    expect(decodeRunHistoryCursor(cursor)).toEqual({
      ...request,
      version: 1,
      createdAt: last.createdAt,
      runId: last.id,
      runThreadId: last.threadId,
    });
  });

  it("allows cursors without optional filters", () => {
    const raw = encode({
      version: 1,
      workspaceId: "workspace-1",
      limit: 50,
      createdAt: "2026-01-01T00:00:00.000Z",
      runId: "run-9",
      runThreadId: "thread-1",
    });
    expect(decodeRunHistoryCursor(raw)).toMatchObject({ workspaceId: "workspace-1", limit: 50 });
  });

  it("rejects malformed, padded, noncanonical, and over-long cursor encodings", () => {
    for (const raw of [
      "",
      "!",
      "=====",
      "YQ==",
      "YR",
      "YWJj",
      "not-a-cursor",
      "YQ".repeat(1_025),
    ]) {
      expect(() => decodeRunHistoryCursor(raw)).toThrow("Invalid run history cursor.");
    }
  });

  it("rejects structurally invalid cursor payloads", () => {
    const basePayload = {
      version: 1,
      workspaceId: "workspace-1",
      limit: 25,
      createdAt: "2026-01-01T00:00:00.000Z",
      runId: "run-9",
      runThreadId: "thread-1",
    };
    expect(() => decodeRunHistoryCursor(encode(basePayload))).not.toThrow();
    expect(() => decodeRunHistoryCursor(encode({ ...basePayload, version: 2 }))).toThrow(
      "Invalid run history cursor.",
    );
    expect(() => decodeRunHistoryCursor(encode({ ...basePayload, workspaceId: "" }))).toThrow(
      "Invalid run history cursor.",
    );
    expect(() =>
      decodeRunHistoryCursor(encode({ ...basePayload, workspaceId: "w".repeat(201) })),
    ).toThrow("Invalid run history cursor.");
    for (const limit of [0, 101, 1.5]) {
      expect(() => decodeRunHistoryCursor(encode({ ...basePayload, limit }))).toThrow(
        "Invalid run history cursor.",
      );
    }
    for (const key of ["createdAt", "runId", "runThreadId"] as const) {
      expect(() => decodeRunHistoryCursor(encode({ ...basePayload, [key]: "" }))).toThrow(
        "Invalid run history cursor.",
      );
    }
    for (const key of ["agentId", "threadId"] as const) {
      expect(() => decodeRunHistoryCursor(encode({ ...basePayload, [key]: "" }))).toThrow(
        "Invalid run history cursor.",
      );
      expect(() =>
        decodeRunHistoryCursor(encode({ ...basePayload, [key]: "x".repeat(201) })),
      ).toThrow("Invalid run history cursor.");
    }
    expect(() => decodeRunHistoryCursor(encode({ ...basePayload, status: "finished" }))).toThrow(
      "Invalid run history cursor.",
    );
    expect(() => decodeRunHistoryCursor(encode({ ...basePayload, extra: true }))).toThrow(
      "Invalid run history cursor.",
    );
    expect(() => decodeRunHistoryCursor(encode({ version: 1, limit: 50 }))).toThrow(
      "Invalid run history cursor.",
    );
  });
});
