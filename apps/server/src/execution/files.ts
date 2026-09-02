/**
 * The Editor surface's data: what is in a run's worktree, and how it differs
 * from the branch it was cut from.
 *
 * The git primitives come from `@nexestra/adapter-codex/worktree`, which both
 * adapters and the orchestrator already use, so there is exactly one
 * implementation of "what changed here". The tree itself is a plain filesystem
 * walk with the git statuses overlaid — a `git ls-files` would miss precisely
 * the files a harness just created.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { WorktreeDiff } from "@nexestra/adapter-codex/worktree";
import { changedFiles, diff } from "@nexestra/adapter-codex/worktree";
import type { FileContent, FileNode, RunDiff } from "@nexestra/core";

/** Never walked: noise, or big enough to stall the response. */
const IGNORED = new Set([
  ".git",
  ".nexestra",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "target",
  "__pycache__",
  ".venv",
  "coverage",
]);

const MAX_ENTRIES = 4000;
const MAX_DEPTH = 8;
/** Files larger than this are not sent to CodeMirror. */
const MAX_FILE_BYTES = 512 * 1024;

const EXTENSION_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".css": "css",
  ".html": "html",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".sh": "shell",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".sql": "sql",
};

export function languageFor(filePath: string): string {
  return EXTENSION_LANGUAGE[path.extname(filePath).toLowerCase()] ?? "text";
}

/**
 * Flat node list, exactly the shape the Editor's `FileTree` renders: every
 * node carries its own path and the paths of its children.
 *
 * The A/M/D marks are the worktree against `base` — not `git status`. Once the
 * orchestrator has committed a task's work the status is clean, and a tree with
 * no marks would tell the reader that nothing happened.
 */
export async function readWorktreeTree(worktree: string, base?: string): Promise<FileNode[]> {
  const statuses = await statusMap(worktree, base);
  const nodes: FileNode[] = [];
  let budget = MAX_ENTRIES;

  const walk = async (dir: string, relative: string, depth: number): Promise<string[]> => {
    if (depth > MAX_DEPTH || budget <= 0) return [];
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return [];
    }

    const sorted = [...entries].sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const children: string[] = [];
    for (const entry of sorted) {
      if (budget <= 0) break;
      if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
      if (IGNORED.has(entry.name)) continue;

      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      budget -= 1;

      if (entry.isDirectory()) {
        const grandchildren = await walk(path.join(dir, entry.name), childRelative, depth + 1);
        nodes.push({
          path: childRelative,
          name: entry.name,
          kind: "dir",
          status: "unchanged",
          children: grandchildren,
        });
        children.push(childRelative);
      } else if (entry.isFile()) {
        nodes.push({
          path: childRelative,
          name: entry.name,
          kind: "file",
          status: statuses.get(childRelative) ?? "unchanged",
          children: [],
        });
        children.push(childRelative);
      }
    }
    return children;
  };

  await walk(worktree, "", 0);
  return nodes;
}

/** One file's text, refused when it is binary or too large to be useful. */
export async function readWorktreeFile(
  worktree: string,
  relative: string,
): Promise<FileContent | null> {
  const target = resolveInside(worktree, relative);
  if (!target) return null;

  let size: number;
  try {
    const stats = await stat(target);
    if (!stats.isFile()) return null;
    size = stats.size;
  } catch {
    return null;
  }

  if (size > MAX_FILE_BYTES) {
    return {
      path: relative,
      language: languageFor(relative),
      content: `// ${relative} is ${Math.round(size / 1024)} KiB — too large to display.\n`,
    };
  }

  const buffer = await readFile(target);
  if (buffer.includes(0)) {
    return { path: relative, language: "text", content: `// ${relative} is a binary file.\n` };
  }
  return { path: relative, language: languageFor(relative), content: buffer.toString("utf8") };
}

/** The run's worktree against the branch it was cut from. */
export async function readWorktreeDiff(options: {
  runId: string;
  worktree: string;
  base?: string;
}): Promise<RunDiff> {
  const result = await diff(options.worktree, options.base, {
    excludePathspecs: [":(exclude).nexestra"],
  });
  return {
    runId: options.runId,
    worktreePath: options.worktree,
    base: result.base,
    patch: result.patch,
    files: changedAgainstBase(result),
    truncated: result.truncated,
  };
}

/**
 * The files this diff touches.
 *
 * `WorktreeDiff.files` comes from `git status`, which only ever sees
 * *uncommitted* work — right for a review of a live run, wrong here: the loop
 * commits each task's worktree once it is verified, so a finished task would
 * report a patch with no files in it. The patch is the authority, so the list
 * is read back out of it; `git status` only contributes the untracked flag.
 */
function changedAgainstBase(result: WorktreeDiff): RunDiff["files"] {
  const untracked = new Set(result.files.filter((file) => file.untracked).map((file) => file.path));
  const fromPatch = filesFromPatch(result.patch).map((file) => ({
    ...file,
    untracked: untracked.has(file.path),
  }));
  if (fromPatch.length > 0) return fromPatch;
  return result.files.map((file) => ({
    path: file.path,
    kind: file.kind,
    untracked: file.untracked,
  }));
}

/** Read `diff --git a/x b/x` headers and their add/delete markers. */
function filesFromPatch(patch: string): { path: string; kind: "add" | "modify" | "delete" }[] {
  const files: { path: string; kind: "add" | "modify" | "delete" }[] = [];
  let current: { path: string; kind: "add" | "modify" | "delete" } | null = null;

  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2] ?? header[1] ?? "", kind: "modify" };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.kind = "add";
    else if (line.startsWith("deleted file mode")) current.kind = "delete";
  }
  return files.filter((file) => file.path.length > 0);
}

/* ---------------------------------------------------------------- internals */

async function statusMap(
  worktree: string,
  base?: string,
): Promise<Map<string, FileNode["status"]>> {
  const map = new Map<string, FileNode["status"]>();
  const mark = (path: string, kind: "add" | "modify" | "delete") => {
    map.set(path, kind === "add" ? "added" : kind === "delete" ? "deleted" : "modified");
  };

  try {
    // Uncommitted first, then everything since `base` — so a task that has
    // already been committed still shows what it changed.
    for (const file of await changedFiles(worktree, [":(exclude).nexestra"])) {
      mark(file.path, file.kind);
    }
    if (base) {
      const result = await diff(worktree, base, { excludePathspecs: [":(exclude).nexestra"] });
      for (const file of changedAgainstBase(result)) mark(file.path, file.kind);
    }
  } catch {
    // A directory that is not a git worktree still gets a tree, just no marks.
  }
  return map;
}

/** Reject `..` and absolute escapes before touching the filesystem. */
function resolveInside(root: string, relative: string): string | null {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}
