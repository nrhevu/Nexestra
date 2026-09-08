import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { RepositoryManager } from "./repository-manager.js";
import type { AgentRunner } from "./runtime.js";
import { FileStore } from "./store.js";

const exec = promisify(execFile);
async function git(path: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", path, ...args])).stdout.trim();
}

async function commit(path: string, content: string): Promise<string> {
  await writeFile(join(path, "README.md"), content);
  await git(path, "add", "README.md");
  await git(
    path,
    "-c",
    "user.name=Nexestra Test",
    "-c",
    "user.email=test@nexestra.local",
    "commit",
    "-m",
    "Update fixture",
  );
  return git(path, "rev-parse", "HEAD");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nexestra-source-refresh-"));
  const source = join(root, "source");
  await mkdir(source);
  await git(source, "init", "--initial-branch=main");
  const firstCommit = await commit(source, "original\n");
  const store = await FileStore.open({ root: join(root, "data"), workspacePath: root });
  const manager = new RepositoryManager(store);
  const repository = await manager.addRepository({ name: "Source", handle: "source", source });
  if (repository.status !== "ready") throw new Error(repository.error);
  const path = store.knowledgePath(repository);
  return { root, source, firstCommit, store, manager, repository, path };
}

describe("Repository source refresh", () => {
  it("uses a refreshed commit for future Workers while preserving the clone and existing worktrees", async () => {
    const { source, firstCommit, store, manager, repository, path } = await fixture();
    const oldLocation = manager.assignmentLocation(repository.workspaceId, "existing-worker");
    const oldBase = await manager.prepareAssignment(repository, oldLocation);
    await writeFile(join(oldLocation.absolutePath, "README.md"), "worker edits\n");
    await writeFile(join(path, "staged.txt"), "staged clone edits\n");
    await git(path, "add", "staged.txt");
    const oldIndex = await readFile(join(path, ".git", "index"));
    await writeFile(join(path, "README.md"), "unstaged clone edits\n");
    const nextCommit = await commit(source, "new source\n");

    const refreshed = await manager.refreshRepository(repository.id);

    expect(refreshed).toMatchObject({
      id: repository.id,
      status: "ready",
      refreshing: false,
      sourceCommit: nextCommit,
      sourceRef: "refs/heads/main",
      createdAt: repository.createdAt,
    });
    expect(refreshed.refreshError).toBeUndefined();
    expect(refreshed.refreshedAt).toBeTruthy();
    expect(await git(path, "rev-parse", "HEAD")).toBe(firstCommit);
    expect(await git(path, "rev-parse", "refs/remotes/origin/main")).toBe(firstCommit);
    expect(await readFile(join(path, ".git", "index"))).toEqual(oldIndex);
    expect(await readFile(join(path, "README.md"), "utf8")).toBe("unstaged clone edits\n");
    expect(await readFile(join(oldLocation.absolutePath, "README.md"), "utf8")).toBe(
      "worker edits\n",
    );
    expect(await git(oldLocation.absolutePath, "rev-parse", "HEAD")).toBe(firstCommit);
    expect(oldBase.baseCommit).toBe(firstCommit);
    // The caller may have captured metadata before refresh; preparation reads the current selection.
    const nextLocation = manager.assignmentLocation(repository.workspaceId, "new-worker");
    expect((await manager.prepareAssignment(repository, nextLocation)).baseCommit).toBe(nextCommit);
    expect(await readFile(join(nextLocation.absolutePath, "README.md"), "utf8")).toBe(
      "new source\n",
    );
    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    expect(reopened.getKnowledge(repository.id)).toMatchObject({ sourceCommit: nextCommit });
  });

  it("keeps the last usable starting commit when the selected upstream branch disappears", async () => {
    const { source, manager, repository } = await fixture();
    const selected = await manager.refreshRepository(repository.id);
    await git(source, "branch", "-m", "renamed-upstream");

    const failed = await manager.refreshRepository(repository.id);

    expect(failed).toMatchObject({
      status: "ready",
      refreshing: false,
      sourceCommit: selected.sourceCommit,
      sourceRef: selected.sourceRef,
      refreshedAt: selected.refreshedAt,
    });
    expect(failed.refreshError).toMatch(/remote ref|main/i);
    await git(source, "branch", "-m", "main");
    expect((await manager.refreshRepository(repository.id)).refreshError).toBeUndefined();
  });

  it("does not publish a new selection in memory or on disk when its metadata write fails", async () => {
    const { source, store, manager, repository } = await fixture();
    const selected = await manager.refreshRepository(repository.id);
    await commit(source, "next source\n");
    const internal = store as unknown as { writeState: (state?: unknown) => Promise<void> };
    const writeState = internal.writeState.bind(store);
    let writes = 0;
    const spy = vi.spyOn(internal, "writeState").mockImplementation(async (state) => {
      if (++writes === 2) throw new Error("fixture state publication failed");
      await writeState(state);
    });
    try {
      const failed = await manager.refreshRepository(repository.id);
      expect(failed).toMatchObject({
        status: "ready",
        refreshing: false,
        sourceCommit: selected.sourceCommit,
        refreshedAt: selected.refreshedAt,
        refreshError: "fixture state publication failed",
      });
      expect(store.getKnowledge(repository.id)).toMatchObject({
        sourceCommit: selected.sourceCommit,
      });
      const disk = JSON.parse(await readFile(store.stateFile, "utf8"));
      expect(
        disk.knowledge.find((item: { id: string }) => item.id === repository.id),
      ).toMatchObject({ sourceCommit: selected.sourceCommit, refreshing: false });
    } finally {
      spy.mockRestore();
    }
  });

  it("serializes refresh attempts, blocks edit/delete, and lets an assignment keep the previous selection", async () => {
    const { source, store, firstCommit, repository } = await fixture();
    await commit(source, "new upstream\n");
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new RepositoryManager(store, process.env, {
      beforeFetch: async () => {
        enter();
        await gate;
      },
    });
    const first = manager.refreshRepository(repository.id);
    await entered;
    try {
      await expect(manager.refreshRepository(repository.id)).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(store.updateKnowledge(repository.id, { name: "changed" })).rejects.toMatchObject(
        { code: "conflict" },
      );
      await expect(store.deleteKnowledge(repository.id)).rejects.toMatchObject({
        code: "conflict",
      });
      const location = manager.assignmentLocation(repository.workspaceId, "while-refreshing");
      expect((await manager.prepareAssignment(repository, location)).baseCommit).toBe(firstCommit);
    } finally {
      release();
      await first;
    }
    await expect(store.updateKnowledge(repository.id, { name: "changed" })).resolves.toMatchObject({
      name: "changed",
    });
  });

  it("recovers an interrupted refresh without turning a ready clone into a failed clone", async () => {
    const { store, manager, repository } = await fixture();
    const selected = await manager.refreshRepository(repository.id);
    await store.updateKnowledgeRepository(repository.id, { status: "ready", refreshing: true });
    const internal = store as unknown as {
      writeState: (state?: unknown) => Promise<void>;
      recoverInterruptedRepositories: () => Promise<void>;
    };
    const spy = vi
      .spyOn(internal, "writeState")
      .mockRejectedValue(new Error("recovery write failed"));
    try {
      await expect(internal.recoverInterruptedRepositories()).rejects.toThrow(
        "recovery write failed",
      );
      expect(store.getKnowledge(repository.id)).toMatchObject({
        refreshing: true,
        sourceCommit: selected.sourceCommit,
      });
    } finally {
      spy.mockRestore();
    }
    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    expect(reopened.getKnowledge(repository.id)).toMatchObject({
      status: "ready",
      refreshing: false,
      sourceCommit: selected.sourceCommit,
      refreshedAt: selected.refreshedAt,
      refreshError: expect.stringMatching(/interrupted.*restart/),
    });
  });

  it("disables fetch hooks and ignores configured ref mappings that would overwrite local branches", async () => {
    const { root, source, firstCommit, manager, repository, path } = await fixture();
    const hooks = join(root, "custom-hooks");
    await mkdir(hooks);
    const marker = join(root, "hook-ran");
    const hook = join(hooks, "reference-transaction");
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(hook, 0o700);
    await git(path, "config", "core.hooksPath", hooks);
    await git(path, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*");
    await git(path, "config", "fetch.prune", "true");
    await git(path, "config", "fetch.pruneTags", "true");
    const next = await commit(source, "fresh\n");
    const result = await manager.refreshRepository(repository.id);
    expect(result.sourceCommit).toBe(next);
    expect(result.refreshError).toBeUndefined();
    expect(await git(path, "rev-parse", "HEAD")).toBe(firstCommit);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(path, ".git", "FETCH_HEAD"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a clone with a foreign Git common directory even when the origin matches", async () => {
    const { source, manager, repository, path } = await fixture();
    await git(source, "config", "remote.origin.url", source);
    const before = await git(source, "show-ref");
    await writeFile(join(path, ".git", "commondir"), `${join(source, ".git")}\n`);
    const failed = await manager.refreshRepository(repository.id);
    expect(failed.refreshError).toMatch(/another repository's Git directory/);
    expect(failed.status).toBe("ready");
    expect(failed.sourceCommit).toBeUndefined();
    expect(await git(source, "show-ref")).toBe(before);
  });

  it("redacts and bounds a failed refresh before saving its visible error", async () => {
    const { store, repository } = await fixture();
    const secret = "nexestra-refresh-fixture-secret";
    await store.createAgent({
      kind: "master",
      name: "Fixture",
      handle: "fixture",
      provider: {
        type: "custom",
        name: "Fixture",
        baseUrl: "https://fixture.example/v1",
        model: "fixture",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });
    const manager = new RepositoryManager(store, process.env, {
      beforeFetch: async () => {
        throw new Error(`${secret} ${"detail ".repeat(1_000)}`);
      },
    });
    const failed = await manager.refreshRepository(repository.id);
    expect(failed.refreshError).toBeTruthy();
    expect(failed.refreshError?.length).toBeLessThanOrEqual(2_000);
    expect(JSON.stringify(failed)).not.toContain(secret);
    expect(await readFile(store.stateFile, "utf8")).not.toContain(secret);
  });

  it("validates API mutation origin and refreshes without invoking an agent", async () => {
    const { store, repository, firstCommit } = await fixture();
    const runner: AgentRunner = {
      runtimeStatus: async () => ({
        chatgpt: { installed: false, connected: false, message: "fixture" },
        harnesses: {
          codex: { installed: false, version: null },
          opencode: { installed: false, version: null },
        },
      }),
      invoke: vi.fn(async () => {
        throw new Error("refresh must not invoke a provider");
      }),
    };
    const app = createApp({ store, runner });
    const url = `/api/knowledge/repositories/${repository.id}/refresh`;
    expect(
      (await app.request(url, { method: "POST", headers: { Origin: "https://untrusted.example" } }))
        .status,
    ).toBe(403);
    const response = await app.request(url, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: repository.id,
      sourceCommit: firstCommit,
      status: "ready",
    });
    expect(
      (await app.request("/api/knowledge/repositories/missing/refresh", { method: "POST" })).status,
    ).toBe(404);
    await store.updateKnowledgeRepository(repository.id, { status: "failed" });
    expect((await app.request(url, { method: "POST" })).status).toBe(409);
    expect(runner.invoke).not.toHaveBeenCalled();
  });
});
