import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadHistoryRequestSchema } from "../shared/contracts.js";
import { FileStore, keyedUploadStorageId } from "./store.js";

async function openStore() {
  const root = await mkdtemp(join(tmpdir(), "nexestra-submission-"));
  return FileStore.open({ root, workspacePath: root });
}

function upload(name: string, bytes: Uint8Array) {
  return { name, mediaType: "text/plain", bytes };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function transcriptLines(store: FileStore, threadId: string): Promise<string[]> {
  const text = await readFile(store.transcriptPath(threadId), "utf8");
  return text.split("\n").filter((line) => line.trim().length > 0);
}

function documentRevisions(store: FileStore, id: string): number {
  const item = store.getKnowledge(id);
  return item?.kind === "document" ? item.revisions.length : 0;
}

async function needsThread(store: FileStore) {
  const thread = store.listThreads()[0];
  if (!thread) throw new Error("expected seeded thread");
  return thread;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recoverable user submissions", () => {
  it("persists only hashed receipt metadata and replays the same key without a second message", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const contents = "hello keyed world";
    const first = await store.createUserMessage(
      thread.id,
      contents,
      [{ agentId: "agent-any", handle: "architect" }],
      [],
      [],
      requestId,
    );

    expect(JSON.stringify(first)).not.toContain("submission");
    expect(JSON.stringify(first)).not.toContain("requestId");
    const raw = await readFile(store.transcriptPath(thread.id), "utf8");
    expect(raw).not.toContain(requestId);
    expect(raw).toContain('"submission"');
    expect(raw).toContain('"requestIdHash"');
    expect(raw).toContain('"fingerprint"');

    const lookedUp = await store.lookupUserSubmission(thread.id, contents, [], requestId);
    expect(lookedUp?.id).toBe(first.id);
    expect(lookedUp?.mentions).toEqual([{ agentId: "agent-any", handle: "architect" }]);

    const replayed = await store.createUserMessage(
      thread.id,
      contents,
      [{ agentId: "agent-any", handle: "architect" }],
      [],
      [],
      requestId,
    );
    expect(replayed.id).toBe(first.id);
    expect(await transcriptLines(store, thread.id)).toHaveLength(1);
    expect(store.getThread(thread.id)?.messageCount).toBe(1);

    const upper = await store.lookupUserSubmission(
      thread.id,
      contents,
      [],
      requestId.toUpperCase(),
    );
    expect(upper?.id).toBe(first.id);
  });

  it("conflicts on the same key with a different payload and keeps other messages independent", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    await store.createUserMessage(thread.id, "plan A", [], [], [], requestId);

    await expect(
      store.lookupUserSubmission(thread.id, "plan B", [], requestId),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.createUserMessage(thread.id, "plan B", [], [], [], requestId),
    ).rejects.toMatchObject({ code: "conflict" });

    const withUploads = crypto.randomUUID();
    const bytesA = new TextEncoder().encode("alpha");
    const bytesB = new TextEncoder().encode("beta");
    await store.createUserMessage(
      thread.id,
      "files",
      [],
      [upload("a.txt", bytesA)],
      [],
      withUploads,
    );
    await expect(
      store.createUserMessage(thread.id, "files", [], [upload("a.txt", bytesB)], [], withUploads),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.createUserMessage(thread.id, "files", [], [upload("b.txt", bytesA)], [], withUploads),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.createUserMessage(
        thread.id,
        "files",
        [],
        [upload("a.txt", bytesA), upload("b.txt", bytesA)],
        [],
        withUploads,
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    const differentKey = crypto.randomUUID();
    const second = await store.createUserMessage(thread.id, "plan A", [], [], [], differentKey);
    const lookedUpOriginal = await store.lookupUserSubmission(thread.id, "plan A", [], requestId);
    expect(second.id).not.toBe(lookedUpOriginal?.id);
    expect(await store.lookupUserSubmission(thread.id, "plan A", [], differentKey)).toMatchObject({
      id: second.id,
    });
    expect(store.getThread(thread.id)?.messageCount).toBe(3);

    const otherThread = await store.createThread({ name: "Other" });
    const third = await store.createUserMessage(otherThread.id, "plan A", [], [], [], requestId);
    const originalAgain = await store.lookupUserSubmission(thread.id, "plan A", [], requestId);
    expect(third.id).not.toBe(originalAgain?.id);
    expect((await store.lookupUserSubmission(otherThread.id, "plan A", [], requestId))?.id).toBe(
      third.id,
    );
  });

  it("serializes concurrent same-key creates into exactly one stored message", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const results = await Promise.all([
      store.createUserMessage(thread.id, "once", [], [], [], requestId),
      store.createUserMessage(thread.id, "once", [], [], [], requestId),
      store.createUserMessage(thread.id, "once", [], [], [], requestId),
    ]);
    const ids = new Set(results.map((message) => message.id));
    expect(ids.size).toBe(1);
    expect(await transcriptLines(store, thread.id)).toHaveLength(1);
    expect(store.getThread(thread.id)?.messageCount).toBe(1);
  });

  it("restart dedupe preserves mentions, knowledge pins, and reuses upload files", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const document = await store.createKnowledgeDocument(
      { name: "Architecture guide", handle: "architecture" },
      { name: "a.md", mediaType: "text/markdown", bytes: new TextEncoder().encode("# A\n") },
    );
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("diagram");
    const message = await store.createUserMessage(
      thread.id,
      "design",
      [{ agentId: "agent-any", handle: "architect" }],
      [upload("diagram.bin", bytes)],
      [{ knowledgeId: document.id, handle: document.handle }],
      requestId,
    );
    const revisions = documentRevisions(store, document.id);
    const artifactFile = join(store.artifactDirectory, thread.id);
    expect(await readdir(artifactFile)).toHaveLength(1);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const lookedUp = await reopened.lookupUserSubmission(
      thread.id,
      "design",
      [upload("diagram.bin", bytes)],
      requestId,
    );
    expect(lookedUp).toMatchObject({
      id: message.id,
      mentions: [{ agentId: "agent-any", handle: "architect" }],
      knowledgeReferences: [{ knowledgeId: document.id, handle: document.handle }],
    });
    const replayed = await reopened.createUserMessage(
      thread.id,
      "design",
      [{ agentId: "agent-any", handle: "architect" }],
      [upload("diagram.bin", bytes)],
      [{ knowledgeId: document.id, handle: document.handle }],
      requestId,
    );
    expect(replayed.id).toBe(message.id);
    const data = await reopened.threadData(thread.id);
    expect(data.messages).toHaveLength(1);
    expect(data.artifacts).toHaveLength(1);
    expect(documentRevisions(reopened, document.id)).toBe(revisions);
    expect(await readdir(artifactFile)).toHaveLength(1);
  });

  it("keeps a durable keyed submission readable when state persistence fails and sequences recover", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const workspaceId = store.listWorkspaces()[0]?.id;
    if (!workspaceId) throw new Error("expected workspace");
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("payload");
    const writeStateSpy = vi.spyOn(
      FileStore.prototype as unknown as { writeState: () => Promise<void> },
      "writeState",
    );
    writeStateSpy.mockRejectedValueOnce(new Error("simulated disk full"));
    await expect(
      store.createUserMessage(
        thread.id,
        "durable keyed",
        [],
        [upload("payload.bin", bytes)],
        [],
        requestId,
      ),
    ).rejects.toThrow("simulated disk full");
    writeStateSpy.mockRestore();

    const saved = await store.lookupUserSubmission(
      thread.id,
      "durable keyed",
      [upload("payload.bin", bytes)],
      requestId,
    );
    expect(saved).toMatchObject({ threadId: thread.id, content: "durable keyed" });
    const artifactId = saved?.artifactIds[0];
    expect(artifactId).toBeTruthy();
    const artifactFiles = await readdir(join(store.artifactDirectory, thread.id));
    expect(artifactFiles).toHaveLength(1);

    const replayed = await store.createUserMessage(
      thread.id,
      "durable keyed",
      [],
      [upload("payload.bin", bytes)],
      [],
      requestId,
    );
    expect(replayed.id).toBe(saved?.id);

    const next = await store.createUserMessage(thread.id, "after recovery", []);
    expect(next.sequence).toBe((saved?.sequence ?? 0) + (saved?.artifactIds.length ?? 0) + 1);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const data = await reopened.threadData(thread.id);
    expect(data.messages.map((entry) => entry.content)).toEqual([
      "durable keyed",
      "after recovery",
    ]);
    expect(data.artifacts).toHaveLength(1);
    expect(reopened.getThread(thread.id)?.messageCount).toBe(2);
  });

  it("leaves legacy unkeyed messages unchanged and lookup finds no receipt", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const message = await store.createUserMessage(thread.id, "legacy", []);
    const raw = await readFile(store.transcriptPath(thread.id), "utf8");
    expect(raw).not.toContain("submission");
    expect(
      await store.lookupUserSubmission(thread.id, "legacy", [], crypto.randomUUID()),
    ).toBeUndefined();
    expect((await store.threadData(thread.id)).messages).toEqual([
      expect.objectContaining({ id: message.id, content: "legacy" }),
    ]);
  });

  it("byte-verifies leftover keyed upload files and reuses them without extra copies", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("same bytes");
    const file = join(
      store.artifactDirectory,
      thread.id,
      keyedUploadStorageId(thread.id, requestId, 0, sha256(bytes)),
    );
    await mkdir(join(store.artifactDirectory, thread.id), { recursive: true });
    await writeFile(file, bytes);
    const before = await stat(file, { bigint: true });

    const message = await store.createUserMessage(
      thread.id,
      "upload reuse",
      [],
      [upload("x.bin", bytes)],
      [],
      requestId,
    );
    const after = await stat(file, { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ctimeNs).toBe(before.ctimeNs);
    expect(await readdir(join(store.artifactDirectory, thread.id))).toHaveLength(1);
    const artifactId = message.artifactIds[0];
    if (!artifactId) throw new Error("expected artifact");
    const content = await store.artifactContent(thread.id, artifactId);
    expect([...new Uint8Array(await readFile(content.file))]).toEqual([...bytes]);
  });

  it("conflicts when a leftover keyed upload file has different bytes", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("expected");
    const file = join(
      store.artifactDirectory,
      thread.id,
      keyedUploadStorageId(thread.id, requestId, 0, sha256(bytes)),
    );
    await mkdir(join(store.artifactDirectory, thread.id), { recursive: true });
    await writeFile(file, new TextEncoder().encode("stale"));

    await expect(
      store.createUserMessage(
        thread.id,
        "upload conflict",
        [],
        [upload("x.bin", bytes)],
        [],
        requestId,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await store.threadData(thread.id)).messages).toHaveLength(0);
  });

  it("conflicts when a stored submission is missing its artifact records", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("attachment");
    const message = await store.createUserMessage(
      thread.id,
      "has attachment",
      [],
      [upload("a.bin", bytes)],
      [],
      requestId,
    );
    const lines = await transcriptLines(store, thread.id);
    const kept = lines.filter((line) => {
      const parsed = JSON.parse(line) as { type?: string };
      return parsed.type === "message.created";
    });
    await writeFile(store.transcriptPath(thread.id), kept.join("\n") + "\n");
    expect(message.artifactIds).toHaveLength(1);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    await expect(
      reopened.lookupUserSubmission(
        thread.id,
        "has attachment",
        [upload("a.bin", bytes)],
        requestId,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const workspaceId = store.listWorkspaces()[0]?.id;
    if (!workspaceId) throw new Error("expected workspace");
    const page = await reopened.historyPage(
      workspaceId,
      thread.id,
      ThreadHistoryRequestSchema.parse({ workspaceId, limit: 50 }),
    );
    expect(page.messages.map((entry) => entry.content)).toEqual(["has attachment"]);
  });

  it("marks malformed submission envelopes unreliable yet keeps torn/unknown/blank line recovery working", async () => {
    const goodStore = await openStore();
    const goodThread = await needsThread(goodStore);
    const goodRequest = crypto.randomUUID();
    await goodStore.createUserMessage(goodThread.id, "clean", [], [], [], goodRequest);
    await appendFile(
      goodStore.transcriptPath(goodThread.id),
      '\n{"type":"widget.updated","sequence":77}\n\nbroken-json-tail',
    );
    const reopened = await FileStore.open({
      root: goodStore.root,
      workspacePath: goodStore.workspacePath,
    });
    await expect(
      reopened.lookupUserSubmission(goodThread.id, "clean", [], goodRequest),
    ).resolves.toMatchObject({ content: "clean" });
    const goodWorkspaceId = goodStore.listWorkspaces()[0]?.id;
    if (!goodWorkspaceId) throw new Error("expected workspace");
    const goodPage = await reopened.historyPage(
      goodWorkspaceId,
      goodThread.id,
      ThreadHistoryRequestSchema.parse({ workspaceId: goodWorkspaceId, limit: 50 }),
    );
    expect(goodPage.messages.map((entry) => entry.content)).toEqual(["clean"]);

    const badStore = await openStore();
    const badThread = await needsThread(badStore);
    const badRequest = crypto.randomUUID();
    await badStore.createUserMessage(badThread.id, "first", [], [], [], badRequest);
    const lines = await transcriptLines(badStore, badThread.id);
    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    const malformed = {
      ...first,
      sequence: (first.sequence as number) + 1,
      submission: { requestIdHash: "short" },
    };
    await appendFile(
      badStore.transcriptPath(badThread.id),
      "\n" + JSON.stringify(malformed) + "\n",
    );
    const reopenedBad = await FileStore.open({
      root: badStore.root,
      workspacePath: badStore.workspacePath,
    });
    const badWorkspaceId = badStore.listWorkspaces()[0]?.id;
    if (!badWorkspaceId) throw new Error("expected workspace");
    await expect(
      reopenedBad.historyPage(
        badWorkspaceId,
        badThread.id,
        ThreadHistoryRequestSchema.parse({ workspaceId: badWorkspaceId, limit: 50 }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("never leaks receipt metadata through thread data, search, history, export, or state", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const workspaceId = store.listWorkspaces()[0]?.id;
    if (!workspaceId) throw new Error("expected workspace");
    const requestId = crypto.randomUUID();
    const message = await store.createUserMessage(
      thread.id,
      "needle phrase",
      [],
      [upload("n.bin", new TextEncoder().encode("n"))],
      [],
      requestId,
    );

    const data = await store.threadData(thread.id);
    const serializedData = JSON.stringify(data);
    expect(serializedData).not.toContain("requestIdHash");
    expect(serializedData).not.toContain("fingerprint");
    expect(serializedData).not.toContain(requestId);

    const page = await store.historyPage(
      workspaceId,
      thread.id,
      ThreadHistoryRequestSchema.parse({ workspaceId, limit: 50 }),
    );
    const serializedPage = JSON.stringify(page);
    expect(serializedPage).not.toContain("requestIdHash");
    expect(serializedPage).not.toContain("fingerprint");

    const search = await store.searchMessages({ workspaceId, q: "needle", archived: "all" });
    expect(search.matches.map((hit) => hit.messageId)).toContain(message.id);
    const serializedSearch = JSON.stringify(search);
    expect(serializedSearch).not.toContain("requestIdHash");
    expect(serializedSearch).not.toContain("fingerprint");
    expect(serializedSearch).not.toContain(requestId);

    const exportText = await store.exportThreadMarkdown(thread.id);
    expect(exportText).not.toContain("requestIdHash");
    expect(exportText).not.toContain(requestId);

    const state = await readFile(store.stateFile, "utf8");
    expect(state).not.toContain("requestIdHash");
    expect(state).not.toContain("fingerprint");
    expect(state).not.toContain(requestId);
  });

  it("rejects malformed request IDs before reading or writing", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    await expect(
      store.createUserMessage(thread.id, "bad id", [], [], [], "not-a-uuid"),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      store.lookupUserSubmission(thread.id, "bad id", [], "not-a-uuid"),
    ).rejects.toMatchObject({ code: "invalid" });
    expect((await store.threadData(thread.id)).messages).toHaveLength(0);
  });
});
