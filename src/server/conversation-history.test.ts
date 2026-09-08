import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ThreadHistoryRequestSchema } from "../shared/contracts.js";
import { HISTORY_MAX_EVENT_BYTES, scanTranscriptHistoryFile } from "./conversation-history.js";
import { FileStore } from "./store.js";

async function openStore() {
  const root = await mkdtemp(join(tmpdir(), "nexestra-history-"));
  return FileStore.open({ root, workspacePath: root });
}

async function transcriptHash(store: FileStore, threadId: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(store.transcriptPath(threadId)))
    .digest("hex");
}

function parsed(input: unknown) {
  return ThreadHistoryRequestSchema.parse(input);
}

describe("conversation history", () => {
  it("primes the index at startup and pages latest without readEvents", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    for (let i = 0; i < 60; i += 1) {
      await store.createUserMessage(thread.id, `message ${i}`, []);
    }
    const spy = vi.spyOn(
      FileStore.prototype as unknown as {
        readEvents: (...args: unknown[]) => Promise<unknown[]>;
      },
      "readEvents",
    );
    const page = await store.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50 }),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(page.messages).toHaveLength(50);
    expect(page.messages[0]?.content).toBe("message 10");
    expect(page.messages.at(-1)?.content).toBe("message 59");
    expect(page.page).toMatchObject({
      totalMessages: 60,
      totalArtifacts: 0,
      firstMessageIndex: 11,
      lastMessageIndex: 60,
      afterCursor: null,
    });
    expect(page.page.beforeCursor).toBe(page.messages[0]?.id);
  });

  it("walks latest/before/after/around without gaps or duplicates after appends", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const messageIds: string[] = [];
    for (let i = 0; i < 150; i += 1) {
      const message = await store.createUserMessage(thread.id, `message ${i}`, []);
      messageIds.push(message.id);
    }
    const anchor = messageIds[99];
    if (!anchor) throw new Error("expected anchor");
    const around = await store.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50, around: anchor }),
    );
    expect(around.page.targetFound).toBe(true);
    expect(around.page.targetMessageId).toBe(anchor);
    expect(around.page.firstMessageIndex).toBe(76);
    expect(around.page.lastMessageIndex).toBe(125);
    expect(around.messages.map((entry) => entry.id)).toEqual(messageIds.slice(75, 125));

    const before = await store.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50, before: anchor }),
    );
    expect(before.messages.map((entry) => entry.id)).toEqual(messageIds.slice(49, 99));
    const after = await store.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50, after: anchor }),
    );
    expect(after.messages.map((entry) => entry.id)).toEqual(messageIds.slice(100, 150));
    const latestPage = await store.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50 }),
    );
    const mid = await store.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50, before: latestPage.messages[0]?.id }),
    );
    const first = await store.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50, before: mid.messages[0]?.id }),
    );
    const walked = new Set([
      ...latestPage.messages.map((entry) => entry.id),
      ...mid.messages.map((entry) => entry.id),
      ...first.messages.map((entry) => entry.id),
    ]);
    expect(first.messages.map((entry) => entry.id)).toEqual(messageIds.slice(0, 50));
    expect(walked.size).toBe(150);

    const added = await store.createUserMessage(thread.id, "message 150", []);
    const latest = await store.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50 }),
    );
    expect(latest.messages.at(-1)?.id).toBe(added.id);
    const resumed = await store.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50, after: messageIds[149] ?? "" }),
    );
    expect(resumed.messages.map((entry) => entry.id)).toEqual([added.id]);
  });

  it("keeps canonical final run/toolCall state beyond any fixed update window", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const trigger = await store.createUserMessage(thread.id, "@codex run this", []);
    const now = new Date().toISOString();
    const run = {
      id: "run-many-updates",
      threadId: thread.id,
      triggerMessageId: trigger.id,
      agentId: "agent-any",
      attempt: 1,
      status: "queued" as const,
      createdAt: now,
      updatedAt: now,
    };
    const tool = {
      id: "tool-many-updates",
      runId: run.id,
      threadId: thread.id,
      agentId: "agent-any",
      name: "read",
      permission: "read" as const,
      status: "running" as const,
      input: "{}",
      createdAt: now,
      updatedAt: now,
    };
    for (let i = 0; i < 513; i += 1) {
      await store.updateRun({ ...run, updatedAt: new Date(Date.now() + i).toISOString() });
      await store.updateToolCall({
        ...tool,
        updatedAt: new Date(Date.now() + i).toISOString(),
      });
    }
    await store.updateRun({
      ...run,
      status: "completed",
      updatedAt: new Date().toISOString(),
    });
    await store.updateToolCall({
      ...tool,
      status: "completed",
      summary: "done",
      updatedAt: new Date().toISOString(),
    });
    const page = await store.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50 }),
    );
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]).toMatchObject({ id: run.id, status: "completed" });
    expect(page.toolCalls).toHaveLength(1);
    expect(page.toolCalls[0]).toMatchObject({ id: tool.id, status: "completed" });
  }, 30_000);

  it("accepts own durable appends without restart and rejects external edits with 409", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const first = await store.createUserMessage(thread.id, "first", []);
    const second = await store.createUserMessage(thread.id, "second", []);
    const page = await store.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50 }),
    );
    expect(page.messages.map((entry) => entry.id)).toEqual([first.id, second.id]);
    await appendFile(store.transcriptPath(thread.id), '{"type":"message.created"}\n');
    await expect(
      store.historyPage(workspace.id, thread.id, parsed({ workspaceId: workspace.id })),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("serves empty threads and rejects missing non-empty transcripts explicitly", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const fresh = await store.createThread({ name: "Fresh" });
    const empty = await store.historyPage(
      workspace.id,
      fresh.id,
      parsed({ workspaceId: workspace.id }),
    );
    expect(empty.messages).toEqual([]);
    expect(empty.page).toMatchObject({
      totalMessages: 0,
      firstMessageIndex: 0,
      lastMessageIndex: 0,
    });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    await store.createUserMessage(thread.id, "will vanish", []);
    await unlink(store.transcriptPath(thread.id));
    await expect(
      store.historyPage(workspace.id, thread.id, parsed({ workspaceId: workspace.id })),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects anchors outside the thread and returns targetFound false for unknown around", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const message = await store.createUserMessage(thread.id, "only message", []);
    await expect(
      store.historyPage(
        workspace.id,
        thread.id,
        parsed({ workspaceId: workspace.id, before: "missing-anchor" }),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    const around = await store.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, around: "missing-anchor" }),
    );
    expect(around.page).toMatchObject({
      targetMessageId: "missing-anchor",
      targetFound: false,
    });
    expect(around.messages.map((entry) => entry.id)).toEqual([message.id]);
  });

  it("isolates workspaces and keeps the transcript read-only", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const other = await store.createWorkspace({ name: "Other" });
    const otherThread = await store.createThread({
      workspaceId: other.id,
      name: "Other general",
    });
    await expect(
      store.historyPage(other.id, thread.id, parsed({ workspaceId: other.id })),
    ).rejects.toMatchObject({ code: "not_found" });
    await store.createUserMessage(thread.id, "hash baseline", []);
    const before = await transcriptHash(store, thread.id);
    await store.historyPage(other.id, otherThread.id, parsed({ workspaceId: other.id }));
    await store.historyPage(workspace.id, thread.id, parsed({ workspaceId: workspace.id }));
    expect(await transcriptHash(store, thread.id)).toBe(before);
  });

  it("redacts stored credentials from page content, thread metadata, and artifacts", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const secret = "nexestra-history-fixture-secret";
    await store.createAgent({
      kind: "master",
      name: "Secret Master",
      handle: "secretmaster",
      description: "",
      instructions: "",
      accessMode: "ask",
      provider: {
        type: "custom",
        name: "Secret Provider",
        baseUrl: "https://example.com",
        model: "m",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });
    const message = await store.createUserMessage(
      thread.id,
      `plan with ${secret} inside`,
      [],
      [{ name: "plan-secret.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("p") }],
    );
    const page = await store.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id }),
    );
    expect(page.messages[0]?.id).toBe(message.id);
    expect(page.messages[0]?.content).toContain("[REDACTED]");
    expect(page.messages[0]?.content).not.toContain(secret);
    expect(JSON.stringify(page)).not.toContain(secret);
    expect(page.artifacts[0]?.name).toBe("plan-secret.txt");
    expect(page.page.totalArtifacts).toBe(1);
  });

  it("repairs torn tails and ignores unknown well-formed events at startup", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const thread = await store.createThread({ name: "Torn+Unknown" });
    await appendFile(store.transcriptPath(thread.id), '{"type":"future.event","sequence":5}\n');
    await appendFile(store.transcriptPath(thread.id), '{"type":"message.created","sequence":6');
    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const page = await reopened.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id }),
    );
    expect(page.messages).toEqual([]);
    expect(page.page.totalMessages).toBe(0);
  });

  it("classifies malformed, oversized, invalid UTF-8, and torn fixture lines deliberately", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-history-fixtures-"));
    const malformed = join(root, "malformed.jsonl");
    const oversized = join(root, "oversized.jsonl");
    const invalidUtf8 = join(root, "invalid-utf8.jsonl");
    const torn = join(root, "torn.jsonl");
    await writeFile(malformed, "{definitely not json}\n");
    await writeFile(oversized, `${"x".repeat(HISTORY_MAX_EVENT_BYTES + 4)}\n`);
    await writeFile(invalidUtf8, Buffer.from([0xff, 0x0a]));
    await writeFile(torn, '{"sequence":1}');
    const onLine = (line: string) => {
      try {
        JSON.parse(line);
        return { status: "unknown" as const };
      } catch {
        return { status: "malformed" as const };
      }
    };
    const malformedResult = await scanTranscriptHistoryFile(malformed, { onLine });
    const oversizedResult = await scanTranscriptHistoryFile(oversized, { onLine });
    const invalidResult = await scanTranscriptHistoryFile(invalidUtf8, { onLine });
    const tornResult = await scanTranscriptHistoryFile(torn, { onLine });
    expect(malformedResult).toMatchObject({ status: "ok", malformedLines: 1 });
    expect(oversizedResult).toMatchObject({ status: "ok", oversizedLines: 1 });
    expect(invalidResult).toMatchObject({ status: "ok", invalidUtf8Lines: 1 });
    expect(tornResult).toMatchObject({ status: "ok", tornTailLines: 1 });
    await rm(root, { recursive: true, force: true });
  });
  it("serves the first append to a startup-empty thread and unknown around fallback", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const fresh = await store.createThread({ name: "Fresh" });
    const empty = await store.historyPage(
      workspace.id,
      fresh.id,
      parsed({ workspaceId: workspace.id }),
    );
    expect(empty.page).toMatchObject({ totalMessages: 0 });
    const message = await store.createUserMessage(fresh.id, "first send", []);
    const page = await store.historyPage(
      workspace.id,
      fresh.id,
      parsed({ workspaceId: workspace.id }),
    );
    expect(page.page).toMatchObject({ totalMessages: 1, totalArtifacts: 0 });
    expect(page.messages.map((entry) => entry.id)).toEqual([message.id]);
    const around = await store.historyPage(
      workspace.id,
      fresh.id,
      parsed({ workspaceId: workspace.id, around: "missing" }),
    );
    expect(around.page).toMatchObject({ targetMessageId: "missing", targetFound: false });
    expect(around.messages.map((entry) => entry.id)).toEqual([message.id]);
  });

  it("serializes concurrent page reads with own durable appends", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const results = await Promise.all([
      store.createUserMessage(thread.id, "racing append", []),
      store.historyPage(workspace.id, thread.id, parsed({ workspaceId: workspace.id, limit: 5 })),
    ]);
    const page = results[1];
    expect(page.messages.length).toBeGreaterThanOrEqual(1);
    expect(page.page.totalMessages).toBeGreaterThanOrEqual(1);
  });
});
