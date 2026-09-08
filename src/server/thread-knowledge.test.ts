import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileStore } from "./store.js";

describe("thread knowledge archive guard", () => {
  it("rejects a legacy document reference on an archived thread before writes, then pins after restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-thread-knowledge-"));
    const originalBytes = new TextEncoder().encode("# Legacy original");
    const created = await FileStore.open({ root, workspacePath: root });
    const item = await created.createKnowledgeDocument(
      { name: "Legacy notes", handle: "legacy-notes", description: "" },
      { name: "legacy.md", mediaType: "text/markdown", bytes: originalBytes },
    );
    if (item.kind !== "document") throw new Error("expected document");
    const thread = created.listThreads()[0];
    if (!thread) throw new Error("expected seeded thread");

    const legacyStoragePath = join(
      "workspaces",
      item.workspaceId,
      "knowledge",
      item.id,
      "document",
    );
    const legacyRoot = join(created.root, legacyStoragePath);
    const originalRevisionFile = join(created.root, item.storagePath);
    await writeFile(legacyRoot, await readFile(originalRevisionFile));
    await rm(dirname(originalRevisionFile), { recursive: true, force: true });
    const stateFile = join(created.root, "state.json");
    const state = JSON.parse(await readFile(stateFile, "utf8")) as {
      knowledge: Array<Record<string, unknown>>;
    };
    state.knowledge = state.knowledge.map((entry) =>
      entry.id === item.id
        ? {
            ...entry,
            storagePath: legacyStoragePath,
            revisions: [],
            currentRevisionId: undefined,
          }
        : entry,
    );
    await writeFile(stateFile, `${JSON.stringify(state)}\n`);

    const store = await FileStore.open({ root, workspacePath: root });
    const archived = await store.archiveThread(thread.id);
    expect(archived.archived).toBe(true);

    const stateBefore = await readFile(store.stateFile, "utf8");
    const transcriptBefore = await readFile(store.transcriptPath(thread.id), "utf8").catch(
      () => "",
    );
    const itemRoot = join(store.root, "workspaces", item.workspaceId, "knowledge", item.id);
    const itemEntriesBefore = (await readdir(itemRoot)).sort();
    const artifactRoot = join(store.artifactDirectory, thread.id);
    const artifactEntriesBefore = (await readdir(artifactRoot).catch(() => [])).sort();

    await expect(
      store.createUserMessage(
        thread.id,
        "Use #legacy-notes",
        [],
        [],
        [{ knowledgeId: item.id, handle: item.handle }],
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    expect(await readFile(store.stateFile, "utf8")).toBe(stateBefore);
    expect(await readFile(store.transcriptPath(thread.id), "utf8").catch(() => "")).toBe(
      transcriptBefore,
    );
    expect((await readdir(itemRoot)).sort()).toEqual(itemEntriesBefore);
    expect((await readdir(artifactRoot).catch(() => [])).sort()).toEqual(artifactEntriesBefore);
    const untouched = store.getKnowledge(item.id);
    if (untouched?.kind !== "document") throw new Error("expected untouched document");
    expect(untouched.revisions).toEqual([]);
    expect(untouched.currentRevisionId).toBeUndefined();
    expect(untouched.storagePath).toBe(legacyStoragePath);

    await store.restoreThread(thread.id);
    const message = await store.createUserMessage(
      thread.id,
      "Use #legacy-notes",
      [],
      [],
      [{ knowledgeId: item.id, handle: item.handle }],
    );
    expect(message.knowledgeReferences[0]?.revisionId).toBeTruthy();
    const captured = store.getKnowledge(item.id);
    if (captured?.kind !== "document") throw new Error("expected captured document");
    expect(captured.revisions).toHaveLength(1);
    expect(captured.currentRevisionId).toBe(message.knowledgeReferences[0]?.revisionId);
    const capturedContent = await store.documentRevisionContent(
      item.id,
      captured.currentRevisionId ?? "",
    );
    expect(new TextDecoder().decode(capturedContent.bytes)).toBe("# Legacy original");
    await expect(store.agentKnowledge(message)).resolves.toEqual([
      expect.objectContaining({ content: "# Legacy original" }),
    ]);
    expect(await readFile(legacyRoot, "utf8")).toBe("# Legacy original");
  });
});
