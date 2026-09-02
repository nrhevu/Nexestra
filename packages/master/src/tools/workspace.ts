/**
 * Filesystem implementations of the two read-only intake tools.
 *
 * `read_workspace` walks the tree with ignore rules and can pull the README
 * and package manifests it passes, which is usually enough to stop the Master
 * asking a question the repo already answers. `search_code` shells out to
 * ripgrep when it is on PATH and falls back to a plain JS walk when it is not,
 * so the Master behaves the same on a machine without rg.
 *
 * Both refuse to leave the workspace root: a `path` that escapes via `..` or
 * an absolute path outside the root is rejected rather than silently clamped.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ReadWorkspaceResult,
  SearchCodeMatch,
  SearchCodeResult,
  WorkspaceEntry,
  WorkspaceManifest,
} from "../host.js";
import type { ReadWorkspaceInput, SearchCodeInput } from "./schemas.js";

export const DEFAULT_IGNORED_DIRECTORIES: readonly string[] = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".nexestra",
  ".worktrees",
];

const MANIFEST_NAMES: readonly string[] = [
  "README.md",
  "readme.md",
  "README",
  "package.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "AGENTS.md",
  "CLAUDE.md",
];

const DEFAULT_DEPTH = 3;
const MAX_ENTRIES = 600;
const MAX_MANIFEST_BYTES = 8_000;
const MAX_MANIFESTS = 8;
const DEFAULT_MAX_RESULTS = 60;
const MAX_SEARCHED_FILE_BYTES = 1_000_000;

export interface FsWorkspaceReaderOptions {
  readonly root: string;
  readonly ignoreDirectories?: readonly string[];
  /** Force the JS walk even when ripgrep is available (used by tests). */
  readonly disableRipgrep?: boolean;
}

export interface FsWorkspaceReader {
  readWorkspace(input: ReadWorkspaceInput): Promise<ReadWorkspaceResult>;
  searchCode(input: SearchCodeInput): Promise<SearchCodeResult>;
}

function resolveInside(root: string, relative: string | undefined): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative ?? ".");
  const withinRoot = target === resolvedRoot || target.startsWith(`${resolvedRoot}${path.sep}`);
  if (!withinRoot) throw new Error(`path \`${relative}\` escapes the workspace root`);
  return target;
}

