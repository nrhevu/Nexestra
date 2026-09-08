import { type ChildProcess, spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type {
  AssignmentGitPatch,
  AssignmentGitReview,
  AssignmentGitReviewState,
  AssignmentGitTrackedSummary,
  WorkAssignment,
} from "../shared/contracts.js";
import { parseGitNumstat } from "./git-numstat.js";
import { findExecutable, safeProcessEnv } from "./process.js";
import { type FileStore, StoreError } from "./store.js";

const MAX_SUMMARY_FILES = 200;
const MAX_UNTRACKED_FILES = 500;
const MAX_PATCH_BYTES = 200 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const FULL_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export interface AssignmentGitReviewOptions {
  env?: NodeJS.ProcessEnv;
}

interface ResolvedWorktree {
  realPath: string;
}

type ResolveOutcome =
  | { kind: "ok"; worktree: ResolvedWorktree }
  | { kind: "missing" }
  | { kind: "unsafe"; reason: string };

interface GitOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  timedOut: boolean;
}

const GIT_SAFETY_ARGS = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=",
  "-c",
  "diff.external=",
  "-c",
  "diff.textconv=false",
  "-c",
  "diff.submodule=short",
  "-c",
  "diff.ignoreSubmodules=dirty",
  "-c",
  "core.askpass=",
  "-c",
  "core.sshCommand=",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "submodule.recurse=false",
  "-c",
  "fetch.recurseSubmodules=false",
];

