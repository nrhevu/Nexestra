/**
 * Small git helper shared by the adapters and (later) the orchestrator.
 *
 * Creating the worktree is *not* the adapter's job — the orchestrator hands
 * `RunSpec.cwd` to `prepare()` — but both sides need the same primitives, and
 * `diff()` in particular is load bearing for Codex: its `file_change` items
 * carry `{path, kind}` and no patch content at all
 * (`docs/harness-protocols.md` §1.3), so the real diff has to come from git.
 *
 * Implemented with `execa` rather than `simple-git` so that non-zero exits
 * (`git diff --no-index` always exits 1 on a difference) and pathspec quoting
 * stay under our control.
 */
import { constants as fsConstants } from "node:fs";
import { access, mkdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

/** The well known hash of git's empty tree, used as a base in a repo with no commits. */
export const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type FileChangeKind = "add" | "modify" | "delete";

export interface WorktreeChangedFile {
  /** Path relative to the worktree root, in POSIX form. */
  path: string;
  kind: FileChangeKind;
  /** True when the file is not tracked by git yet. */
  untracked: boolean;
}

export interface WorktreeDiff {
  /** The ref the diff was taken against (`HEAD`, a branch, or the empty tree). */
  base: string;
  /** Unified diff, including synthesised hunks for untracked files. */
  patch: string;
  files: WorktreeChangedFile[];
  /** True when `patch` was cut short by `maxBytes`. */
  truncated: boolean;
}

export interface EnsureWorktreeResult {
  repo: string;
  branch: string;
  path: string;
  /** False when the worktree already existed and was reused. */
  created: boolean;
  /** False when `branch` already existed and was checked out as-is. */
  branchCreated: boolean;
}

export class GitError extends Error {
  override readonly name = "GitError";
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | undefined,
  ) {
    super(message);
  }
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function git(cwd: string, args: readonly string[], allowFailure = false): Promise<GitResult> {
  const result = await execa("git", args, {
    cwd,
    reject: false,
    stdin: "ignore",
    all: false,
    env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : 1;
  const out: GitResult = {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode,
  };
  if (exitCode !== 0 && !allowFailure) {
    throw new GitError(
      `git ${args.join(" ")} failed with exit code ${exitCode}: ${out.stderr.trim()}`,
      args,
      out.stderr,
      exitCode,
    );
  }
  return out;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function samePath(a: string, b: string): Promise<boolean> {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

/** True when `dir` is inside a git working tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  if (!(await exists(dir))) return false;
  const result = await git(dir, ["rev-parse", "--is-inside-work-tree"], true);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

/** Absolute path of the working tree root containing `dir`. */
export async function repoRoot(dir: string): Promise<string | undefined> {
  const result = await git(dir, ["rev-parse", "--show-toplevel"], true);
  if (result.exitCode !== 0) return undefined;
  const root = result.stdout.trim();
  return root.length > 0 ? root : undefined;
}

/** True when the repository has at least one commit (i.e. `HEAD` resolves). */
export async function hasCommits(dir: string): Promise<boolean> {
  const result = await git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"], true);
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  const result = await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], true);
  return result.exitCode === 0;
}

/**
 * Create (or reuse) a git worktree for `branch` at `worktreePath`.
 *
 * Idempotent: if the path is already a worktree of `repo` it is returned
 * untouched, so a resumed orchestrator does not have to remember what it made.
 */
export async function ensureWorktree(
  repo: string,
  branch: string,
  worktreePath: string,
  options: { startPoint?: string } = {},
): Promise<EnsureWorktreeResult> {
  if (!(await isGitRepo(repo))) {
    throw new GitError(`${repo} is not a git repository`, ["rev-parse"], "", undefined);
  }
  const absolute = path.resolve(worktreePath);

  if (await exists(absolute)) {
    const info = await stat(absolute);
    if (!info.isDirectory()) {
      throw new GitError(`${absolute} exists and is not a directory`, [], "", undefined);
    }
    if (await exists(path.join(absolute, ".git"))) {
      const root = await repoRoot(absolute);
      // Compare through realpath: on macOS `/var/…` is a symlink to
      // `/private/var/…`, and git always answers with the resolved form.
      if (root !== undefined && (await samePath(root, absolute))) {
        return { repo, branch, path: absolute, created: false, branchCreated: false };
      }
    }
  }

  await mkdir(path.dirname(absolute), { recursive: true });
  const known = await branchExists(repo, branch);
  const args = known
    ? ["worktree", "add", absolute, branch]
    : [
        "worktree",
        "add",
        "-b",
        branch,
        absolute,
        ...(options.startPoint ? [options.startPoint] : []),
      ];
  await git(repo, args);
  return { repo, branch, path: absolute, created: true, branchCreated: !known };
}

/** Remove a worktree and prune the administrative entry. */
export async function removeWorktree(
  repo: string,
  worktreePath: string,
  options: { force?: boolean; deleteDirectory?: boolean } = {},
): Promise<void> {
  const absolute = path.resolve(worktreePath);
  const args = ["worktree", "remove", ...(options.force ? ["--force"] : []), absolute];
  const result = await git(repo, args, true);
  if (result.exitCode !== 0) {
    // A directory that git no longer knows about still has to disappear.
    if (options.deleteDirectory !== false && (await exists(absolute))) {
      await rm(absolute, { recursive: true, force: true });
    }
  }
  await git(repo, ["worktree", "prune"], true);
}

export interface DiffOptions {
  /** Extra pathspecs, e.g. `":(exclude).nexestra"`. */
  excludePathspecs?: readonly string[];
  /** Cap on the returned patch; the remainder is replaced with a marker. */
  maxBytes?: number;
}

/**
 * Compute the real diff of `cwd` against `base`.
 *
 * Untracked files are included: git's `diff` alone would miss every file the
 * harness created, so each one is diffed against `/dev/null` with
 * `--no-index`. Nothing is staged — the index is never touched.
 */
export async function diff(
  cwd: string,
  base?: string,
  options: DiffOptions = {},
): Promise<WorktreeDiff> {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const excludes = options.excludePathspecs ?? [];
  const resolvedBase = base ?? ((await hasCommits(cwd)) ? "HEAD" : EMPTY_TREE_HASH);

  const files = await changedFiles(cwd, excludes);

  const pieces: string[] = [];
  const tracked = await git(
    cwd,
    ["--no-pager", "diff", "--no-color", resolvedBase, "--", ".", ...excludes],
    true,
  );
  if (tracked.stdout.length > 0) pieces.push(tracked.stdout);

  for (const file of files) {
    if (!file.untracked) continue;
    const result = await git(
      cwd,
      ["--no-pager", "diff", "--no-color", "--no-index", "--", "/dev/null", file.path],
      true,
    );
    if (result.stdout.length > 0) pieces.push(result.stdout);
  }

  let patch = pieces.join(pieces.length > 1 ? "\n" : "");
  let truncated = false;
  if (Buffer.byteLength(patch, "utf8") > maxBytes) {
    patch = `${patch.slice(0, maxBytes)}\n… diff truncated at ${maxBytes} bytes\n`;
    truncated = true;
  }

  return { base: resolvedBase, patch, files, truncated };
}

/** `git status --porcelain` for `cwd`, normalised to `WorktreeChangedFile`. */
export async function changedFiles(
  cwd: string,
  excludePathspecs: readonly string[] = [],
): Promise<WorktreeChangedFile[]> {
  const result = await git(
    cwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".", ...excludePathspecs],
    true,
  );
  if (result.exitCode !== 0) return [];

  const files: WorktreeChangedFile[] = [];
  const records = result.stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    let file = record.slice(3);
    // Renames emit `R  <new>\0<old>` — consume the second field.
    if (status.startsWith("R") || status.startsWith("C")) index += 1;
    if (file.length === 0) continue;
    file = file.split(path.sep).join("/");
    files.push({ path: file, kind: statusToKind(status), untracked: status === "??" });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function statusToKind(status: string): FileChangeKind {
  if (status === "??") return "add";
  const codes = `${status[0] ?? " "}${status[1] ?? " "}`;
  if (codes.includes("D")) return "delete";
  if (codes.includes("A") || codes.includes("R") || codes.includes("C")) return "add";
  return "modify";
}
