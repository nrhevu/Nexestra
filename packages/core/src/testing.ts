/**
 * Test-only helpers shared by every layer of the pyramid.
 *
 * Adapter tests, orchestrator tests and the Playwright suite all need the same
 * thing: a throwaway git repository on disk that a harness can be pointed at
 * and that `git diff` will tell the truth about. Keeping one implementation
 * here stops the three from drifting.
 *
 * Deliberately not re-exported from `index.ts`: nothing in the runtime surface
 * — and nothing in the browser bundle — should be able to reach `node:fs`
 * through `@nexestra/core`. Import it as `@nexestra/core/testing`.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface TempGitRepo {
  /** The temp directory holding everything, including `repo`. */
  readonly root: string;
  /** The git repository itself — the path a workspace points at. */
  readonly repo: string;
  /** Run git inside the repo and return its stdout. */
  git(...args: string[]): Promise<string>;
  /** Write a file (creating parent directories) relative to the repo. */
  write(file: string, content: string): Promise<void>;
  /** `git add -A && git commit` — a no-op when nothing changed. */
  commitAll(message: string): Promise<void>;
  /** `git status --porcelain`, for asserting that a run really changed files. */
  status(): Promise<string>;
  /** Remove the whole temp tree. */
  cleanup(): Promise<void>;
}

export interface CreateTempGitRepoOptions {
  /** Prefix of the temp directory name. Default `nexestra-`. */
  readonly prefix?: string;
  /** Initial branch. Default `main`. */
  readonly branch?: string;
  /** Files committed as the initial commit. Default a one-line README. */
  readonly files?: Readonly<Record<string, string>>;
}

/**
 * Create a git repository in a temp directory, with one commit in it.
 *
 * The repo is configured with its own identity and no signing, so it works on
 * a machine whose global git config would otherwise refuse to commit.
 */
export async function createTempGitRepo(
  options: CreateTempGitRepoOptions = {},
): Promise<TempGitRepo> {
  const root = await mkdtemp(path.join(tmpdir(), options.prefix ?? "nexestra-"));
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });

  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await run("git", args, { cwd: repo, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  };

  const write = async (file: string, content: string): Promise<void> => {
    const target = path.join(repo, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  };

  await run("git", ["init", "-q", "-b", options.branch ?? "main", repo]);
  await git("config", "user.email", "test@nexestra.local");
  await git("config", "user.name", "nexestra test");
  await git("config", "commit.gpgsign", "false");

  const files = options.files ?? { "README.md": "# scratch\n" };
  for (const [file, content] of Object.entries(files)) await write(file, content);

  const commitAll = async (message: string): Promise<void> => {
    await git("add", "-A");
    const staged = await git("status", "--porcelain");
    if (staged.trim().length === 0) return;
    await git("commit", "-q", "-m", message);
  };

  await commitAll("initial");

  return {
    root,
    repo,
    git,
    write,
    commitAll,
    // `-uall` so an untracked directory is reported as its files, which is
    // what a test asserting "the harness wrote src/hello.ts" needs to see.
    status: () => git("status", "--porcelain", "-uall"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Poll until `predicate` is true, or throw after `timeoutMs`. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