export class AssignmentGitReviewer {
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly store: FileStore,
    options: AssignmentGitReviewOptions = {},
  ) {
    this.env = {
      ...safeProcessEnv(options.env),
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ATTR_NOSYSTEM: "1",
    };
  }

  async review(assignmentId: string): Promise<AssignmentGitReview> {
    const assignment = this.store.listAssignments().find((entry) => entry.id === assignmentId);
    if (!assignment) throw new StoreError("not_found", "Assignment not found.");

    if (assignment.worktreeCleanedAt) {
      return this.brief(assignment, "cleaned", "The Worker worktree was already removed.");
    }
    const resolved = await this.resolveWorktree(assignment);
    if (resolved.kind === "unsafe") return this.brief(assignment, "unsafe", resolved.reason);
    if (resolved.kind === "missing") {
      if (assignment.status === "queued") {
        return this.brief(assignment, "pending", "The Worker worktree has not been prepared yet.");
      }
      return this.brief(
        assignment,
        "missing",
        "The Worker worktree is no longer present but cleanup was not recorded.",
      );
    }
    if (!assignment.baseCommit) {
      return this.brief(
        assignment,
        "legacy",
        "This assignment predates base commit capture; read-only Git inspection is disabled.",
      );
    }
    if (!FULL_SHA.test(assignment.baseCommit)) {
      return this.brief(
        assignment,
        "unavailable",
        "The recorded base commit is not a full commit SHA.",
      );
    }

    try {
      const filters = await this.customFilters(resolved.worktree);
      if (filters.length > 0) {
        return this.brief(
          assignment,
          "unavailable",
          `The Worker repository configures custom Git filters (${filters.join(", ")}); read-only inspection is disabled.`,
        );
      }
      const identity = await this.verifyIdentity(assignment, resolved.worktree);
      if (!identity.ok) return this.brief(assignment, "unavailable", identity.reason);
      const head = await this.gitHead(resolved.worktree);
      if (!head || !FULL_SHA.test(head)) {
        return this.brief(assignment, "unavailable", "Could not read the Worker worktree HEAD.");
      }
      return await this.activeReview(assignment, resolved.worktree, head);
    } catch (error) {
      const reason = this.store
        .redactSecrets(error instanceof Error ? error.message : "Git review failed.")
        .slice(0, 2_000);
      return this.brief(assignment, "unavailable", reason);
    }
  }

  private brief(
    assignment: WorkAssignment,
    state: AssignmentGitReviewState,
    reason: string,
  ): AssignmentGitReview {
    return {
      assignment,
      state,
      reason: this.store.redactSecrets(reason).slice(0, 2_000),
      worktreePath: assignment.worktreePath,
      branch: assignment.branch,
      baseCommit: assignment.baseCommit,
    };
  }

  private async resolveWorktree(assignment: WorkAssignment): Promise<ResolveOutcome> {
    if (!assignment.worktreePath || isAbsolute(assignment.worktreePath)) {
      return { kind: "unsafe", reason: "The Worker worktree path is not a managed relative path." };
    }
    const lexicalRoot = resolve(this.store.root);
    const expected = resolve(lexicalRoot, assignment.worktreePath);
    if (!expected.startsWith(lexicalRoot + sep)) {
      return {
        kind: "unsafe",
        reason: "The Worker worktree path escapes the Nexestra data directory.",
      };
    }
    if (
      !(await access(expected)
        .then(() => true)
        .catch(() => false))
    )
      return { kind: "missing" };
    const [realRoot, realPath] = await Promise.all([
      realpath(lexicalRoot),
      realpath(expected).catch(() => undefined),
    ]);
    if (!realPath || (!realPath.startsWith(realRoot + sep) && realPath !== realRoot)) {
      return {
        kind: "unsafe",
        reason: "The Worker worktree path resolves outside the Nexestra data directory.",
      };
    }
    return { kind: "ok", worktree: { realPath } };
  }

  private async customFilters(worktree: ResolvedWorktree): Promise<string[]> {
    const outcome = await this.rawGit(worktree.realPath, [
      "config",
      "--get-regexp",
      "--name-only",
      "^filter\\.",
    ]);
    if (outcome.timedOut) throw new Error("Git review command timed out.");
    if (outcome.truncated) {
      throw new Error("Git review command exceeded its output bound.");
    }
    // git config --get-regexp exits 1 with empty output when nothing matches.
    // Any other non-zero exit, or a non-empty match list, means the repository
    // may run custom filters and must not be inspected.
    if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
      throw new Error(
        outcome.stderr.trim() || "Could not read Worker repository filter configuration.",
      );
    }
    if (outcome.exitCode === 1) {
      if (outcome.stdout.trim() === "") return [];
      throw new Error("Could not read Worker repository filter configuration.");
    }

    return outcome.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();
  }

  private async verifyIdentity(
    assignment: WorkAssignment,
    worktree: ResolvedWorktree,
  ): Promise<{ ok: boolean; reason: string }> {
    const repository = this.store.getKnowledge(assignment.repositoryId);
    if (repository?.kind !== "repository") {
      return { ok: false, reason: "The assignment repository is unavailable." };
    }
    const lexicalRoot = resolve(this.store.root);
    const realRoot = await realpath(lexicalRoot).catch(() => undefined);
    if (!realRoot) {
      return { ok: false, reason: "The Nexestra data directory is unavailable." };
    }
    const knowledgePath = await realpath(resolve(this.store.knowledgePath(repository))).catch(
      () => undefined,
    );
    if (!knowledgePath || !this.isWithin(realRoot, knowledgePath)) {
      return {
        ok: false,
        reason: "The assignment repository escapes the Nexestra data directory.",
      };
    }

    const [toplevel, workCommon, repositoryCommon, branch] = await Promise.all([
      this.rawGit(worktree.realPath, ["rev-parse", "--show-toplevel"]),
      this.rawGit(worktree.realPath, ["rev-parse", "--git-common-dir"]),
      this.rawGit(knowledgePath, ["rev-parse", "--git-common-dir"]),
      this.rawGit(worktree.realPath, ["symbolic-ref", "--short", "HEAD"]),
    ]);
    for (const outcome of [toplevel, workCommon, repositoryCommon, branch]) {
      if (outcome.timedOut) return { ok: false, reason: "Git review command timed out." };
      if (outcome.truncated) {
        return { ok: false, reason: "Git review command exceeded its output bound." };
      }
    }
    if (toplevel.exitCode !== 0 || toplevel.stdout.trim() !== worktree.realPath) {
      return { ok: false, reason: "The directory is not the expected Worker repository worktree." };
    }
    const workCommonPath = await realpath(
      resolve(worktree.realPath, workCommon.stdout.trim()),
    ).catch(() => undefined);
    const repositoryCommonPath = await realpath(
      resolve(knowledgePath, repositoryCommon.stdout.trim()),
    ).catch(() => undefined);
    if (
      !workCommonPath ||
      !repositoryCommonPath ||
      !this.isWithin(realRoot, workCommonPath) ||
      !this.isWithin(realRoot, repositoryCommonPath)
    ) {
      return { ok: false, reason: "The repository metadata escapes the Nexestra data directory." };
    }
    if (workCommonPath !== repositoryCommonPath) {
      return { ok: false, reason: "The worktree belongs to a different repository." };
    }
    if (branch.exitCode !== 0 || branch.stdout.trim() !== assignment.branch) {
      return { ok: false, reason: "The worktree is not on the assigned Worker branch." };
    }
    return { ok: true, reason: "" };
  }

  private isWithin(root: string, path: string): boolean {
    return path === root || path.startsWith(root + sep);
  }

  private async gitHead(worktree: ResolvedWorktree): Promise<string | undefined> {
    const outcome = await this.rawGit(worktree.realPath, ["rev-parse", "HEAD"]);
    if (outcome.timedOut || outcome.truncated || outcome.exitCode !== 0) return undefined;
    const head = outcome.stdout.trim();
    return head && FULL_SHA.test(head) ? head : undefined;
  }

  private async activeReview(
    assignment: WorkAssignment,
    worktree: ResolvedWorktree,
    head: string,
  ): Promise<AssignmentGitReview> {
    const base = assignment.baseCommit ?? "";
    const [committed, staged, unstaged, baseToWorktree, untracked, patchOutcome] =
      await Promise.all([
        this.numstat(worktree, [
          "diff",
          "--numstat",
          "-z",
          "--no-renames",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          base,
          head,
          "--",
        ]),
        this.numstat(worktree, [
          "diff",
          "--cached",
          "--numstat",
          "-z",
          "--no-renames",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--",
        ]),
        this.numstat(worktree, [
          "diff",
          "--numstat",
          "-z",
          "--no-renames",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--",
        ]),
        this.numstat(worktree, [
          "diff",
          "--numstat",
          "-z",
          "--no-renames",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          base,
          "--",
        ]),
        this.untracked(worktree),
        this.rawGit(
          worktree.realPath,
          ["diff", "--unified=2", "--no-color", "--no-ext-diff", "--no-textconv", base, "--"],
          MAX_PATCH_BYTES,
        ),
      ]);
    if (patchOutcome.timedOut) throw new Error("Git review command timed out.");
    if (patchOutcome.exitCode !== 0 && !patchOutcome.truncated) {
      throw new Error(
        patchOutcome.stderr.trim() ||
          patchOutcome.stdout.trim() ||
          "Could not render the Worker diff.",
      );
    }
    const binaryPaths = baseToWorktree.files
      .filter((file) => file.insertions === null && file.deletions === null)
      .map((file) => file.path);
    const patch: AssignmentGitPatch = {
      content: this.store.redactSecrets(patchOutcome.stdout).slice(0, MAX_PATCH_BYTES),
      truncated: patchOutcome.truncated,
      binaryPaths,
    };
    return {
      assignment,
      state: "available",
      worktreePath: assignment.worktreePath,
      branch: assignment.branch,
      baseCommit: base,
      headCommit: head,
      tracked: { committed, staged, unstaged, baseToWorktree, patch },
      untracked,
    };
  }

  private async numstat(
    worktree: ResolvedWorktree,
    args: string[],
  ): Promise<AssignmentGitTrackedSummary> {
    const outcome = await this.rawGit(worktree.realPath, args);
    if (outcome.timedOut) throw new Error("Git review command timed out.");
    if (outcome.exitCode !== 0 && !outcome.truncated) {
      throw new Error(
        outcome.stderr.trim() || outcome.stdout.trim() || "Could not compare the Worker worktree.",
      );
    }
    const parsed = parseGitNumstat(outcome.stdout, MAX_SUMMARY_FILES);
    return {
      files: parsed.files.map((file) => ({
        path: this.store.redactSecrets(file.path).slice(0, 2_000),
        insertions: file.insertions,
        deletions: file.deletions,
      })),
      insertions: parsed.insertions,
      deletions: parsed.deletions,
      truncated: outcome.truncated || parsed.truncated,
    };
  }

  private async untracked(
    worktree: ResolvedWorktree,
  ): Promise<{ files: string[]; truncated: boolean }> {
    const outcome = await this.rawGit(worktree.realPath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    if (outcome.timedOut) throw new Error("Git review command timed out.");
    if (outcome.exitCode !== 0 && !outcome.truncated) {
      throw new Error(
        outcome.stderr.trim() || outcome.stdout.trim() || "Could not list untracked Worker files.",
      );
    }
    const all = outcome.stdout.split("\0").filter((path) => path.length > 0);
    return {
      files: all
        .slice(0, MAX_UNTRACKED_FILES)
        .map((path) => this.store.redactSecrets(path).slice(0, 2_000)),
      truncated: outcome.truncated || all.length > MAX_UNTRACKED_FILES,
    };
  }

  private async rawGit(
    cwd: string,
    args: string[],
    maxOutputBytes = 2 * 1024 * 1024,
  ): Promise<GitOutcome> {
    const binary = await findExecutable("git", this.env);
    if (!binary) throw new StoreError("invalid", "Git is not available on this machine.");
    return runBoundedGit(binary, [...GIT_SAFETY_ARGS, ...args], {
      cwd,
      env: this.env,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes,
    });
  }
}