function looksBinary(sample: Buffer): boolean {
  const limit = Math.min(sample.length, 1024);
  for (let index = 0; index < limit; index += 1) {
    if (sample[index] === 0) return true;
  }
  return false;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function createFsWorkspaceReader(options: FsWorkspaceReaderOptions): FsWorkspaceReader {
  const root = path.resolve(options.root);
  const ignored = new Set(options.ignoreDirectories ?? DEFAULT_IGNORED_DIRECTORIES);

  async function walk(
    start: string,
    maxDepth: number,
    onFile?: (absolute: string, relative: string) => Promise<void> | void,
  ): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
    const entries: WorkspaceEntry[] = [];
    let truncated = false;
    const queue: { dir: string; depth: number }[] = [{ dir: start, depth: 0 }];

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      if (next.depth > maxDepth) {
        truncated = true;
        continue;
      }
      let listing: import("node:fs").Dirent[];
      try {
        listing = await fs.readdir(next.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      listing.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of listing) {
        if (entry.name.startsWith(".") && ignored.has(entry.name)) continue;
        if (ignored.has(entry.name)) continue;
        const absolute = path.join(next.dir, entry.name);
        const relative = path.relative(root, absolute) || ".";
        if (entries.length >= MAX_ENTRIES) {
          truncated = true;
          continue;
        }
        if (entry.isDirectory()) {
          entries.push({ path: relative, kind: "dir" });
          queue.push({ dir: absolute, depth: next.depth + 1 });
        } else if (entry.isFile()) {
          let size: number | undefined;
          try {
            size = (await fs.stat(absolute)).size;
          } catch {
            size = undefined;
          }
          entries.push({ path: relative, kind: "file", ...(size === undefined ? {} : { size }) });
          if (onFile) await onFile(absolute, relative);
        }
      }
    }
    return { entries, truncated };
  }

  async function readWorkspace(input: ReadWorkspaceInput): Promise<ReadWorkspaceResult> {
    const start = resolveInside(root, input.path);
    const manifests: WorkspaceManifest[] = [];
    const wantManifests = input.includeManifests !== false;

    const { entries, truncated } = await walk(
      start,
      input.depth ?? DEFAULT_DEPTH,
      wantManifests
        ? async (absolute, relative) => {
            if (manifests.length >= MAX_MANIFESTS) return;
            if (!MANIFEST_NAMES.includes(path.basename(absolute))) return;
            try {
              const content = await fs.readFile(absolute, "utf8");
              manifests.push({
                path: relative,
                content: content.slice(0, MAX_MANIFEST_BYTES),
                truncated: content.length > MAX_MANIFEST_BYTES,
              });
            } catch {
              /* unreadable file: not worth failing the whole walk */
            }
          }
        : undefined,
    );

    return { root, entries, manifests, truncated };
  }

  async function ripgrep(
    input: SearchCodeInput,
    cwd: string,
    limit: number,
  ): Promise<SearchCodeResult | null> {
    if (options.disableRipgrep) return null;
    const args = ["--line-number", "--no-heading", "--color=never", "--max-count", String(limit)];
    if (!input.regex) args.push("--fixed-strings");
    if (input.filePattern) args.push("--glob", input.filePattern);
    for (const directory of ignored) args.push("--glob", `!${directory}/`);
    args.push("--", input.query, ".");

    const stdout = await new Promise<string | null>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        resolve(null);
        return;
      }
      let buffer = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
      });
      child.on("error", () => resolve(null));
      // rg exits 1 when there are no matches, which is not a failure here.
      child.on("close", (code) => resolve(code === 0 || code === 1 ? buffer : null));
    });
    if (stdout === null) return null;

    const matches: SearchCodeMatch[] = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const first = line.indexOf(":");
      const second = line.indexOf(":", first + 1);
      if (first < 0 || second < 0) continue;
      const file = line.slice(0, first);
      const lineNumber = Number.parseInt(line.slice(first + 1, second), 10);
      if (!Number.isFinite(lineNumber)) continue;
      matches.push({
        path: path.relative(root, path.resolve(cwd, file)) || file,
        line: lineNumber,
        text: line.slice(second + 1).slice(0, 400),
      });
      if (matches.length >= limit) break;
    }
    return { matches, truncated: matches.length >= limit, engine: "ripgrep" };
  }

  async function jsSearch(
    input: SearchCodeInput,
    cwd: string,
    limit: number,
  ): Promise<SearchCodeResult> {
    const matcher = input.regex ? new RegExp(input.query) : null;
    const namePattern = input.filePattern ? globToRegExp(input.filePattern) : null;
    const matches: SearchCodeMatch[] = [];

    await walk(cwd, 24, async (absolute, relative) => {
      if (matches.length >= limit) return;
      if (namePattern && !namePattern.test(path.basename(absolute))) return;
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(absolute);
      } catch {
        return;
      }
      if (stat.size > MAX_SEARCHED_FILE_BYTES) return;
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(absolute);
      } catch {
        return;
      }
      if (looksBinary(buffer)) return;
      const lines = buffer.toString("utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const hit = matcher ? matcher.test(line) : line.includes(input.query);
        if (!hit) continue;
        matches.push({ path: relative, line: index + 1, text: line.slice(0, 400) });
        if (matches.length >= limit) return;
      }
    });

    return { matches, truncated: matches.length >= limit, engine: "walk" };
  }

  async function searchCode(input: SearchCodeInput): Promise<SearchCodeResult> {
    const cwd = resolveInside(root, input.path);
    const limit = input.maxResults ?? DEFAULT_MAX_RESULTS;
    const viaRipgrep = await ripgrep(input, cwd, limit);
    return viaRipgrep ?? (await jsSearch(input, cwd, limit));
  }

  return { readWorkspace, searchCode };
}
