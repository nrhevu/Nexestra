import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { RepositoryManager } from "./repository-manager.js";
import { FileStore } from "./store.js";

const execFileAsync = promisify(execFile);

describe("RepositoryManager retry lock", () => {
  it("rejects a second retry while the first clone is still running", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-repository-lock-"));
    const source = join(root, "locked-source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "README.md"), "# Locked\n");
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
    const store = await FileStore.open({ root, workspacePath: root });
    const repository = await store.createKnowledgeRepository({
      name: "Locked repository",
      handle: "locked-repo",
      description: "",
      source,
    });
    await store.updateKnowledgeRepository(repository.id, {
      status: "failed",
      error: "stopped",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new RepositoryManager(store, process.env, {
      beforeClone: () => gate,
    });

    const first = manager.retryRepository(repository.id);
    await expect(manager.retryRepository(repository.id)).rejects.toMatchObject({
      code: "conflict",
      message: /already running/i,
    });
    release();
    const recovered = await first;

    expect(recovered).toMatchObject({
      id: repository.id,
      handle: "locked-repo",
      source,
      status: "ready",
      defaultBranch: "main",
    });
    expect(recovered.createdAt).toBe(repository.createdAt);
  });
});
