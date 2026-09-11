import { appendFile, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HISTORY_MAX_EVENT_BYTES } from "./conversation-history.js";
import type { WorkspaceExportPrepareOptions } from "./store.js";
import { FileStore } from "./store.js";
import { createWorkspaceExport, workspaceExportEntries } from "./workspace-export.js";

async function openStore(): Promise<{ store: FileStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "nexestra-export-boundaries-"));
  const store = await FileStore.open({ root, workspacePath: root });
  return { store, root };
}

async function nextSequence(store: FileStore, threadId: string): Promise<number> {
  const raw = await readFile(store.transcriptPath(threadId), "utf8");
  let maximum = 0;
  for (const match of raw.matchAll(/"sequence":\s*(\d+)/g)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > maximum) maximum = value;
  }
  return maximum + 1;
}

interface HeldWrite {
  started: Promise<void>;
  release(): void;
}

async function withHeldWrite<T>(
  store: FileStore,
  run: (held: HeldWrite) => Promise<T>,
): Promise<T> {
  let markStarted!: () => void;
  let releaseWrite!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const hooks = store as unknown as { writeState(...args: never[]): Promise<void> };
  const originalWriteState = hooks.writeState.bind(store);
  hooks.writeState = async (...args: never[]) => {
    markStarted();
    await gate;
    await originalWriteState(...args);
  };
  try {
    return await run({ started, release: () => releaseWrite() });
  } finally {
    releaseWrite();
    hooks.writeState = originalWriteState;
  }
}