function runBoundedGit(
  binary: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
  },
): Promise<GitOutcome> {
  if (options.maxOutputBytes <= 0) {
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: 1,
      truncated: true,
      timedOut: false,
    });
  }
  return new Promise((resolvePromise) => {
    const child: ChildProcess = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;
    let timedOut = false;
    let ended = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number) => {
      if (ended) return;
      ended = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
        truncated,
        timedOut,
      });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    }, options.timeoutMs);
    const collect = (chunk: Buffer, sink: "stdout" | "stderr") => {
      if (truncated) return;
      const remaining = options.maxOutputBytes - totalBytes;
      if (chunk.byteLength <= remaining) {
        (sink === "stdout" ? stdoutChunks : stderrChunks).push(chunk);
        totalBytes += chunk.byteLength;
        return;
      }
      if (remaining > 0) {
        (sink === "stdout" ? stdoutChunks : stderrChunks).push(chunk.subarray(0, remaining));
      }
      totalBytes = options.maxOutputBytes;
      truncated = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    };
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (!childStdout || !childStderr) {
      child.kill("SIGTERM");
      finish(1);
      return;
    }
    childStdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    childStderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.on("error", () => finish(1));
    child.on("close", (code) => finish(code ?? 1));
  });
}

export function reviewAssignmentGit(
  store: FileStore,
  assignmentId: string,
  options?: AssignmentGitReviewOptions,
): Promise<AssignmentGitReview> {
  return new AssignmentGitReviewer(store, options).review(assignmentId);
}
