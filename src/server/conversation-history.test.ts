import { createHash } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.restoreAllMocks();
});
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
  it("serves the first page after restart from the primed index without rescanning", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    for (let i = 0; i < 60; i += 1) {
      await store.createUserMessage(thread.id, `message ${i}`, []);
    }
    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const readEventsSpy = vi.spyOn(
      reopened as unknown as {
        readEvents: (...args: unknown[]) => Promise<unknown[]>;
      },
      "readEvents",
    );
    const primeSpy = vi.spyOn(
      reopened as unknown as {
        primeTranscriptIndex: (threadId: string) => Promise<unknown>;
      },
      "primeTranscriptIndex",
    );
    const page = await reopened.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50 }),
    );
    expect(readEventsSpy).not.toHaveBeenCalled();
    expect(primeSpy).not.toHaveBeenCalled();
    expect(page.messages).toHaveLength(50);
    expect(page.messages[0]?.content).toBe("message 10");
    expect(page.messages.at(-1)?.content).toBe("message 59");
  });

  it("keeps durable messages readable when state persistence fails and recovers sequences", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const writeStateSpy = vi.spyOn(
      FileStore.prototype as unknown as { writeState: () => Promise<void> },
      "writeState",
    );
    writeStateSpy.mockRejectedValueOnce(new Error("simulated disk full"));
    await expect(store.createUserMessage(thread.id, "durable despite failure", [])).rejects.toThrow(
      "simulated disk full",
    );
    writeStateSpy.mockRestore();
    const page = await store.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50 }),
    );
    expect(page.messages.map((entry) => entry.content)).toEqual(["durable despite failure"]);
    const firstSequence = page.messages[0]?.sequence ?? 0;
    const retried = await store.createUserMessage(thread.id, "after recovery", []);
    expect(retried.sequence).toBe(firstSequence + 1);
    const nextPage = await store.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50 }),
    );
    expect(nextPage.messages.map((entry) => entry.content)).toEqual([
      "durable despite failure",
      "after recovery",
    ]);
    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const recovered = await reopened.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50 }),
    );
    expect(recovered.messages.map((entry) => entry.content)).toEqual([
      "durable despite failure",
      "after recovery",
    ]);
  });

  it("handles anchors on an empty thread and detects externally created transcripts", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const fresh = await store.createThread({ name: "Fresh" });
    await expect(
      store.historyPage(
        workspace.id,
        fresh.id,
        parsed({ workspaceId: workspace.id, before: "missing-anchor" }),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      store.historyPage(
        workspace.id,
        fresh.id,
        parsed({ workspaceId: workspace.id, after: "missing-anchor" }),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    const around = await store.historyPage(
      workspace.id,
      fresh.id,
      parsed({ workspaceId: workspace.id, around: "missing-anchor" }),
    );
    expect(around.page).toMatchObject({
      totalMessages: 0,
      targetMessageId: "missing-anchor",
      targetFound: false,
    });
    expect(around.messages).toEqual([]);
    await writeFile(
      store.transcriptPath(fresh.id),
      '{"type":"message.created","sequence":7}\n',
      "utf8",
    );
    await expect(
      store.historyPage(workspace.id, fresh.id, parsed({ workspaceId: workspace.id })),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("ignores blank and whitespace lines across restart with valid UTF-8 messages", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const thread = await store.createThread({ name: "Blanks" });
    const first = await store.createUserMessage(thread.id, "bé 🚀 first", []);
    const second = await store.createUserMessage(thread.id, "second ünïcode", []);
    const original = await readFile(store.transcriptPath(thread.id), "utf8");
    const lines = original.trimEnd().split("\n");
    if (!lines[0] || !lines[1]) throw new Error("expected two message lines");
    const blanked = ["", "   ", "\t", lines[0], " \t ", lines[1], " ", ""].join("\n");
    await writeFile(store.transcriptPath(thread.id), `${blanked}\n`, "utf8");
    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const page = await reopened.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50 }),
    );
    expect(page.messages.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(page.messages.map((entry) => entry.content)).toEqual(["bé 🚀 first", "second ünïcode"]);
    expect(page.page).toMatchObject({ totalMessages: 2, totalArtifacts: 0 });
  });

  it("classifies whitespace-only lines as ignorable in the scanner", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-history-blank-fixtures-"));
    const file = join(root, "blank.jsonl");
    await writeFile(file, '\n   \n\t\n{"sequence":1}\n\n', "utf8");
    const result = await scanTranscriptHistoryFile(file, {
      onLine: (line) => {
        JSON.parse(line);
        return { status: "unknown" };
      },
    });
    expect(result).toMatchObject({
      status: "ok",
      malformedLines: 0,
      invalidUtf8Lines: 0,
      tornTailLines: 0,
      lineCount: 5,
    });
    await rm(root, { recursive: true, force: true });
  });

  it("detects same-size rewrites even when the millisecond mtime matches", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    await store.createUserMessage(thread.id, "alpha", []);
    const file = store.transcriptPath(thread.id);
    const original = await readFile(file, "utf8");
    const replacement = original.replace("alpha", "beta!");
    expect(Buffer.byteLength(replacement, "utf8")).toBe(Buffer.byteLength(original, "utf8"));
    const before = await stat(file);
    await writeFile(file, replacement, "utf8");
    await utimes(file, before.mtime, before.mtime);
    await expect(
      store.historyPage(workspace.id, thread.id, parsed({ workspaceId: workspace.id })),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("uses highest-sequence run/tool state on physically out-of-order legacy transcripts", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const trigger = await store.createUserMessage(thread.id, "@codex run this", []);
    const now = new Date().toISOString();
    const run = {
      id: "run-out-of-order",
      threadId: thread.id,
      triggerMessageId: trigger.id,
      agentId: "agent-any",
      attempt: 1,
      status: "running" as const,
      createdAt: now,
      updatedAt: now,
    };
    const tool = {
      id: "tool-out-of-order",
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
    await store.updateRun(run);
    await store.updateRun({ ...run, status: "failed", updatedAt: new Date().toISOString() });
    await store.updateRun({ ...run, status: "completed", updatedAt: new Date().toISOString() });
    await store.updateToolCall(tool);
    await store.updateToolCall({ ...tool, status: "failed", updatedAt: new Date().toISOString() });
    await store.updateToolCall({
      ...tool,
      status: "completed",
      updatedAt: new Date().toISOString(),
    });
    const file = store.transcriptPath(thread.id);
    const raw = await readFile(file, "utf8");
    const lines = raw.trimEnd().split("\n");
    const [messageLine, runOne, runTwo, runThree, toolOne, toolTwo, toolThree] = lines;
    if (!messageLine || !runOne || !runTwo || !runThree || !toolOne || !toolTwo || !toolThree) {
      throw new Error("expected seven fixture lines");
    }
    const shuffled = [messageLine, runThree, toolThree, runOne, toolOne, runTwo, toolTwo];
    await writeFile(file, `${shuffled.join("\n")}\n`, "utf8");
    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const data = await reopened.threadData(thread.id);
    const page = await reopened.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 50 }),
    );
    expect(page.runs).toHaveLength(1);
    expect(page.toolCalls).toHaveLength(1);
    expect(page.runs[0]?.status).toBe("completed");
    expect(page.toolCalls[0]?.status).toBe("completed");
    expect(page.runs[0]?.status).toBe(data.runs[0]?.status);
    expect(page.toolCalls[0]?.status).toBe(data.toolCalls[0]?.status);
  });

  it("rejects pages over the page byte budget and serves bounded smaller pages", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const thread = store.listThreads(workspace?.id ?? "")[0];
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const createdAt = new Date().toISOString();
    const messageLines: string[] = [];
    const artifactLines: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const messageId = `message-budget-${String(i).padStart(3, "0")}`;
      const artifactIds = Array.from(
        { length: 40 },
        (_, j) => `artifact-budget-${String(i).padStart(3, "0")}-${String(j).padStart(2, "0")}`,
      );
      const sequence = i * 41 + 1;
      messageLines.push(
        JSON.stringify({
          type: "message.created",
          sequence,
          message: {
            id: messageId,
            threadId: thread.id,
            sequence,
            author: { kind: "user", id: "local-user", name: "Budget Tester" },
            content: `budget message ${i}`,
            mentions: [],
            knowledgeReferences: [],
            artifactIds,
            createdAt,
          },
        }),
      );
      for (let j = 0; j < 40; j += 1) {
        artifactLines.push(
          JSON.stringify({
            type: "artifact.created",
            sequence: sequence + j + 1,
            artifact: {
              id: artifactIds[j],
              threadId: thread.id,
              messageId,
              sequence: sequence + j + 1,
              kind: "link",
              source: "reference",
              name: "n".repeat(255),
              url: `https://example.com/${"u".repeat(4_030)}`,
              createdAt,
            },
          }),
        );
      }
    }
    await writeFile(
      store.transcriptPath(thread.id),
      `${[...messageLines, ...artifactLines].join("\n")}\n`,
      "utf8",
    );
    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    await expect(
      reopened.historyPage(
        workspace.id,
        thread.id,
        parsed({ workspaceId: workspace.id, limit: 50 }),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    const bounded = await reopened.historyPage(
      workspace.id,
      thread.id,
      parsed({ workspaceId: workspace.id, limit: 10 }),
    );
    expect(bounded.messages).toHaveLength(10);
    expect(bounded.artifacts).toHaveLength(400);
    expect(bounded.page).toMatchObject({ totalMessages: 50, totalArtifacts: 2_000 });
  });
});