async function expectInvalidAfterAppend(
  append: (store: FileStore, threadId: string) => Promise<void>,
): Promise<void> {
  const { store } = await openStore();
  const workspace = store.listWorkspaces()[0];
  const thread = workspace ? store.listThreads(workspace.id)[0] : undefined;
  if (!workspace || !thread) throw new Error("expected seeded workspace and thread");
  await store.createUserMessage(thread.id, "one", []);
  await append(store, thread.id);
  await expect(createWorkspaceExport({ store, workspaceId: workspace.id })).rejects.toMatchObject({
    code: "invalid",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workspace export boundaries", () => {
  it("settles a stuck write queue on timeout and a late capture cannot release a newer reservation", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");

    await withHeldWrite(store, async (held) => {
      const blockedWrite = store.createWorkspace({ name: "Blocked write" });
      await held.started;
      const startedAt = Date.now();
      await expect(
        store.prepareWorkspaceExport(workspace.id, { timeoutMs: 60 }),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "Workspace export timed out.",
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);

      const newerPending = store.prepareWorkspaceExport(workspace.id);
      held.release();
      await blockedWrite;
      const newer = await newerPending;
      try {
        await expect(store.prepareWorkspaceExport(workspace.id)).rejects.toMatchObject({
          code: "conflict",
        });
        await newer.release();
        const afterRelease = await store.prepareWorkspaceExport(workspace.id);
        await afterRelease.release();
      } finally {
        await newer.release();
      }
    });
  });

  it("settles a stuck write queue on abort and still releases for a later export", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");

    await withHeldWrite(store, async (held) => {
      const blockedWrite = store.createWorkspace({ name: "Blocked cancel" });
      await held.started;
      const controller = new AbortController();
      const startedAt = Date.now();
      const pending = store.prepareWorkspaceExport(workspace.id, {
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        code: "conflict",
        message: "Workspace export was cancelled.",
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);

      const nextPending = store.prepareWorkspaceExport(workspace.id);
      held.release();
      await blockedWrite;
      const next = await nextPending;
      await next.release();
    });
  });

  it("conflicts when an early source is replaced after streaming but before the final identity sweep", async () => {
    const { store } = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const [thread] = store.listThreads(workspace.id);
    if (!thread) throw new Error("expected seeded thread");
    await store.createUserMessage(thread.id, "one", []);
    const second = await store.createThread({ workspaceId: workspace.id, name: "Second" });
    await store.createUserMessage(second.id, "two", []);

    const originalPrepare = store.prepareWorkspaceExport.bind(store);
    let replacedPath: string | undefined;
    let originalSourceBytes: Uint8Array | undefined;
    let firstSourceValidations = 0;
    vi.spyOn(store, "prepareWorkspaceExport").mockImplementationOnce(
      async (workspaceId: string, options?: WorkspaceExportPrepareOptions) => {
        const prepared = await originalPrepare(workspaceId, options);
        const first = prepared.files.find((file) => file.kind === "transcript" && file.identity);
        if (!first) throw new Error("expected a captured transcript");
        replacedPath = first.sourcePath;
        originalSourceBytes = await readFile(first.sourcePath);
        const originalValidate = prepared.validateFile;
        return {
          ...prepared,
          validateFile: async (file) => {
            if (file.archivePath === first.archivePath) {
              firstSourceValidations += 1;
              // The first check precedes streaming; the second is the final sweep.
              if (firstSourceValidations === 2) {
                await writeFile(file.sourcePath, new TextEncoder().encode("replacement"));
              }
            }
            await originalValidate(file);
          },
        };
      },
    );

    let failure: unknown;
    try {
      try {
        await createWorkspaceExport({ store, workspaceId: workspace.id });
      } catch (error) {
        failure = error;
      }
      if (replacedPath && originalSourceBytes) {
        await writeFile(replacedPath, originalSourceBytes);
      }
      const next = await store.prepareWorkspaceExport(workspace.id);
      await next.release();
      expect(firstSourceValidations).toBe(2);
      expect(failure).toMatchObject({ code: "conflict" });
    } finally {
      if (replacedPath && originalSourceBytes) {
        await writeFile(replacedPath, originalSourceBytes).catch(() => undefined);
      }
    }
  });

  it.each(["before opening", "after streaming"] as const)(
    "rejects a changed binary descriptor %s before yielding more bytes",
    async (when) => {
      const { store } = await openStore();
      const [workspace] = store.listWorkspaces();
      if (!workspace) throw new Error("expected seeded workspace");
      const [thread] = store.listThreads(workspace.id);
      if (!thread) throw new Error("expected seeded thread");
      const originalBytes = new TextEncoder().encode("original");
      await store.createUserMessage(
        thread.id,
        "upload",
        [],
        [{ name: "fixture.bin", mediaType: "application/octet-stream", bytes: originalBytes }],
      );
      const prepared = await store.prepareWorkspaceExport(workspace.id);
      const upload = prepared.files.find((file) => file.kind === "upload");
      if (!upload) throw new Error("expected captured upload");
      const entries = workspaceExportEntries(prepared, store, () => {});
      try {
        for await (const entry of entries) {
          if (entry.kind !== "upload") {
            for await (const _chunk of entry.chunks) {
              // Consume earlier entries so the upload passes its preflight check.
            }
            continue;
          }
          const chunks = entry.chunks[Symbol.asyncIterator]();
          if (when === "before opening") {
            // Replace the inode after the path check but before the descriptor opens.
            await rename(upload.sourcePath, `${upload.sourcePath}.original`);
          } else {
            const first = await chunks.next();
            expect(first.done).toBe(false);
            expect(first.value).toEqual(originalBytes);
          }
          await writeFile(upload.sourcePath, new TextEncoder().encode("replaced"));
          await expect(chunks.next()).rejects.toMatchObject({ code: "conflict" });
          break;
        }
      } finally {
        await entries.return(undefined);
        await prepared.release();
      }
    },
  );

  it("rejects invalid UTF-8, torn trailing, and oversized transcript lines", async () => {
    await expectInvalidAfterAppend(async (store, threadId) => {
      await appendFile(store.transcriptPath(threadId), new Uint8Array([0xff, 0xfe, 0x0a]));
    });

    await expectInvalidAfterAppend(async (store, threadId) => {
      const now = new Date().toISOString();
      await appendFile(
        store.transcriptPath(threadId),
        JSON.stringify({
          type: "tool.updated",
          sequence: await nextSequence(store, threadId),
          toolCall: {
            id: "tool-torn-tail",
            runId: "run-torn-tail",
            threadId,
            agentId: "agent-torn-tail",
            name: "read",
            permission: "read",
            status: "completed",
            input: "x",
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
    });

    await expectInvalidAfterAppend(async (store, threadId) => {
      const now = new Date().toISOString();
      await appendFile(
        store.transcriptPath(threadId),
        `${JSON.stringify({
          type: "tool.updated",
          sequence: await nextSequence(store, threadId),
          toolCall: {
            id: "tool-oversized",
            runId: "run-oversized",
            threadId,
            agentId: "agent-oversized",
            name: "read",
            permission: "read",
            status: "completed",
            input: "x",
            createdAt: now,
            updatedAt: now,
          },
          padding: "x".repeat(HISTORY_MAX_EVENT_BYTES + 4),
        })}\n`,
      );
    });
  });
});
