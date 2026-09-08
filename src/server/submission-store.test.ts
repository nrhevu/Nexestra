import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadHistoryRequestSchema } from "../shared/contracts.js";
import { computeSubmissionFingerprint, FileStore, keyedUploadStorageId } from "./store.js";

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

type HandleStatShape = {
  stat(options?: { bigint?: boolean }): Promise<{ ino: bigint; dev: bigint }>;
};

async function fileHandlePrototype() {
  const probe = await open(join(tmpdir(), "nexestra-fh-probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as unknown as {
    sync: (...args: never[]) => Promise<void>;
    appendFile: (...args: never[]) => Promise<void>;
  };
  await probe.close();
  return prototype;
}

async function isTranscriptHandle(
  handle: HandleStatShape,
  expected: { ino: bigint; dev: bigint },
): Promise<boolean> {
  const stats = await handle.stat({ bigint: true });
  return stats.ino === expected.ino && stats.dev === expected.dev;
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

  it("replays keyed uploads on a thread created after startup without any prior history read", async () => {
    const store = await openStore();
    const workspaceId = store.listWorkspaces()[0]?.id;
    if (!workspaceId) throw new Error("expected workspace");
    const created = await store.createThread({ name: "Fresh" });
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("fresh file");
    const first = await store.createUserMessage(
      created.id,
      "fresh submission",
      [],
      [upload("fresh.bin", bytes)],
      [],
      requestId,
    );
    const replayed = await store.createUserMessage(
      created.id,
      "fresh submission",
      [],
      [upload("fresh.bin", bytes)],
      [],
      requestId,
    );
    expect(replayed.id).toBe(first.id);
    const lookedUp = await store.lookupUserSubmission(
      created.id,
      "fresh submission",
      [upload("fresh.bin", bytes)],
      requestId,
    );
    expect(lookedUp?.id).toBe(first.id);
    const data = await store.threadData(created.id);
    expect(data.messages).toHaveLength(1);
    expect(data.artifacts).toHaveLength(1);
  });

  it("recovers same-process retry and restart after an fsync failure that completed the original sync", async () => {
    const opened = await openStore();
    const seeded = await needsThread(opened);
    await writeFile(opened.transcriptPath(seeded.id), "");
    const store = await FileStore.open({
      root: opened.root,
      workspacePath: opened.workspacePath,
    });
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("durable payload");
    const prototype = await fileHandlePrototype();
    const originalSync = prototype.sync as unknown as (this: HandleStatShape) => Promise<void>;
    const transcriptStat = await stat(store.transcriptPath(thread.id), { bigint: true });
    let injected = false;
    let calledOriginal = false;
    const syncSpy = vi.spyOn(prototype, "sync").mockImplementation(function (
      this: HandleStatShape,
    ) {
      return isTranscriptHandle(this, transcriptStat).then((isTranscript) => {
        if (isTranscript && !injected) {
          injected = true;
          return originalSync.call(this).then(() => {
            calledOriginal = true;
            throw new Error("simulated fsync failure");
          });
        }
        return originalSync.call(this);
      });
    } as unknown as typeof prototype.sync);
    await expect(
      store.createUserMessage(
        thread.id,
        "keyed durable",
        [],
        [upload("payload.bin", bytes)],
        [],
        requestId,
      ),
    ).rejects.toThrow("simulated fsync failure");
    syncSpy.mockRestore();
    expect(injected).toBe(true);
    expect(calledOriginal).toBe(true);

    const replayed = await store.createUserMessage(
      thread.id,
      "keyed durable",
      [],
      [upload("payload.bin", bytes)],
      [],
      requestId,
    );
    expect(replayed.content).toBe("keyed durable");
    let data = await store.threadData(thread.id);
    expect(data.messages).toHaveLength(1);
    expect(data.artifacts).toHaveLength(1);

    const reopened = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    data = await reopened.threadData(thread.id);
    expect(data.messages).toHaveLength(1);
    expect(data.artifacts).toHaveLength(1);
    const lookedUp = await reopened.lookupUserSubmission(
      thread.id,
      "keyed durable",
      [upload("payload.bin", bytes)],
      requestId,
    );
    expect(lookedUp?.id).toBe(replayed.id);
  });

  it("syncs surviving cache bytes before replaying when fsync failed before the original sync", async () => {
    const opened = await openStore();
    const seeded = await needsThread(opened);
    await writeFile(opened.transcriptPath(seeded.id), "");
    const store = await FileStore.open({
      root: opened.root,
      workspacePath: opened.workspacePath,
    });
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("cache payload");
    const prototype = await fileHandlePrototype();
    const originalSync = prototype.sync as unknown as (this: HandleStatShape) => Promise<void>;
    const transcriptStat = await stat(store.transcriptPath(thread.id), { bigint: true });
    let failuresLeft = 2;
    let injected = false;
    let calledOriginal = false;
    const syncSpy = vi.spyOn(prototype, "sync").mockImplementation(function (
      this: HandleStatShape,
    ) {
      return isTranscriptHandle(this, transcriptStat).then((isTranscript) => {
        if (isTranscript && failuresLeft > 0) {
          injected = true;
          failuresLeft -= 1;
          return Promise.reject(new Error("simulated pre-fsync failure"));
        }
        if (isTranscript) calledOriginal = true;
        return originalSync.call(this);
      });
    } as unknown as typeof prototype.sync);
    await expect(
      store.createUserMessage(
        thread.id,
        "cache durable",
        [],
        [upload("cache.bin", bytes)],
        [],
        requestId,
      ),
    ).rejects.toThrow("simulated pre-fsync failure");
    expect(injected).toBe(true);
    expect(calledOriginal).toBe(false);

    const replayed = await store.createUserMessage(
      thread.id,
      "cache durable",
      [],
      [upload("cache.bin", bytes)],
      [],
      requestId,
    );
    syncSpy.mockRestore();
    expect(replayed.content).toBe("cache durable");
    expect(calledOriginal).toBe(true);
    const data = await store.threadData(thread.id);
    expect(data.messages).toHaveLength(1);
    expect(data.artifacts).toHaveLength(1);
  });

  it("keeps failing without yielding a message while the transcript cannot be synced and recovers later", async () => {
    const opened = await openStore();
    const seeded = await needsThread(opened);
    await writeFile(opened.transcriptPath(seeded.id), "");
    const store = await FileStore.open({
      root: opened.root,
      workspacePath: opened.workspacePath,
    });
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const prototype = await fileHandlePrototype();
    const originalSync = prototype.sync as unknown as (this: HandleStatShape) => Promise<void>;
    const transcriptStat = await stat(store.transcriptPath(thread.id), { bigint: true });
    let injected = false;
    const syncSpy = vi.spyOn(prototype, "sync").mockImplementation(function (
      this: HandleStatShape,
    ) {
      return isTranscriptHandle(this, transcriptStat).then((isTranscript) => {
        if (isTranscript) {
          injected = true;
          return Promise.reject(new Error("persistent fsync failure"));
        }
        return originalSync.call(this);
      });
    } as unknown as typeof prototype.sync);
    await expect(
      store.createUserMessage(thread.id, "persistent", [], [], [], requestId),
    ).rejects.toThrow("persistent fsync failure");
    await expect(
      store.lookupUserSubmission(thread.id, "persistent", [], requestId),
    ).rejects.toThrow("persistent fsync failure");
    expect(injected).toBe(true);
    syncSpy.mockRestore();

    const message = await store.lookupUserSubmission(thread.id, "persistent", [], requestId);
    expect(message?.content).toBe("persistent");
    expect((await store.threadData(thread.id)).messages).toHaveLength(1);
    expect((await store.threadData(thread.id)).artifacts).toHaveLength(0);
  });

  it("retries the same key after an append failure that wrote no bytes", async () => {
    const opened = await openStore();
    const seeded = await needsThread(opened);
    await writeFile(opened.transcriptPath(seeded.id), "");
    const store = await FileStore.open({
      root: opened.root,
      workspacePath: opened.workspacePath,
    });
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("payload");
    const prototype = await fileHandlePrototype();
    const originalAppend = prototype.appendFile as unknown as (
      this: HandleStatShape,
      ...args: unknown[]
    ) => Promise<void>;
    const transcriptStat = await stat(store.transcriptPath(thread.id), { bigint: true });
    let injected = false;
    const appendSpy = vi.spyOn(prototype, "appendFile").mockImplementation(function (
      this: HandleStatShape,
      ...args: unknown[]
    ) {
      return isTranscriptHandle(this, transcriptStat).then((isTranscript) => {
        if (isTranscript && !injected) {
          injected = true;
          return Promise.reject(new Error("simulated write failure"));
        }
        return originalAppend.apply(this, args);
      });
    } as unknown as typeof prototype.appendFile);
    await expect(
      store.createUserMessage(thread.id, "no bytes", [], [upload("p.bin", bytes)], [], requestId),
    ).rejects.toThrow("simulated write failure");
    appendSpy.mockRestore();
    expect(injected).toBe(true);

    const message = await store.createUserMessage(
      thread.id,
      "no bytes",
      [],
      [upload("p.bin", bytes)],
      [],
      requestId,
    );
    const data = await store.threadData(thread.id);
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]?.id).toBe(message.id);
    expect(data.artifacts).toHaveLength(1);
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
    const persistedState = JSON.parse(await readFile(store.stateFile, "utf8")) as {
      threads: Array<{ id: string; messageCount: number }>;
    };
    const persistedThread = persistedState.threads.find((entry) => entry.id === thread.id);
    expect(persistedThread?.messageCount).toBe(1);

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

  it("keeps retrying when the replay metadata flush itself fails", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const writeStateSpy = vi.spyOn(
      FileStore.prototype as unknown as { writeState: () => Promise<void> },
      "writeState",
    );
    writeStateSpy.mockRejectedValueOnce(new Error("disk full one"));
    await expect(
      store.createUserMessage(thread.id, "flush later", [], [], [], requestId),
    ).rejects.toThrow("disk full one");
    writeStateSpy.mockRejectedValueOnce(new Error("disk full two"));
    await expect(
      store.createUserMessage(thread.id, "flush later", [], [], [], requestId),
    ).rejects.toThrow("disk full two");
    writeStateSpy.mockRestore();
    const replayed = await store.createUserMessage(thread.id, "flush later", [], [], [], requestId);
    expect(replayed.content).toBe("flush later");
    const data = await store.threadData(thread.id);
    expect(data.messages).toHaveLength(1);
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

  it("repairs missing artifact frames from the frozen plan after restart", async () => {
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

    const reopened = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    const repaired = await reopened.createUserMessage(
      thread.id,
      "has attachment",
      [],
      [upload("a.bin", bytes)],
      [],
      requestId,
    );
    expect(repaired.id).toBe(message.id);
    const data = await reopened.threadData(thread.id);
    expect(data.messages).toHaveLength(1);
    expect(data.artifacts).toHaveLength(1);
    const artifactId = repaired.artifactIds[0];
    if (!artifactId) throw new Error("expected artifact");
    const content = await reopened.artifactContent(thread.id, artifactId);
    expect([...new Uint8Array(await readFile(content.file))]).toEqual([...bytes]);
  });

  it("repairs a torn artifact tail after restart and retry", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("torn payload");
    const message = await store.createUserMessage(
      thread.id,
      "torn",
      [],
      [upload("t.bin", bytes)],
      [],
      requestId,
    );
    const messageLine = (await transcriptLines(store, thread.id)).find((line) => {
      const parsed = JSON.parse(line) as { type?: string };
      return parsed.type === "message.created";
    });
    if (!messageLine) throw new Error("expected message line");
    const artifactPrefix = '{"type":"artifact.created","sequence":';
    await writeFile(store.transcriptPath(thread.id), messageLine + "\n" + artifactPrefix);
    const reopened = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    const repaired = await reopened.lookupUserSubmission(
      thread.id,
      "torn",
      [upload("t.bin", bytes)],
      requestId,
    );
    expect(repaired?.id).toBe(message.id);
    const data = await reopened.threadData(thread.id);
    expect(data.messages).toHaveLength(1);
    expect(data.artifacts).toHaveLength(1);
  });

  it("refuses to repair attachments while the thread is archived and repairs after restore", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("archived payload");
    const message = await store.createUserMessage(
      thread.id,
      "archive repair",
      [],
      [upload("a.bin", bytes)],
      [],
      requestId,
    );
    const messageLine = (await transcriptLines(store, thread.id)).find((line) => {
      const parsed = JSON.parse(line) as { type?: string };
      return parsed.type === "message.created";
    });
    if (!messageLine) throw new Error("expected message line");
    await writeFile(store.transcriptPath(thread.id), messageLine + "\n");
    const reopened = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    await reopened.archiveThread(thread.id);
    await expect(
      reopened.lookupUserSubmission(
        thread.id,
        "archive repair",
        [upload("a.bin", bytes)],
        requestId,
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("Restore this thread"),
    });
    expect((await reopened.threadData(thread.id)).artifacts).toHaveLength(0);
    await reopened.restoreThread(thread.id);
    const repaired = await reopened.lookupUserSubmission(
      thread.id,
      "archive repair",
      [upload("a.bin", bytes)],
      requestId,
    );
    expect(repaired?.id).toBe(message.id);
    expect((await reopened.threadData(thread.id)).artifacts).toHaveLength(1);
  });

  it("rejects legacy receipts without a frozen plan instead of guiding a duplicate", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("legacy");
    await store.createUserMessage(
      thread.id,
      "legacy plan missing",
      [],
      [upload("l.bin", bytes)],
      [],
      requestId,
    );
    const lines = await transcriptLines(store, thread.id);
    const messageLine = lines.find((line) => {
      const parsed = JSON.parse(line) as { type?: string };
      return parsed.type === "message.created";
    });
    if (!messageLine) throw new Error("expected message line");
    const parsedMessage = JSON.parse(messageLine) as Record<string, unknown>;
    const envelope = parsedMessage.submission as Record<string, unknown>;
    delete envelope.artifactPlan;
    await writeFile(store.transcriptPath(thread.id), JSON.stringify(parsedMessage) + "\n");
    const reopened = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    let error: unknown;
    try {
      await reopened.lookupUserSubmission(
        thread.id,
        "legacy plan missing",
        [upload("l.bin", bytes)],
        requestId,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "conflict" });
    const errorMessage = error instanceof Error ? error.message : String(error);
    expect(errorMessage).not.toContain("different request ID");
    expect(errorMessage).toContain("cannot repair");
  });

  it("rejects a receipt read when the transcript identity changed outside the app", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const message = await store.createUserMessage(thread.id, "rewrite me", [], [], [], requestId);
    const original = await readFile(store.transcriptPath(thread.id), "utf8");
    const rewritten = original.replace(message.content, "rewrote it");
    expect(rewritten).not.toBe(original);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(store.transcriptPath(thread.id), rewritten);
    await expect(
      store.lookupUserSubmission(thread.id, "rewrite me", [], requestId),
    ).rejects.toMatchObject({ code: "conflict" });
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

  it("flushes dirty thread metadata on lookupUserSubmission replays", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const writeStateSpy = vi.spyOn(
      FileStore.prototype as unknown as { writeState: () => Promise<void> },
      "writeState",
    );
    writeStateSpy.mockRejectedValueOnce(new Error("lookup flush one"));
    await expect(
      store.createUserMessage(thread.id, "lookup flush", [], [], [], requestId),
    ).rejects.toThrow("lookup flush one");
    writeStateSpy.mockRejectedValueOnce(new Error("lookup flush two"));
    await expect(
      store.lookupUserSubmission(thread.id, "lookup flush", [], requestId),
    ).rejects.toThrow("lookup flush two");
    writeStateSpy.mockRestore();
    const replayed = await store.lookupUserSubmission(thread.id, "lookup flush", [], requestId);
    expect(replayed?.content).toBe("lookup flush");
    const persistedState = JSON.parse(await readFile(store.stateFile, "utf8")) as {
      threads: Array<{ id: string; messageCount: number }>;
    };
    expect(persistedState.threads.find((entry) => entry.id === thread.id)?.messageCount).toBe(1);
  });

  it("computes a canonical JSON fingerprint across normalised uploads", async () => {
    const bytesA = new TextEncoder().encode("alpha bytes");
    const bytesB = new TextEncoder().encode("beta bytes");
    const uploadsA = [upload("alpha.txt", bytesA), upload("beta.txt", bytesB)];
    const content = "hello world";
    const base = computeSubmissionFingerprint(content, uploadsA);
    expect(computeSubmissionFingerprint(` ${content} `, uploadsA)).toBe(base);
    const slashUploads = [upload("folder/alpha.txt", bytesA), upload("nested\\beta.txt", bytesB)];
    expect(computeSubmissionFingerprint(content, slashUploads)).toBe(base);
    const reordered = [upload("beta.txt", bytesB), upload("alpha.txt", bytesA)];
    expect(computeSubmissionFingerprint(content, reordered)).not.toBe(base);
  });

  it("allocates repair sequences after an interleaved note and stays monotonic after restart", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("interleave payload");
    const message = await store.createUserMessage(
      thread.id,
      "interleaved upload",
      [],
      [upload("i.bin", bytes)],
      [],
      requestId,
    );
    const messageLine = (await transcriptLines(store, thread.id)).find((line) => {
      const parsed = JSON.parse(line) as { type?: string };
      return parsed.type === "message.created";
    });
    if (!messageLine) throw new Error("expected message line");
    await writeFile(store.transcriptPath(thread.id), messageLine + "\n");
    const firstReopen = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    const note = await firstReopen.createUserMessage(thread.id, "note after upload", []);
    expect(note.sequence).toBeGreaterThan(message.sequence);
    const secondReopen = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    const repaired = await secondReopen.lookupUserSubmission(
      thread.id,
      "interleaved upload",
      [upload("i.bin", bytes)],
      requestId,
    );
    expect(repaired?.id).toBe(message.id);
    const data = await secondReopen.threadData(thread.id);
    expect(data.messages).toHaveLength(2);
    expect(data.artifacts).toHaveLength(1);
    const artifact = data.artifacts[0];
    if (!artifact) throw new Error("expected artifact");
    expect(artifact.sequence).toBeGreaterThan(note.sequence);
    expect(artifact.sequence).toBe(note.sequence + 1);
    const sequences = data.messages.map((entry) => entry.sequence);
    sequences.push(artifact.sequence);
    expect(new Set(sequences).size).toBe(3);
    const next = await secondReopen.createUserMessage(thread.id, "after repair", []);
    expect(next.sequence).toBe(artifact.sequence + 1);
  });

  it("rejects a complete receipt whose keyed upload file disappeared from disk", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("gone file");
    const message = await store.createUserMessage(
      thread.id,
      "missing disk file",
      [],
      [upload("gone.bin", bytes)],
      [],
      requestId,
    );
    const artifactId = message.artifactIds[0];
    if (!artifactId) throw new Error("expected artifact");
    const file = (await store.artifactContent(thread.id, artifactId)).file;
    await unlink(file);
    await expect(
      store.lookupUserSubmission(
        thread.id,
        "missing disk file",
        [upload("gone.bin", bytes)],
        requestId,
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("missing"),
    });
  });

  it("rejects a complete receipt whose keyed upload file bytes changed", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("original bytes");
    const message = await store.createUserMessage(
      thread.id,
      "tampered file",
      [],
      [upload("tampered.bin", bytes)],
      [],
      requestId,
    );
    const artifactId = message.artifactIds[0];
    if (!artifactId) throw new Error("expected artifact");
    const file = (await store.artifactContent(thread.id, artifactId)).file;
    await writeFile(file, Buffer.from("different bytes"));
    await expect(
      store.lookupUserSubmission(
        thread.id,
        "tampered file",
        [upload("tampered.bin", bytes)],
        requestId,
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("no longer matches"),
    });
  });

  it("repairs a missing artifact frame and a missing keyed file from the replayed bytes", async () => {
    const store = await openStore();
    const thread = await needsThread(store);
    const requestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode("recover file bytes");
    const message = await store.createUserMessage(
      thread.id,
      "repair file",
      [],
      [upload("recover.bin", bytes)],
      [],
      requestId,
    );
    const messageLine = (await transcriptLines(store, thread.id)).find((line) => {
      const parsed = JSON.parse(line) as { type?: string };
      return parsed.type === "message.created";
    });
    if (!messageLine) throw new Error("expected message line");
    const artifactId = message.artifactIds[0];
    if (!artifactId) throw new Error("expected artifact");
    const file = (await store.artifactContent(thread.id, artifactId)).file;
    await unlink(file);
    await writeFile(store.transcriptPath(thread.id), messageLine + "\n");
    const reopened = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    const repaired = await reopened.lookupUserSubmission(
      thread.id,
      "repair file",
      [upload("recover.bin", bytes)],
      requestId,
    );
    expect(repaired?.id).toBe(message.id);
    const data = await reopened.threadData(thread.id);
    expect(data.artifacts).toHaveLength(1);
    const restored = (await reopened.artifactContent(thread.id, artifactId)).file;
    expect([...new Uint8Array(await readFile(restored))]).toEqual([...bytes]);
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
