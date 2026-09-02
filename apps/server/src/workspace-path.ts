import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { HttpError } from "./errors.js";

export interface ResolvedWorkspacePath {
  rootPath: string;
  name: string;
  defaultBranch: string;
}

/**
 * A workspace must point at a git repository: worktree isolation (PLAN.md §10)
 * depends on it, so a plain directory is rejected with a clear message rather
 * than failing later at dispatch time.
 */
export function resolveWorkspacePath(input: string): ResolvedWorkspacePath {
  const expanded = input.startsWith("~") ? join(homedir(), input.slice(1)) : input;
  const rootPath = resolve(expanded);

  if (!isAbsolute(rootPath)) {
    throw invalid(rootPath, "the path must be absolute");
  }

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(rootPath);
  } catch {
    throw invalid(rootPath, "no such directory on this machine");
  }
  if (!stats.isDirectory()) {
    throw invalid(rootPath, "the path is a file, not a directory");
  }

  const git = gitDirOf(rootPath);
  if (!git) {
    throw invalid(
      rootPath,
      "the directory is not a git repository — run `git init` there first, or point at the repository root",
    );
  }

  return {
    rootPath,
    name: basename(rootPath),
    defaultBranch: headBranch(git) ?? "main",
  };
}

/**
 * `.git` is a directory in a normal clone and a file containing `gitdir: …` in
 * a worktree. Returns the resolved git directory, or null when there is none.
 */
function gitDirOf(rootPath: string): string | null {
  const dotGit = join(rootPath, ".git");
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(dotGit);
  } catch {
    return null;
  }
  if (stats.isDirectory()) return dotGit;
  if (!stats.isFile()) return null;

  try {
    const pointer = readFileSync(dotGit, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    if (!match?.[1]) return null;
    return isAbsolute(match[1]) ? match[1] : resolve(rootPath, match[1]);
  } catch {
    return null;
  }
}

/** `ref: refs/heads/main` → `main`; detached HEAD gives null. */
function headBranch(gitDir: string): string | null {
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function invalid(path: string, reason: string): HttpError {
  return new HttpError(
    400,
    "invalid_workspace_path",
    `Cannot use "${path}" as a workspace: ${reason}.`,
    { path },
  );
}
