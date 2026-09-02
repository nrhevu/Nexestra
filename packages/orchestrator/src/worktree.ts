/**
 * Worktree bookkeeping for the loop (PLAN.md §1.10, §6).
 *
 * One worktree per task at `<worktreeRoot>/<threadId>/<taskId>` on branch
 * `nexestra/<threadId>/<taskId>`. The git primitives themselves come from
 * `@nexestra/adapter-codex/worktree`, which both adapters already use, so
 * there is exactly one implementation of "what changed in this worktree".
 */
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { ensureWorktree, removeWorktree } from "@nexestra/adapter-codex/worktree";
import { execa } from "execa";

/** Branch a task's worktree lives on. Stable, so a resume finds it again. */
export function branchNameFor(threadId: string, taskId: string): string {
  return `nexestra/${threadId}/${taskId}`;
}

/** Where a task's worktree lives under the configured root. */
export function worktreePathFor(root: string, threadId: string, taskId: string): string {
  return path.join(root, threadId, taskId);
}

export interface TaskWorktree {
  readonly repo: string;
  readonly path: string;
  readonly branch: string;
  readonly created: boolean;
}

/** Create or reuse the worktree for one task. Idempotent. */
export async function ensureTaskWorktree(options: {
  repo: string;
  worktreeRoot: string;
  threadId: string;
  taskId: string;
  /** Ref the branch is cut from the first time. */
  baseBranch?: string;
  /** Overrides the derived path (`HarnessConfig.worktreePath`). */
  overridePath?: string;
  /** Overrides the derived branch (`HarnessConfig.branch`). */
  overrideBranch?: string;
}): Promise<TaskWorktree> {
  const branch = options.overrideBranch ?? branchNameFor(options.threadId, options.taskId);
  const target = options.overridePath
    ? path.isAbsolute(options.overridePath)
      ? options.overridePath
      : path.join(options.repo, options.overridePath)
    : worktreePathFor(options.worktreeRoot, options.threadId, options.taskId);

  const result = await ensureWorktree(
    options.repo,
    branch,
    target,
    options.baseBranch ? { startPoint: options.baseBranch } : {},
  );
  return { repo: result.repo, path: result.path, branch: result.branch, created: result.created };
}

interface GitOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function git(cwd: string, args: readonly string[]): Promise<GitOutcome> {
  const result = await execa("git", args, {
    cwd,
    reject: false,
    stdin: "ignore",
    env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : 1;
  return {
    ok: exitCode === 0,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode,
  };
}

export interface CommitResult {
  /** False when the worktree had nothing to commit. */
  committed: boolean;
  sha?: string;
  detail?: string;
}

/**
 * Commit whatever the harness left in the worktree onto the task branch.
 *
 * Nothing merges an uncommitted worktree, and the review step needs the
 * changes *un*committed, so this runs once, after review and verification.
 */
export async function commitWorktree(
  worktree: string,
  message: string,
  identity: { name: string; email: string },
): Promise<CommitResult> {
  // Adapter scratch files (`.nexestra/runs/<runId>`) never belong in a commit.
  const add = await git(worktree, ["add", "-A", "--", ".", ":(exclude).nexestra"]);
  if (!add.ok) return { committed: false, detail: add.stderr.trim() };

  const staged = await git(worktree, ["diff", "--cached", "--quiet"]);
  if (staged.exitCode === 0) return { committed: false, detail: "nothing to commit" };

  const commit = await git(worktree, [
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    "commit",
    "--no-verify",
    "-q",
    "-m",
    message,
  ]);
  if (!commit.ok) return { committed: false, detail: commit.stderr.trim() };

  const head = await git(worktree, ["rev-parse", "HEAD"]);
  return { committed: true, sha: head.stdout.trim() };
}

export type MergeOutcome = "merged" | "up_to_date" | "conflict" | "unavailable";

export interface MergeResult {
  outcome: MergeOutcome;
  /** `fast-forward` or `merge commit`, when it landed. */
  strategy?: "fast-forward" | "merge-commit";
  detail?: string;
}

/**
 * Merge a task branch into `into`, inside the main checkout.
 *
 * Refuses (`unavailable`) rather than forcing anything when the repository is
 * not sitting cleanly on the target branch — a half-finished rebase or a dirty
 * tree is the user's business, not the orchestrator's.
 */
export async function mergeTaskBranch(options: {
  repo: string;
  branch: string;
  into: string;
  identity: { name: string; email: string };
  message?: string;
}): Promise<MergeResult> {
  const { repo, branch, into, identity } = options;

  const head = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head.ok) return { outcome: "unavailable", detail: head.stderr.trim() };
  if (head.stdout.trim() !== into) {
    return {
      outcome: "unavailable",
      detail: `the repository is on "${head.stdout.trim()}", not "${into}"`,
    };
  }

  const dirty = await git(repo, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.stdout.trim().length > 0) {
    return { outcome: "unavailable", detail: "the repository has uncommitted changes" };
  }

  const behind = await git(repo, ["rev-list", "--count", `${into}..${branch}`]);
  if (behind.ok && behind.stdout.trim() === "0") {
    return { outcome: "up_to_date" };
  }

  const identityArgs = ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
  const ff = await git(repo, [...identityArgs, "merge", "--ff-only", branch]);
  if (ff.ok) return { outcome: "merged", strategy: "fast-forward" };

  const message = options.message ?? `Merge ${branch}`;
  const merge = await git(repo, [
    ...identityArgs,
    "merge",
    "--no-ff",
    "--no-edit",
    "-m",
    message,
    branch,
  ]);
  if (merge.ok) return { outcome: "merged", strategy: "merge-commit" };

  const conflicts = await git(repo, ["diff", "--name-only", "--diff-filter=U"]);
  await git(repo, ["merge", "--abort"]);
  const files = conflicts.stdout.trim();
  return {
    outcome: "conflict",
    detail: files.length > 0 ? `conflicting files:\n${files}` : merge.stderr.trim(),
  };
}

/**
 * Delete worktrees under `<worktreeRoot>/<threadId>` that no live task claims.
 *
 * Called by `recover()`: a crash can leave directories behind for tasks that
 * were removed by a replan, and git keeps an administrative entry for each.
 */
export async function pruneStaleWorktrees(options: {
  repo: string;
  worktreeRoot: string;
  threadId: string;
  /** Task ids whose worktrees must be kept. */
  keep: ReadonlySet<string>;
}): Promise<string[]> {
  const dir = path.join(options.worktreeRoot, options.threadId);
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const name of entries) {
    if (options.keep.has(name)) continue;
    const target = path.join(dir, name);
    await removeWorktree(options.repo, target, { force: true }).catch(() => {});
    await rm(target, { recursive: true, force: true }).catch(() => {});
    removed.push(target);
  }
  await git(options.repo, ["worktree", "prune"]);
  return removed;
}
