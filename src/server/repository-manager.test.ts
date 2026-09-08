import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { RepositoryManager } from "./repository-manager.js";
import { FileStore } from "./store.js";

const execFileAsync = promisify(execFile);

async function createLocalRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "README.md"), "# Fixture\n");
  await execFileAsync("git", ["init", "--initial-branch=main", path]);
  await execFileAsync("git", ["-C", path, "add", "README.md"]);
  await execFileAsync("git", [
    "-C",
    path,
    "-c",
    "user.name=Nexestra Test",
    "-c",
    "user.email=test@nexestra.local",
    "commit",
    "-m",
    "Initial commit",
  ]);
}

describe("RepositoryManager", () => {
  it("clones shared repository knowledge and creates an isolated assignment worktree", async () => {
    const source = await mkdtemp(join(tmpdir(), "nexestra-repository-source-"));
    await execFileAsync("git", ["init", "--initial-branch=main", source]);
    await writeFile(join(source, "README.md"), "# Test repository\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      source,
      "-c",
      "user.name=Nexestra Test",
      "-c",
      "user.email=test@nexestra.local",
      "commit",
      "-m",
      "Initial commit",
    ]);
    const root = await mkdtemp(join(tmpdir(), "nexestra-repository-store-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const manager = new RepositoryManager(store);
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected default workspace");

    const repository = await manager.addRepository({
      name: "Product repository",
      handle: "product-repo",
      source,
    });
    const location = manager.assignmentLocation(workspace.id, "assignment-1");
    const prepared = await manager.prepareAssignment(repository, location);
    expect(prepared.baseCommit).toMatch(/^[0-9a-f]{40}$/);

    expect(repository).toMatchObject({ status: "ready", defaultBranch: "main" });
    expect(location.branch).toBe("nexestra/assignment-1");
    await expect(readFile(join(location.absolutePath, "README.md"), "utf8")).resolves.toContain(
      "Test repository",
    );
    const branch = await execFileAsync("git", [
      "-C",
      location.absolutePath,
      "branch",
      "--show-current",
    ]);
    expect(branch.stdout.trim()).toBe(location.branch);

    await manager.cleanupAssignment(repository, location);
    await manager.deleteAssignmentBranch(repository, location);
    const repositoryPath = store.knowledgePath(repository);
    const branches = await execFileAsync("git", [
      "-C",
      repositoryPath,
      "branch",
      "--list",
      location.branch,
    ]);
    expect(branches.stdout).toBe("");
    await expect(manager.deleteAssignmentBranch(repository, location)).rejects.toThrow(
      /not found|not fully merged/i,
    );
    await expect(readFile(join(location.absolutePath, "README.md"), "utf8")).rejects.toThrow();
    await expect(manager.cleanupAssignment(repository, location)).rejects.toThrow(
      /not a working tree|does not exist/i,
    );
  });

  it("refuses to delete an assignment branch with unmerged commits", async () => {
    const source = await mkdtemp(join(tmpdir(), "nexestra-repository-unmerged-"));
    await execFileAsync("git", ["init", "--initial-branch=main", source]);
    await writeFile(join(source, "README.md"), "# Test repository\n");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      source,
      "-c",
      "user.name=Nexestra Test",
      "-c",
      "user.email=test@nexestra.local",
      "commit",
      "-m",
      "Initial commit",
    ]);
    const root = await mkdtemp(join(tmpdir(), "nexestra-repository-unmerged-store-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const manager = new RepositoryManager(store);
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected default workspace");
    const repository = await manager.addRepository({
      name: "Product repository",
      handle: "product-repo",
      source,
    });
    const location = manager.assignmentLocation(workspace.id, "assignment-unmerged");
    const prepared = await manager.prepareAssignment(repository, location);
    expect(prepared.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    await writeFile(join(location.absolutePath, "README.md"), "# Unmerged change\n");
    await execFileAsync("git", ["-C", location.absolutePath, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      location.absolutePath,
      "-c",
      "user.name=Nexestra Test",
      "-c",
      "user.email=test@nexestra.local",
      "commit",
      "-m",
      "Unmerged assignment commit",
    ]);
    await manager.cleanupAssignment(repository, location);

    await expect(manager.deleteAssignmentBranch(repository, location)).rejects.toThrow(
      /not fully merged/i,
    );
    const unmergedRepositoryPath = store.knowledgePath(repository);
    const branches = await execFileAsync("git", [
      "-C",
      unmergedRepositoryPath,
      "branch",
      "--list",
      location.branch,
    ]);
    expect(branches.stdout.trim()).toBe(location.branch);
  });

  it("rejects repository URLs containing credentials without persisting the secret in errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-repository-secret-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const manager = new RepositoryManager(store);

    await expect(
      manager.addRepository({
        name: "Unsafe repository",
        handle: "unsafe-repo",
        source: "https://token@example.com/owner/repository.git",
      }),
    ).rejects.toThrow("must not contain credentials");
    await expect(
      manager.addRepository({
        name: "Unsafe query repository",
        handle: "unsafe-query-repo",
        source:
          "https://example.com/owner/repository.git?access_token=query-secret#fragment-secret",
      }),
    ).rejects.toThrow("must not contain credentials");
    await expect(
      manager.addRepository({
        name: "Unsafe SSH repository",
        handle: "unsafe-ssh-repo",
        source: "git@example.com:owner/repository.git?access_token=scp-secret",
      }),
    ).rejects.toThrow("must not contain credentials");
    const persisted = await readFile(join(root, "state.json"), "utf8");
    expect(persisted).not.toContain("token@");
    expect(persisted).not.toContain("query-secret");
    expect(persisted).not.toContain("fragment-secret");
    expect(persisted).not.toContain("scp-secret");
  });

  it("keeps a visible failed record when a repository cannot be cloned", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-repository-failed-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const manager = new RepositoryManager(store);

    await expect(
      manager.addRepository({
        name: "Missing repository",
        handle: "missing-repo",
        source: join(root, "does-not-exist"),
      }),
    ).resolves.toMatchObject({ status: "failed", error: expect.any(String) });
    expect(store.listKnowledge()).toEqual([
      expect.objectContaining({ handle: "missing-repo", status: "failed" }),
    ]);
  });

  it("retries a failed clone into the historical path after the source becomes available", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-repository-retry-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const manager = new RepositoryManager(store);
    const source = join(root, "transient-source");
    const failed = await manager.addRepository({
      name: "Transient repository",
      handle: "transient-repo",
      source,
    });
    expect(failed).toMatchObject({ status: "failed" });
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "README.md"), "# Transient\n");
    await execFileAsync("git", ["init", "--initial-branch=main", source]);
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      source,
      "-c",
      "user.name=Nexestra Test",
      "-c",
      "user.email=test@nexestra.local",
      "commit",
      "-m",
      "Initial commit",
    ]);

    const recovered = await manager.retryRepository(failed.id);

    expect(recovered).toMatchObject({
      id: failed.id,
      handle: "transient-repo",
      source,
      status: "ready",
      defaultBranch: "main",
    });
    expect(recovered.createdAt).toBe(failed.createdAt);
    await expect(
      readFile(join(store.knowledgePath(recovered), "README.md"), "utf8"),
    ).resolves.toContain("# Transient");
    const entries = await readdir(dirname(store.knowledgePath(recovered)));
    expect(entries).toEqual(["source"]);
  });

  it("refuses to overwrite an unknown nonempty destination and keeps the failed record", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-repository-occupied-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const manager = new RepositoryManager(store);
    const failed = await manager.addRepository({
      name: "Occupied repository",
      handle: "occupied-repo",
      source: join(root, "occupied-source"),
    });
    expect(failed).toMatchObject({ status: "failed" });
    const destination = store.knowledgePath(failed);
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "keep.txt"), "user data");

    await expect(manager.retryRepository(failed.id)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(store.getKnowledge(failed.id)).toMatchObject({
      status: "failed",
      error: failed.error,
    });
    await expect(readFile(join(destination, "keep.txt"), "utf8")).resolves.toBe("user data");
  });

  it("adopts a matching existing clone during retry and rejects a foreign clone", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-repository-adopt-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const manager = new RepositoryManager(store);
    const source = join(root, "adopt-source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "README.md"), "# Adopt\n");
    await execFileAsync("git", ["init", "--initial-branch=main", source]);
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      source,
      "-c",
      "user.name=Nexestra Test",
      "-c",
      "user.email=test@nexestra.local",
      "commit",
      "-m",
      "Initial commit",
    ]);
    const failed = await store.createKnowledgeRepository({
      name: "Adopt repository",
      handle: "adopt-repo",
      description: "",
      source,
    });
    await store.updateKnowledgeRepository(failed.id, {
      status: "failed",
      error: "interrupted",
    });
    const destination = store.knowledgePath(failed);
    await mkdir(dirname(destination), { recursive: true });
    await execFileAsync("git", ["clone", source, destination]);

    const recovered = await manager.retryRepository(failed.id);

    expect(recovered).toMatchObject({ status: "ready", defaultBranch: "main" });
    await expect(readFile(join(destination, "README.md"), "utf8")).resolves.toContain("# Adopt");

    const foreign = await store.createKnowledgeRepository({
      name: "Foreign repository",
      handle: "foreign-repo",
      description: "",
      source: join(root, "foreign-source"),
    });
    await store.updateKnowledgeRepository(foreign.id, {
      status: "failed",
      error: "interrupted",
    });
    const foreignDestination = store.knowledgePath(foreign);
    await mkdir(foreignDestination, { recursive: true });
    await execFileAsync("git", ["init", "--initial-branch=main", foreignDestination]);
    await execFileAsync("git", [
      "-C",
      foreignDestination,
      "remote",
      "add",
      "origin",
      join(root, "other-source"),
    ]);
    await writeFile(join(foreignDestination, "mine.txt"), "not ours");
    await execFileAsync("git", ["-C", foreignDestination, "add", "mine.txt"]);
    await execFileAsync("git", [
      "-C",
      foreignDestination,
      "-c",
      "user.name=Nexestra Test",
      "-c",
      "user.email=test@nexestra.local",
      "commit",
      "-m",
      "Foreign commit",
    ]);

    await expect(manager.retryRepository(foreign.id)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(store.getKnowledge(foreign.id)).toMatchObject({
      status: "failed",
      error: "interrupted",
    });
    await expect(readFile(join(foreignDestination, "mine.txt"), "utf8")).resolves.toBe("not ours");
  });
  it("rejects a linked-worktree .git marker during retry and keeps the failed record", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-repository-linked-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const manager = new RepositoryManager(store);
    const source = join(root, "linked-source");
    await createLocalRepository(source);
    const failed = await store.createKnowledgeRepository({
      name: "Linked repository",
      handle: "linked-repo",
      description: "",
      source,
    });
    await store.updateKnowledgeRepository(failed.id, {
      status: "failed",
      error: "interrupted",
    });
    const destination = store.knowledgePath(failed);
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, ".git"), `gitdir: ${join(source, ".git")}\n`);

    await expect(manager.retryRepository(failed.id)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(store.getKnowledge(failed.id)).toMatchObject({
      status: "failed",
      error: "interrupted",
    });
    await expect(readFile(join(destination, ".git"), "utf8")).resolves.toContain("gitdir: ");
  });

  it("keeps a sentinel file that appears during retry untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-repository-race-file-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const source = join(root, "race-source");
    await createLocalRepository(source);
    const failed = await store.createKnowledgeRepository({
      name: "Race file repository",
      handle: "race-file",
      description: "",
      source,
    });
    await store.updateKnowledgeRepository(failed.id, {
      status: "failed",
      error: "interrupted",
    });
    const destination = store.knowledgePath(failed);
    const manager = new RepositoryManager(store, process.env, {
      beforePublish: async (_staging, target) => {
        await writeFile(target, "sentinel\n");
      },
    });

    const raced = await manager.retryRepository(failed.id);
    expect(raced).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/files that appeared during the retry/),
    });
    await expect(readFile(destination, "utf8")).resolves.toBe("sentinel\n");
    await expect(readdir(dirname(destination))).resolves.toEqual(["source"]);
  });

  it("keeps a non-empty directory that appears during retry untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-repository-race-dir-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const source = join(root, "race-dir-source");
    await createLocalRepository(source);
    const failed = await store.createKnowledgeRepository({
      name: "Race directory repository",
      handle: "race-dir",
      description: "",
      source,
    });
    await store.updateKnowledgeRepository(failed.id, {
      status: "failed",
      error: "interrupted",
    });
    const destination = store.knowledgePath(failed);
    const manager = new RepositoryManager(store, process.env, {
      beforePublish: async (_staging, target) => {
        await mkdir(target, { recursive: true });
        await writeFile(join(target, "keep.txt"), "user data\n");
      },
    });

    const raced = await manager.retryRepository(failed.id);
    expect(raced).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/files that appeared during the retry/),
    });
    await expect(readFile(join(destination, "keep.txt"), "utf8")).resolves.toBe("user data\n");
    await expect(readdir(dirname(destination))).resolves.toEqual(["source"]);
  });

  it("atomically replaces an empty directory that appears during retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-repository-race-empty-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const source = join(root, "race-empty-source");
    await createLocalRepository(source);
    const failed = await store.createKnowledgeRepository({
      name: "Race empty repository",
      handle: "race-empty",
      description: "",
      source,
    });
    await store.updateKnowledgeRepository(failed.id, {
      status: "failed",
      error: "interrupted",
    });
    const destination = store.knowledgePath(failed);
    const manager = new RepositoryManager(store, process.env, {
      beforePublish: async (_staging, target) => {
        await mkdir(target, { recursive: true });
      },
    });

    const recovered = await manager.retryRepository(failed.id);

    expect(recovered).toMatchObject({ status: "ready", defaultBranch: "main" });
    await expect(readFile(join(destination, "README.md"), "utf8")).resolves.toContain("# Fixture");
  });

  it("marks a retry failed when the ready-state write fails and adopts the published clone on the next retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-repository-ready-write-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const source = join(root, "ready-write-source");
    await createLocalRepository(source);
    const failed = await store.createKnowledgeRepository({
      name: "Ready write repository",
      handle: "ready-write-repo",
      description: "",
      source,
    });
    await store.updateKnowledgeRepository(failed.id, {
      status: "failed",
      error: "interrupted",
    });
    let readyWrites = 0;
    const originalUpdate = store.updateKnowledgeRepository.bind(store);
    const updateSpy = vi
      .spyOn(store, "updateKnowledgeRepository")
      .mockImplementation(async (id, update) => {
        if (update.status === "ready") {
          readyWrites += 1;
          if (readyWrites === 1) throw new Error("simulated ready write failure");
        }
        return originalUpdate(id, update);
      });
    const manager = new RepositoryManager(store);

    const failedAfter = await manager.retryRepository(failed.id);

    expect(failedAfter).toMatchObject({
      status: "failed",
      error: "simulated ready write failure",
    });
    await expect(
      readFile(join(store.knowledgePath(failedAfter), "README.md"), "utf8"),
    ).resolves.toContain("# Fixture");

    const recovered = await manager.retryRepository(failed.id);
    expect(recovered).toMatchObject({ status: "ready", defaultBranch: "main" });
    updateSpy.mockRestore();
  });

  it("marks an add failed when the ready-state write fails and retry adopts the published clone", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-repository-add-ready-write-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const source = join(root, "add-ready-write-source");
    await createLocalRepository(source);
    let readyWrites = 0;
    const originalUpdate = store.updateKnowledgeRepository.bind(store);
    const updateSpy = vi
      .spyOn(store, "updateKnowledgeRepository")
      .mockImplementation(async (id, update) => {
        if (update.status === "ready") {
          readyWrites += 1;
          if (readyWrites === 1) throw new Error("simulated add ready write failure");
        }
        return originalUpdate(id, update);
      });
    const manager = new RepositoryManager(store);

    const added = await manager.addRepository({
      name: "Add ready write repository",
      handle: "add-ready-write-repo",
      source,
    });

    expect(added).toMatchObject({
      status: "failed",
      error: "simulated add ready write failure",
    });
    await expect(
      readFile(join(store.knowledgePath(added), "README.md"), "utf8"),
    ).resolves.toContain("# Fixture");

    const recovered = await manager.retryRepository(added.id);
    expect(recovered).toMatchObject({ status: "ready", defaultBranch: "main" });
    updateSpy.mockRestore();
  });
});
