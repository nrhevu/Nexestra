import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  const root = await mkdtemp(join(tmpdir(), "nexestra-branch-selection-"));
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

async function addFeature(source: string): Promise<string> {
  await git(source, "checkout", "-b", "feature");
  return commit(source, "feature base\n");
}

describe("Repository source branch selection", () => {
  it("selects a feature branch for future Workers while preserving the clone and dirty worktree", async () => {
    const { source, firstCommit, store, manager, repository, path } = await fixture();
    const location = manager.assignmentLocation(repository.workspaceId, "existing-worker");
    await manager.prepareAssignment(repository, location);
    await writeFile(join(location.absolutePath, "README.md"), "worker edits\n");
    const cloneHead = await git(path, "rev-parse", "HEAD");
    const originMain = await git(path, "rev-parse", "refs/remotes/origin/main");
    const cloneIndex = await readFile(join(path, ".git", "index"));
    const cloneReadme = await readFile(join(path, "README.md"), "utf8");
    const workerReadme = await readFile(join(location.absolutePath, "README.md"), "utf8");
    const refsBefore = await git(path, "for-each-ref");
    const featureCommit = await addFeature(source);

    const selected = await manager.selectSourceBranch(repository.id, {
      branch: "feature",
      expectedSourceVersion: 0,
    });

    expect(selected).toMatchObject({
      id: repository.id,
      defaultBranch: "main",
      selectedBranch: "feature",
      sourceVersion: 1,
      sourceCommit: featureCommit,
      sourceRef: "refs/heads/feature",
      status: "ready",
      refreshing: false,
    });
    expect(selected.refreshError).toBeUndefined();
    expect(await git(path, "rev-parse", "HEAD")).toBe(cloneHead);
    expect(await git(path, "rev-parse", "refs/remotes/origin/main")).toBe(originMain);
    expect(await readFile(join(path, ".git", "index"))).toEqual(cloneIndex);
    expect(await readFile(join(path, "README.md"), "utf8")).toBe(cloneReadme);
    expect(await readFile(join(location.absolutePath, "README.md"), "utf8")).toBe(workerReadme);
    expect(await git(location.absolutePath, "rev-parse", "HEAD")).toBe(firstCommit);
    const addedRefs = (await git(path, "for-each-ref"))
      .split("\n")
      .filter((line) => !refsBefore.split("\n").includes(line));
    expect(addedRefs.length).toBeGreaterThan(0);
    expect(addedRefs.every((line) => line.includes("refs/nexestra/source-refresh/"))).toBe(true);
    const nextLocation = manager.assignmentLocation(repository.workspaceId, "new-worker");
    expect((await manager.prepareAssignment(repository, nextLocation)).baseCommit).toBe(
      featureCommit,
    );
    expect(await readFile(join(nextLocation.absolutePath, "README.md"), "utf8")).toBe(
      "feature base\n",
    );
    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    expect(reopened.getKnowledge(repository.id)).toMatchObject({
      selectedBranch: "feature",
      sourceVersion: 1,
      sourceCommit: featureCommit,
    });
  });

  it("refreshes the selected feature branch and increments sourceVersion", async () => {
    const { source, manager, repository } = await fixture();
    await addFeature(source);
    await manager.selectSourceBranch(repository.id, {
      branch: "feature",
      expectedSourceVersion: 0,
    });
    const second = await commit(source, "feature second\n");

    const refreshed = await manager.refreshRepository(repository.id);

    expect(refreshed).toMatchObject({
      selectedBranch: "feature",
      defaultBranch: "main",
      sourceVersion: 2,
      sourceRef: "refs/heads/feature",
      sourceCommit: second,
      status: "ready",
      refreshing: false,
    });
    expect(refreshed.refreshError).toBeUndefined();
    const location = manager.assignmentLocation(repository.workspaceId, "after-refresh");
    expect((await manager.prepareAssignment(repository, location)).baseCommit).toBe(second);
  });

  it("keeps the previous source when a branch is absent or the name is invalid", async () => {
    const { source, store, manager, repository } = await fixture();
    const featureCommit = await addFeature(source);
    const selected = await manager.selectSourceBranch(repository.id, {
      branch: "feature",
      expectedSourceVersion: 0,
    });
    expect(selected.sourceVersion).toBe(1);

    const missing = await manager.selectSourceBranch(repository.id, {
      branch: "missing-feature",
      expectedSourceVersion: 1,
    });
    expect(missing).toMatchObject({
      status: "ready",
      refreshing: false,
      selectedBranch: "feature",
      sourceVersion: 1,
      sourceCommit: featureCommit,
    });
    expect(missing.refreshError).toBeTruthy();

    await expect(
      manager.selectSourceBranch(repository.id, { branch: "bad..name", expectedSourceVersion: 1 }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      manager.selectSourceBranch(repository.id, { branch: "-option", expectedSourceVersion: 1 }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      manager.selectSourceBranch(repository.id, {
        branch: "bad\u0000name",
        expectedSourceVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(store.getKnowledge(repository.id)).toMatchObject({
      selectedBranch: "feature",
      sourceVersion: 1,
      sourceCommit: featureCommit,
    });
  });

  it("rejects stale versions and concurrent selection while a refresh runs", async () => {
    const { source, store, repository } = await fixture();
    const featureCommit = await addFeature(source);
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

    await expect(
      manager.selectSourceBranch(repository.id, {
        branch: "feature",
        expectedSourceVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const first = manager.refreshRepository(repository.id);
    await entered;
    await expect(
      manager.selectSourceBranch(repository.id, {
        branch: "feature",
        expectedSourceVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    release();
    const refreshed = await first;
    expect(refreshed.sourceVersion).toBe(1);
    const selected = await manager.selectSourceBranch(repository.id, {
      branch: "feature",
      expectedSourceVersion: 1,
    });
    expect(selected).toMatchObject({
      selectedBranch: "feature",
      sourceVersion: 2,
      sourceCommit: featureCommit,
    });
  });

  it("lists branches read-only with the effective selection snapshot", async () => {
    const { source, path, manager, repository } = await fixture();
    await addFeature(source);
    const headBefore = await git(path, "rev-parse", "HEAD");
    const indexBefore = await readFile(join(path, ".git", "index"));
    const refsBefore = await git(path, "for-each-ref");

    const listing = await manager.listBranches(repository.id);

    expect(listing.branches.map((branch) => branch.name).sort()).toEqual(["feature", "main"]);
    expect(listing.branches.every((branch) => /^[0-9a-f]{40}$/.test(branch.commit))).toBe(true);
    expect(listing).toMatchObject({
      truncated: false,
      sourceVersion: 0,
      selectedBranch: "main",
      defaultBranch: "main",
    });
    expect(await git(path, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await readFile(join(path, ".git", "index"))).toEqual(indexBefore);
    expect(await git(path, "for-each-ref")).toBe(refsBefore);
    await expect(readFile(join(path, ".git", "FETCH_HEAD"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await manager.selectSourceBranch(repository.id, {
      branch: "feature",
      expectedSourceVersion: 0,
    });
    const selectedListing = await manager.listBranches(repository.id);
    expect(selectedListing).toMatchObject({
      selectedBranch: "feature",
      sourceVersion: 1,
    });
  });

  it("returns an empty successful list when the source has no refs", async () => {
    const { source, manager, repository } = await fixture();
    await git(source, "checkout", "--detach");
    await git(source, "branch", "-D", "main");

    const listing = await manager.listBranches(repository.id);

    expect(listing).toEqual({
      branches: [],
      truncated: false,
      sourceVersion: 0,
      selectedBranch: "main",
      defaultBranch: "main",
    });
  });

  it("loads legacy repository state with sourceVersion undefined as version zero", async () => {
    const { store, repository } = await fixture();
    const state = JSON.parse(await readFile(store.stateFile, "utf8"));
    delete state.knowledge[0].sourceVersion;
    await writeFile(store.stateFile, JSON.stringify(state));
    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const item = reopened.getKnowledge(repository.id);
    if (item?.kind !== "repository") throw new Error("expected repository");
    expect(item.sourceVersion).toBeUndefined();
    const reopenedManager = new RepositoryManager(reopened);
    expect((await reopenedManager.listBranches(repository.id)).sourceVersion).toBe(0);
  });

  it("omits overlong legacy default metadata instead of failing the listing", async () => {
    const { store, manager, repository } = await fixture();
    const longDefault = "a".repeat(257);
    await store.updateKnowledgeRepository(repository.id, {
      status: "ready",
      defaultBranch: longDefault,
    });

    const listing = await manager.listBranches(repository.id);

    expect(listing).toMatchObject({
      defaultBranch: null,
      selectedBranch: null,
      truncated: true,
    });
    expect(listing.branches.some((branch) => branch.name === "main")).toBe(true);
  });

  it("filters credential-bearing selected and default metadata from GET", async () => {
    const { store, manager, repository } = await fixture();
    const secret = "nexestra-metadata-fixture-secret";
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
    await store.updateKnowledgeRepository(repository.id, {
      status: "ready",
      defaultBranch: `default-${secret}`,
      selectedBranch: `selected-${secret}`,
    });

    const listing = await manager.listBranches(repository.id);
    const serialized = JSON.stringify(listing);

    expect(listing).toMatchObject({
      defaultBranch: null,
      selectedBranch: null,
      truncated: true,
    });
    expect(serialized).not.toContain(secret);
  });

  it("skips and rejects branch names containing stored credentials without leaking them", async () => {
    const { source, store, manager, repository } = await fixture();
    const secret = "nexestra-branch-fixture-secret";
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
    await git(source, "checkout", "-b", `feature-${secret}`);
    await commit(source, "credential branch\n");

    const listing = await manager.listBranches(repository.id);

    expect(listing.branches.some((branch) => branch.name.includes(secret))).toBe(false);
    expect(listing.truncated).toBe(true);
    await expect(
      manager.selectSourceBranch(repository.id, {
        branch: `feature-${secret}`,
        expectedSourceVersion: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await readFile(store.stateFile, "utf8")).not.toContain(secret);
  });

  it("does not fetch or change memory/disk when the refreshing write fails, and releases the lock", async () => {
    const { store, repository } = await fixture();
    let fetched = false;
    const manager = new RepositoryManager(store, process.env, {
      beforeFetch: async () => {
        fetched = true;
      },
    });
    const internal = store as unknown as { writeState: (state?: unknown) => Promise<void> };
    const writeState = internal.writeState.bind(store);
    const spy = vi.spyOn(internal, "writeState").mockImplementation(async (state) => {
      if (spy.mock.calls.length === 1) throw new Error("fixture refreshing write failed");
      await writeState(state);
    });
    try {
      await expect(
        manager.selectSourceBranch(repository.id, { branch: "main", expectedSourceVersion: 0 }),
      ).rejects.toThrow("fixture refreshing write failed");
      expect(fetched).toBe(false);
      const current = store.getKnowledge(repository.id);
      if (current?.kind !== "repository") throw new Error("expected repository");
      expect(current.sourceVersion).toBeUndefined();
      expect(current.selectedBranch).toBeUndefined();
      expect(current.refreshing).toBeUndefined();
      const disk = JSON.parse(await readFile(store.stateFile, "utf8"));
      expect(disk.knowledge[0]).toMatchObject({ status: "ready" });
      expect(disk.knowledge[0].sourceVersion).toBeUndefined();
      expect(disk.knowledge[0].selectedBranch).toBeUndefined();
      expect(disk.knowledge[0].refreshing).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const recovered = await manager.selectSourceBranch(repository.id, {
      branch: "main",
      expectedSourceVersion: 0,
    });
    expect(recovered).toMatchObject({ selectedBranch: "main", sourceVersion: 1 });
  });

  it("refuses listing when the managed clone provenance is unsafe", async () => {
    const { source, manager, repository, path } = await fixture();
    await writeFile(join(path, ".git", "commondir"), `${join(source, ".git")}\n`);
    const refsBefore = await git(path, "for-each-ref");
    await expect(manager.listBranches(repository.id)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await git(path, "for-each-ref")).toBe(refsBefore);
  });

  it("exposes HTTP routes with origin guard and error mapping", async () => {
    const { store, repository } = await fixture();
    const runner: AgentRunner = {
      runtimeStatus: async () => ({
        chatgpt: { installed: false, connected: false, message: "fixture" },
        harnesses: {
          codex: { installed: false, version: null },
          opencode: { installed: false, version: null },
        },
      }),
      invoke: vi.fn(async () => {
        throw new Error("branch selection must not invoke a provider");
      }),
    };
    const app = createApp({ store, runner });
    const branchesResponse = await app.request(`/api/knowledge/${repository.id}/branches`);
    expect(branchesResponse.status).toBe(200);
    const branchesBody = (await branchesResponse.json()) as {
      branches: Array<{ name: string }>;
      selectedBranch: string;
      sourceVersion: number;
    };
    expect(branchesBody.branches.some((branch) => branch.name === "main")).toBe(true);
    expect(branchesBody).toMatchObject({
      selectedBranch: "main",
      sourceVersion: 0,
    });

    const document = await store.createKnowledgeDocument(
      { name: "Notes", handle: "notes", description: "" },
      { name: "notes.md", mediaType: "text/markdown", bytes: new TextEncoder().encode("# Notes") },
    );
    expect((await app.request(`/api/knowledge/${document.id}/branches`)).status).toBe(404);
    expect((await app.request("/api/knowledge/missing/branches")).status).toBe(404);

    const url = `/api/knowledge/${repository.id}/source-branch`;
    const forbidden = await app.request(url, {
      method: "POST",
      headers: { Origin: "https://untrusted.example", "content-type": "application/json" },
      body: JSON.stringify({ branch: "main", expectedSourceVersion: 0 }),
    });
    expect(forbidden.status).toBe(403);

    const selectResponse = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "main", expectedSourceVersion: 0 }),
    });
    expect(selectResponse.status).toBe(200);
    expect(await selectResponse.json()).toMatchObject({
      selectedBranch: "main",
      sourceVersion: 1,
    });
    const stale = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "main", expectedSourceVersion: 0 }),
    });
    expect(stale.status).toBe(409);
    const invalid = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "-main", expectedSourceVersion: 1 }),
    });
    expect(invalid.status).toBe(400);

    await store.updateKnowledgeRepository(repository.id, { status: "failed", error: "fixture" });
    const notReady = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "main", expectedSourceVersion: 1 }),
    });
    expect(notReady.status).toBe(409);
    expect((await app.request(`/api/knowledge/${repository.id}/branches`)).status).toBe(409);
    expect(runner.invoke).not.toHaveBeenCalled();
  });
});
