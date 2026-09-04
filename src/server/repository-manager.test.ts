import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { RepositoryManager } from "./repository-manager.js";
import { FileStore } from "./store.js";

const execFileAsync = promisify(execFile);

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
    await manager.prepareAssignment(repository, location);

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
});
