import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AssignmentGitReviewer } from "./assignment-review.js";
import { RepositoryManager } from "./repository-manager.js";
import { FileStore } from "./store.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  return execFileAsync("git", ["-C", cwd, ...args]);
}

async function commitAll(cwd: string, message: string) {
  await git(cwd, "add", "-A");
  await git(
    cwd,
    "-c",
    "user.name=Nexestra Test",
    "-c",
    "user.email=test@nexestra.local",
    "commit",
    "-m",
    message,
  );
}

async function makeSource(source: string) {
  await git(source, "init", "--initial-branch=main");
  await writeFile(join(source, "README.md"), "# Base repository\n");
  await commitAll(source, "Initial commit");
}

async function openStore(root: string, secret?: string) {
  if (secret) {
    await writeFile(
      join(root, "credentials.json"),
      JSON.stringify({ version: 1, credentials: { "agent-worker": secret } }),
      { mode: 0o600 },
    );
  }
  return FileStore.open({ root, workspacePath: root });
}

async function setup(secret?: string) {
  const source = await mkdtemp(join(tmpdir(), "nexestra-review-source-"));
  await makeSource(source);
  const root = await mkdtemp(join(tmpdir(), "nexestra-review-store-"));
  const store = await openStore(root, secret);
  const manager = new RepositoryManager(store);
  const repository = await manager.addRepository({
    name: "Product repository",
    handle: "product-repo",
    source,
  });
  const workspace = store.listWorkspaces()[0];
  const thread = store.listThreads()[0];
  if (!workspace || !thread) throw new Error("Expected seeded workspace and thread.");
  const id = `assignment-${crypto.randomUUID()}`;
  const location = manager.assignmentLocation(workspace.id, id);
  const prepared = await manager.prepareAssignment(repository, location);
  if (!prepared) throw new Error("Expected prepared base commit.");
  const now = new Date().toISOString();
  const assignment = await store.createAssignment({
    id,
    workspaceId: workspace.id,
    taskId: "task-review",
    threadId: thread.id,
    masterRunId: "run-master",
    workerAgentId: "agent-worker",
    repositoryId: repository.id,
    status: "running",
    branch: location.branch,
    worktreePath: location.worktreePath,
    baseCommit: prepared.baseCommit,
    createdAt: now,
    updatedAt: now,
  });
  const reviewer = new AssignmentGitReviewer(store);
  return {
    source,
    root,
    store,
    manager,
    repository,
    assignment,
    location,
    reviewer,
    worktree: location.absolutePath,
  };
}

