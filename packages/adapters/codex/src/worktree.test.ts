import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  changedFiles,
  diff,
  EMPTY_TREE_HASH,
  ensureWorktree,
  GitError,
  hasCommits,
  isGitRepo,
  removeWorktree,
  repoRoot,
} from "./worktree.js";

let root: string;
let repo: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execa("git", args, { cwd, stdin: "ignore" });
  return typeof result.stdout === "string" ? result.stdout : "";
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nexestra-worktree-"));
  repo = path.join(root, "repo");
  await execa("git", ["init", "-q", "-b", "main", repo], { stdin: "ignore" });
  await git(repo, "config", "user.email", "test@nexestra.local");
  await git(repo, "config", "user.name", "nexestra test");
  await writeFile(path.join(repo, "math.ts"), "export const mul = (a, b) => a * b;\n", "utf8");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "initial");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("repository probes", () => {
  it("detects a git working tree and its root", async () => {
    expect(await isGitRepo(repo)).toBe(true);
    expect(await isGitRepo(path.join(root, "not-a-repo"))).toBe(false);
    expect(await repoRoot(repo)).toBe(await git(repo, "rev-parse", "--show-toplevel"));
    expect(await hasCommits(repo)).toBe(true);
  });

  it("reports a repository with no commits", async () => {
    const empty = path.join(root, "empty");
    await execa("git", ["init", "-q", "-b", "main", empty], { stdin: "ignore" });
    expect(await hasCommits(empty)).toBe(false);
  });
});

describe("ensureWorktree", () => {
  it("creates a worktree on a new branch", async () => {
    const target = path.join(root, "wt", "task-1");
    const result = await ensureWorktree(repo, "nexestra/task-1", target);
    expect(result.created).toBe(true);
    expect(result.branchCreated).toBe(true);
    expect(await isGitRepo(target)).toBe(true);
    expect((await readFile(path.join(target, "math.ts"), "utf8")).length).toBeGreaterThan(0);
    expect(await git(target, "rev-parse", "--abbrev-ref", "HEAD")).toBe("nexestra/task-1");
  });

  it("is idempotent for an existing worktree", async () => {
    const target = path.join(root, "wt", "task-2");
    await ensureWorktree(repo, "nexestra/task-2", target);
    const again = await ensureWorktree(repo, "nexestra/task-2", target);
    expect(again.created).toBe(false);
    expect(again.branchCreated).toBe(false);
  });

  it("checks out an existing branch instead of recreating it", async () => {
    await git(repo, "branch", "feature");
    const target = path.join(root, "wt", "feature");
    const result = await ensureWorktree(repo, "feature", target);
    expect(result.branchCreated).toBe(false);
    expect(await git(target, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
  });

  it("refuses a non-repository", async () => {
    await expect(
      ensureWorktree(path.join(root, "nope"), "b", path.join(root, "wt", "x")),
    ).rejects.toBeInstanceOf(GitError);
  });
});

describe("removeWorktree", () => {
  it("removes the worktree and prunes the entry", async () => {
    const target = path.join(root, "wt", "task-3");
    await ensureWorktree(repo, "nexestra/task-3", target);
    await removeWorktree(repo, target);
    expect(await git(repo, "worktree", "list")).not.toContain(target);
  });

  it("force-removes a dirty worktree", async () => {
    const target = path.join(root, "wt", "task-4");
    await ensureWorktree(repo, "nexestra/task-4", target);
    await writeFile(path.join(target, "dirty.txt"), "x", "utf8");
    await removeWorktree(repo, target, { force: true });
    expect(await git(repo, "worktree", "list")).not.toContain(target);
  });
});

describe("diff", () => {
  it("returns an empty diff for a clean tree", async () => {
    const result = await diff(repo);
    expect(result.base).toBe("HEAD");
    expect(result.patch).toBe("");
    expect(result.files).toEqual([]);
  });

  it("captures a modification", async () => {
    await writeFile(
      path.join(repo, "math.ts"),
      "export const mul = (a, b) => a * b + 0;\n",
      "utf8",
    );
    const result = await diff(repo);
    expect(result.files).toEqual([{ path: "math.ts", kind: "modify", untracked: false }]);
    expect(result.patch).toContain("--- a/math.ts");
    expect(result.patch).toContain("+export const mul");
  });

  it("captures an untracked file, which plain `git diff` would miss", async () => {
    await writeFile(path.join(repo, "hello.txt"), "hello\n", "utf8");
    const result = await diff(repo);
    expect(result.files).toEqual([{ path: "hello.txt", kind: "add", untracked: true }]);
    expect(result.patch).toContain("hello.txt");
    expect(result.patch).toContain("+hello");
  });

  it("captures a deletion", async () => {
    await rm(path.join(repo, "math.ts"));
    const result = await diff(repo);
    expect(result.files).toEqual([{ path: "math.ts", kind: "delete", untracked: false }]);
    expect(result.patch).toContain("--- a/math.ts");
  });

  it("never stages anything", async () => {
    await writeFile(path.join(repo, "hello.txt"), "hello\n", "utf8");
    await diff(repo);
    expect(await git(repo, "diff", "--cached", "--name-only")).toBe("");
  });

  it("honours exclude pathspecs", async () => {
    await writeFile(path.join(repo, "keep.txt"), "keep\n", "utf8");
    const result = await diff(repo, undefined, { excludePathspecs: [":(exclude)keep.txt"] });
    expect(result.files).toEqual([]);
    expect(result.patch).toBe("");
  });

  it("keeps adapter scratch files out of the diff", async () => {
    await writeFile(path.join(repo, "real.txt"), "real\n", "utf8");
    const runDir = path.join(repo, ".nexestra", "runs", "run_1");
    await execa("mkdir", ["-p", runDir], { stdin: "ignore" });
    await writeFile(path.join(runDir, "last-message.md"), "noise\n", "utf8");
    const result = await diff(repo, undefined, { excludePathspecs: [":(exclude).nexestra"] });
    expect(result.files.map((file) => file.path)).toEqual(["real.txt"]);
  });

  it("diffs against an arbitrary base ref", async () => {
    await git(repo, "checkout", "-q", "-b", "feature");
    await writeFile(
      path.join(repo, "math.ts"),
      "export const mul = (a, b) => a * b;\nexport const add = (a, b) => a + b;\n",
      "utf8",
    );
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "add");
    const result = await diff(repo, "main");
    expect(result.base).toBe("main");
    expect(result.patch).toContain("+export const add");
  });

  it("falls back to the empty tree in a repo with no commits", async () => {
    const empty = path.join(root, "fresh");
    await execa("git", ["init", "-q", "-b", "main", empty], { stdin: "ignore" });
    await writeFile(path.join(empty, "a.txt"), "a\n", "utf8");
    const result = await diff(empty);
    expect(result.base).toBe(EMPTY_TREE_HASH);
    expect(result.files).toEqual([{ path: "a.txt", kind: "add", untracked: true }]);
  });

  it("truncates an oversized patch", async () => {
    await writeFile(path.join(repo, "big.txt"), "x\n".repeat(5000), "utf8");
    const result = await diff(repo, undefined, { maxBytes: 200 });
    expect(result.truncated).toBe(true);
    expect(result.patch).toContain("diff truncated at 200 bytes");
  });

  it("lists renames once, as an add", async () => {
    await git(repo, "mv", "math.ts", "maths.ts");
    const files = await changedFiles(repo);
    expect(files).toEqual([{ path: "maths.ts", kind: "add", untracked: false }]);
  });
});
