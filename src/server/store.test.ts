import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileStore, StoreError } from "./store.js";

async function openStore() {
  const root = await mkdtemp(join(tmpdir(), "nexestra-store-"));
  return FileStore.open({ root, workspacePath: root });
}

describe("FileStore", () => {
  it("keeps every participant's messages in one append-only thread file", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const user = await store.createUserMessage(thread.id, "@codex xin chào", [
      { agentId: agent.id, handle: agent.handle },
    ]);
    await store.createAgentMessage(thread.id, agent, "Chào bạn.", user.id);

    const data = await store.threadData(thread.id);
    expect(data.messages.map((message) => message.author.kind)).toEqual(["user", "agent"]);
    expect(data.messages[1]?.triggerMessageId).toBe(user.id);
    const transcript = await readFile(store.transcriptPath(thread.id), "utf8");
    expect(transcript).toContain("@codex xin chào");
    expect(transcript).toContain("Chào bạn.");
  });

  it("never writes a custom provider key to public state or transcripts", async () => {
    const store = await openStore();
    const secret = "sk-super-secret";
    const agent = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Local gateway",
        baseUrl: "http://127.0.0.1:11434/v1/",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });

    expect(store.getCredential(agent.id)).toBe(secret);
    expect(await readFile(store.stateFile, "utf8")).not.toContain(secret);
    expect(JSON.stringify(store.listAgents())).not.toContain(secret);
  });

  it("rejects unsafe custom provider URLs", async () => {
    const store = await openStore();
    const input = {
      kind: "master" as const,
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: {
        type: "custom" as const,
        name: "Gateway",
        model: "model-a",
        protocol: "openai-chat" as const,
      },
    };

    await expect(
      store.createAgent({
        ...input,
        provider: { ...input.provider, baseUrl: "http://example.com/v1" },
      }),
    ).rejects.toBeInstanceOf(StoreError);
    await expect(
      store.createAgent({
        ...input,
        provider: { ...input.provider, baseUrl: "https://user:pass@example.com/v1?token=x" },
      }),
    ).rejects.toBeInstanceOf(StoreError);
  });

  it("rejects duplicate handles case-insensitively", async () => {
    const store = await openStore();
    await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });

    await expect(
      store.createAgent({
        kind: "worker",
        name: "Other",
        handle: "CODEX",
        description: "",
        instructions: "",
        harness: "opencode",
      }),
    ).rejects.toBeInstanceOf(StoreError);
  });

  it("creates a task directly in the selected board column", async () => {
    const store = await openStore();
    const task = await store.createTask({
      title: "Review",
      description: "",
      status: "in_progress",
      assigneeId: null,
      threadId: null,
    });
    expect(task.status).toBe("in_progress");
  });

  it("replays message order after restart and marks an unfinished run interrupted", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const first = await store.createUserMessage(thread.id, "một", []);
    const second = await store.createUserMessage(thread.id, "hai", []);
    const now = new Date().toISOString();
    await store.updateRun({
      id: crypto.randomUUID(),
      threadId: thread.id,
      triggerMessageId: second.id,
      agentId: crypto.randomUUID(),
      attempt: 1,
      status: "running",
      createdAt: now,
      updatedAt: now,
    });

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const data = await reopened.threadData(thread.id);
    expect(data.messages.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(data.runs[0]?.status).toBe("interrupted");
  });

  it("repairs a partial JSONL tail before appending another event", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const first = await store.createUserMessage(thread.id, "trước crash", []);
    await appendFile(store.transcriptPath(thread.id), '{"type":"message.created","sequence":2');

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const second = await reopened.createUserMessage(thread.id, "sau crash", []);
    const data = await reopened.threadData(thread.id);

    expect(data.messages.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(second.sequence).toBe(2);
  });

  it("completes a recovered run when its reply was already persisted", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const trigger = await store.createUserMessage(thread.id, "@codex trả lời", [
      { agentId: agent.id, handle: agent.handle },
    ]);
    const now = new Date().toISOString();
    const run = {
      id: crypto.randomUUID(),
      threadId: thread.id,
      triggerMessageId: trigger.id,
      agentId: agent.id,
      attempt: 1,
      status: "running" as const,
      createdAt: now,
      updatedAt: now,
    };
    await store.updateRun(run);
    await store.createAgentMessage(thread.id, agent, "reply đã sync", trigger.id);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const data = await reopened.threadData(thread.id);
    expect(data.runs[0]?.status).toBe("completed");
  });
});