describe("AssignmentGitReviewer", () => {
  it("reports committed, staged, unstaged, untracked, and a bounded text patch", async () => {
    const fixture = await setup();
    const { worktree, assignment, reviewer } = fixture;
    await writeFile(join(worktree, "README.md"), "# Changed on the Worker\n");
    await writeFile(join(worktree, "committed.txt"), "committed content\n");
    await git(worktree, "add", "committed.txt");
    await git(
      worktree,
      "-c",
      "user.name=Nexestra Test",
      "-c",
      "user.email=test@nexestra.local",
      "commit",
      "-m",
      "Worker commit",
    );
    await writeFile(join(worktree, "staged.txt"), "staged content\n");
    await git(worktree, "add", "staged.txt");
    await writeFile(join(worktree, "untracked-note.md"), "note\n");

    const review = await reviewer.review(assignment.id);
    expect(review.state).toBe("available");
    expect(review.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(review.headCommit).not.toBe(review.baseCommit);
    expect(review.tracked?.committed.files.map((file) => file.path)).toContain("committed.txt");
    expect(review.tracked?.staged.files.map((file) => file.path)).toContain("staged.txt");
    expect(review.tracked?.unstaged.files.map((file) => file.path)).toContain("README.md");
    expect(review.tracked?.unstaged.files).toEqual([
      expect.objectContaining({ path: "README.md", insertions: 1, deletions: 1 }),
    ]);
    expect(review.untracked?.files).toContain("untracked-note.md");
    expect(review.tracked?.baseToWorktree.files.length).toBe(3);
    expect(review.tracked?.patch.content).toContain("committed.txt");
    expect(review.tracked?.patch.content).toContain("staged.txt");
    expect(review.tracked?.patch.binaryPaths).toEqual([]);
    expect(review.tracked?.patch.truncated).toBe(false);
  });

  it("keeps the recorded base stable when the shared repository main advances", async () => {
    const fixture = await setup();
    const { source, assignment, reviewer } = fixture;
    const first = await reviewer.review(assignment.id);
    expect(first.state).toBe("available");
    await writeFile(join(source, "README.md"), "# Shared main moved forward\n");
    await commitAll(source, "Advance shared main");
    const second = await reviewer.review(assignment.id);
    expect(second.state).toBe("available");
    expect(second.baseCommit).toBe(first.baseCommit);
    expect(second.headCommit).toBe(first.baseCommit);
    expect(second.tracked?.committed.files).toEqual([]);
  });

  it("refuses a foreign repository installed in the assigned worktree path", async () => {
    const fixture = await setup();
    const { root, worktree, assignment, reviewer } = fixture;
    const backup = join(root, "worktree-backup");
    await rename(worktree, backup);
    await mkdir(worktree, { recursive: true });
    await git(worktree, "init", "--initial-branch=main");
    await writeFile(join(worktree, "foreign.txt"), "foreign\n");
    await commitAll(worktree, "Foreign commit");
    await git(worktree, "checkout", "-b", assignment.branch);

    const review = await reviewer.review(assignment.id);
    expect(review.state).toBe("unavailable");
    expect(review.reason).toMatch(/different repository/i);
  });

  it("rejects worktree paths that escape the data directory through symlinks or relative paths", async () => {
    const fixture = await setup();
    const { worktree, assignment, store, reviewer } = fixture;
    const outside = await mkdtemp(join(tmpdir(), "nexestra-review-outside-"));
    await rename(worktree, join(outside, "worktree"));
    await symlink(join(outside, "worktree"), worktree);

    const symlinkReview = await reviewer.review(assignment.id);
    expect(symlinkReview.state).toBe("unsafe");

    const now = new Date().toISOString();
    const escaping = await store.createAssignment({
      id: "assignment-escape",
      workspaceId: assignment.workspaceId,
      taskId: "task-escape",
      threadId: assignment.threadId,
      masterRunId: "run-master",
      workerAgentId: "agent-worker",
      repositoryId: assignment.repositoryId,
      status: "running",
      branch: "nexestra/escape",
      worktreePath: "../../outside",
      baseCommit: assignment.baseCommit,
      createdAt: now,
      updatedAt: now,
    });
    const escapeReview = await reviewer.review(escaping.id);
    expect(escapeReview.state).toBe("unsafe");
  });

  it("returns honest pending, missing, cleared, and legacy states", async () => {
    const fixture = await setup();
    const { worktree, assignment, store, reviewer } = fixture;
    const now = new Date().toISOString();

    await store.createAssignment({
      id: "assignment-pending",
      workspaceId: assignment.workspaceId,
      taskId: "task-pending",
      threadId: assignment.threadId,
      masterRunId: "run-master",
      workerAgentId: "agent-worker",
      repositoryId: assignment.repositoryId,
      status: "queued",
      branch: "nexestra/pending",
      worktreePath: "workspaces/workspace/worktrees/never-prepared",
      baseCommit: assignment.baseCommit,
      createdAt: now,
      updatedAt: now,
    });
    expect((await reviewer.review("assignment-pending")).state).toBe("pending");

    await rm(worktree, { recursive: true, force: true });
    expect((await reviewer.review(assignment.id)).state).toBe("missing");

    await store.updateAssignment(assignment.id, { worktreeCleanedAt: now });
    expect((await reviewer.review(assignment.id)).state).toBe("cleaned");

    const legacy = await store.createAssignment({
      id: "assignment-legacy",
      workspaceId: assignment.workspaceId,
      taskId: "task-legacy",
      threadId: assignment.threadId,
      masterRunId: "run-master",
      workerAgentId: "agent-worker",
      repositoryId: assignment.repositoryId,
      status: "running",
      branch: "nexestra/legacy",
      worktreePath: assignment.worktreePath,
      createdAt: now,
      updatedAt: now,
    });
    await mkdir(join(store.root, assignment.worktreePath), { recursive: true });
    expect((await reviewer.review(legacy.id)).state).toBe("legacy");
    expect((await reviewer.review(legacy.id)).reason).toMatch(/predates/i);
  });

  it("fails closed on any configured Git filter without executing it", async () => {
    const fixture = await setup();
    const { worktree, assignment, reviewer } = fixture;
    await writeFile(join(worktree, ".gitattributes"), "README.md filter=.dot\n");
    await git(worktree, "config", "filter..dot.clean", "touch clean-filter-called");
    await writeFile(join(worktree, "README.md"), "# Dirty through the filter\n");

    const review = await reviewer.review(assignment.id);
    expect(review.state).toBe("unavailable");
    expect(review.reason).toMatch(/custom Git filters/i);
    await expect(
      execFileAsync("test", ["-e", join(worktree, "clean-filter-called")]),
    ).rejects.toThrow();
  });

  it("never lets diff.external or core.fsmonitor drivers run during review", async () => {
    const fixture = await setup();
    const { worktree, assignment, reviewer } = fixture;
    await git(worktree, "config", "diff.external", "touch external-called");
    await git(worktree, "config", "core.fsmonitor", "touch fsmonitor-called");
    await writeFile(join(worktree, "README.md"), "# Driver-safe change\n");

    const review = await reviewer.review(assignment.id);
    expect(review.state).toBe("available");
    await expect(
      execFileAsync("test", ["-e", join(worktree, "external-called")]),
    ).rejects.toThrow();
    await expect(
      execFileAsync("test", ["-e", join(worktree, "fsmonitor-called")]),
    ).rejects.toThrow();
  });

  it("caps the patch and untracked list and reports truncation", async () => {
    const fixture = await setup();
    const { worktree, assignment, reviewer } = fixture;
    await writeFile(join(worktree, "big.txt"), "0123456789".repeat(120_000));
    await git(worktree, "add", "big.txt");
    let review = await reviewer.review(assignment.id);
    expect(review.state).toBe("available");
    expect(review.tracked?.patch.truncated).toBe(true);
    expect(review.tracked?.patch.content.length).toBeLessThanOrEqual(200 * 1024);

    const many = join(worktree, "many");
    await mkdir(many, { recursive: true });
    for (let index = 0; index < 510; index += 1) {
      await writeFile(join(many, `file-${index}.txt`), "x\n");
    }
    review = await reviewer.review(assignment.id);
    expect(review.untracked?.files.length).toBe(500);
    expect(review.untracked?.truncated).toBe(true);
  });

  it("redacts stored credentials from patch content and untracked paths", async () => {
    const secret = "secret-credential-abc123";
    const fixture = await setup(secret);
    const { worktree, assignment, reviewer } = fixture;
    await writeFile(join(worktree, "README.md"), `# Secret ${secret} inside\n`);
    await writeFile(join(worktree, `${secret}-notes.md`), "private\n");

    const review = await reviewer.review(assignment.id);
    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });

  it("keeps submodule review scoped to the recorded gitlink pointer", async () => {
    const fixture = await setup();
    const { worktree, assignment, reviewer } = fixture;
    await git(worktree, "init", "--initial-branch=main", "nested");
    await writeFile(join(worktree, "nested", "inner.txt"), "one\n");
    await commitAll(join(worktree, "nested"), "Nested initial");
    await git(
      worktree,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "./nested",
      "nested",
    );
    await git(worktree, "add", ".gitmodules", "nested");
    await git(
      worktree,
      "-c",
      "user.name=Nexestra Test",
      "-c",
      "user.email=test@nexestra.local",
      "commit",
      "-m",
      "Add submodule",
    );
    await writeFile(join(worktree, "nested", "inner.txt"), "two\n");
    await commitAll(join(worktree, "nested"), "Nested change");
    await git(worktree, "add", "nested");
    await git(
      worktree,
      "-c",
      "user.name=Nexestra Test",
      "-c",
      "user.email=test@nexestra.local",
      "commit",
      "-m",
      "Bump submodule",
    );

    const review = await reviewer.review(assignment.id);
    expect(review.state).toBe("available");
    expect(review.tracked?.committed.files.map((file) => file.path)).toContain("nested");
    expect(review.tracked?.patch.content).toContain("Subproject commit");
    expect(review.tracked?.patch.content).not.toContain("two");
  });
});
