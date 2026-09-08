import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  CreateKnowledgeRepositorySchema,
  KNOWLEDGE_BRANCH_LIST_MAX_ROWS,
  KNOWLEDGE_BRANCH_NAME_MAX_LENGTH,
  type KnowledgeRepository,
  type KnowledgeRepositoryBranchesResponse,
  KnowledgeRepositoryBranchesResponseSchema,
  SelectRepositorySourceBranchSchema,
} from "../shared/contracts.js";
import { isRepresentableBranchName, parseGitLsRemoteBranches } from "./git-ls-remote.js";
import { findExecutable, runCommand, safeProcessEnv } from "./process.js";
import { type FileStore, inspectRepositoryDestinationKind, StoreError } from "./store.js";

const LIST_BRANCH_TIMEOUT_MS = 15_000;
const LIST_BRANCH_MAX_OUTPUT_BYTES = 1024 * 1024;
const LIST_BRANCH_MAX_ERROR_CHARS = 2_000;

export interface AssignmentLocation {
  branch: string;
  worktreePath: string;
  absolutePath: string;
}

export interface AssignmentPreparation {
  baseCommit: string;
}

export interface AssignmentRepositoryManager {
  assignmentLocation(workspaceId: string, assignmentId: string): AssignmentLocation;
  prepareAssignment(
    repository: KnowledgeRepository,
    location: AssignmentLocation,
    signal?: AbortSignal,
  ): Promise<AssignmentPreparation | undefined>;
  cleanupAssignment(
    repository: KnowledgeRepository,
    location: AssignmentLocation,
    signal?: AbortSignal,
  ): Promise<void>;
  deleteAssignmentBranch(
    repository: KnowledgeRepository,
    location: AssignmentLocation,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface RepositoryManagerDeps {
  beforeClone?: (staging: string, source: string) => Promise<void>;
  beforePublish?: (staging: string, destination: string) => Promise<void>;
  beforeFetch?: () => Promise<void>;
}

export class RepositoryManager implements AssignmentRepositoryManager {
  private readonly retryLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: FileStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly deps: RepositoryManagerDeps = {},
  ) {}

  async addRepository(rawInput: unknown): Promise<KnowledgeRepository> {
    const input = CreateKnowledgeRepositorySchema.parse(rawInput);
    const source = normaliseRepositorySource(input.source, this.store.workspacePath);
    const repository = await this.store.createKnowledgeRepository({ ...input, source });
    try {
      const defaultBranch = await this.cloneAndPublish(repository, source);
      return await this.store.updateKnowledgeRepository(repository.id, {
        status: "ready",
        ...(defaultBranch ? { defaultBranch } : {}),
      });
    } catch (error) {
      const message = this.store
        .redactSecrets(error instanceof Error ? error.message : "Repository clone failed.")
        .slice(0, 2_000);
      return await this.store.updateKnowledgeRepository(repository.id, {
        status: "failed",
        error: message,
      });
    }
  }

  async retryRepository(repositoryId: string): Promise<KnowledgeRepository> {
    this.assertRetryable(this.requireRepository(repositoryId));
    return this.withRepositoryOperationLock(repositoryId, async () => {
      const repository = this.requireRepository(repositoryId);
      this.assertRetryable(repository);
      const destination = this.store.knowledgePath(repository);
      const state = await inspectRepositoryDestinationKind(destination);
      if (state === "git") {
        const adopted = await this.adoptExistingGitClone(repository, destination, await this.git());
        if (!adopted) {
          throw new StoreError(
            "conflict",
            this.destinationOccupiedMessage(
              destination,
              "a git clone that does not belong to this item",
            ),
          );
        }
        return this.store.updateKnowledgeRepository(repositoryId, {
          status: "ready",
          error: undefined,
          ...(adopted.defaultBranch ? { defaultBranch: adopted.defaultBranch } : {}),
        });
      }
      if (state === "occupied") {
        throw new StoreError(
          "conflict",
          this.destinationOccupiedMessage(destination, "unknown files"),
        );
      }
      await this.store.updateKnowledgeRepository(repositoryId, { status: "cloning" });
      try {
        const defaultBranch = await this.cloneAndPublish(repository, repository.source);
        return await this.store.updateKnowledgeRepository(repositoryId, {
          status: "ready",
          error: undefined,
          ...(defaultBranch ? { defaultBranch } : {}),
        });
      } catch (error) {
        const message = this.store
          .redactSecrets(error instanceof Error ? error.message : "Repository clone failed.")
          .slice(0, 2_000);
        return await this.store.updateKnowledgeRepository(repositoryId, {
          status: "failed",
          error: message,
        });
      }
    });
  }

  async refreshRepository(repositoryId: string): Promise<KnowledgeRepository> {
    return this.withRepositoryOperationLock(repositoryId, async () => {
      const repository = this.requireRepository(repositoryId);
      if (repository.status !== "ready") {
        throw new StoreError(
          "conflict",
          `#${repository.handle} must be ready before refreshing its source.`,
        );
      }
      if (repository.refreshing) {
        throw new StoreError("conflict", "A source refresh is already running for this item.");
      }
      const effectiveBranch = repository.selectedBranch ?? repository.defaultBranch;
      if (!effectiveBranch) {
        throw new StoreError("conflict", "This clone has no recorded default branch to refresh.");
      }
      const sourceRef = `refs/heads/${effectiveBranch}`;
      await this.store.updateKnowledgeRepository(repositoryId, {
        status: "ready",
        refreshing: true,
        refreshError: undefined,
      });
      try {
        const git = await this.git();
        const destination = this.store.knowledgePath(repository);
        const sourceCommit = await this.fetchSourceSnapshot(
          repository,
          git,
          destination,
          sourceRef,
        );
        return await this.store.updateKnowledgeRepository(repositoryId, {
          status: "ready",
          refreshing: false,
          refreshError: undefined,
          sourceCommit,
          sourceRef,
          refreshedAt: new Date().toISOString(),
          sourceVersion: (repository.sourceVersion ?? 0) + 1,
        });
      } catch (error) {
        return await this.store.updateKnowledgeRepository(repositoryId, {
          status: "ready",
          refreshing: false,
          refreshError: this.store
            .redactSecrets(error instanceof Error ? error.message : "Git source refresh failed.")
            .slice(0, LIST_BRANCH_MAX_ERROR_CHARS),
        });
      }
    });
  }

  async listBranches(repositoryId: string): Promise<KnowledgeRepositoryBranchesResponse> {
    const repository = this.requireRepository(repositoryId);
    if (repository.status !== "ready") {
      throw new StoreError(
        "conflict",
        `#${repository.handle} must be ready before listing source branches.`,
      );
    }
    const git = await this.git();
    const destination = this.store.knowledgePath(repository);
    await this.assertSafeManagedClone(repository, destination, git);
    const result = await this.runRepositoryGit(
      git,
      destination,
      ["ls-remote", "--quiet", "--heads", "--refs", "--exit-code", "--", repository.source],
      LIST_BRANCH_TIMEOUT_MS,
      LIST_BRANCH_MAX_OUTPUT_BYTES,
    );
    if (result.exitCode !== 0 && result.exitCode !== 2) {
      const message = this.store
        .redactSecrets(result.stderr.trim() || result.stdout.trim() || "Git branch listing failed.")
        .slice(0, LIST_BRANCH_MAX_ERROR_CHARS);
      throw new StoreError("conflict", `Could not list source branches: ${message}`);
    }
    const parsed = parseGitLsRemoteBranches(result.stdout, {
      maxRows: KNOWLEDGE_BRANCH_LIST_MAX_ROWS,
      maxNameLength: KNOWLEDGE_BRANCH_NAME_MAX_LENGTH,
      redact: (value: string) => this.store.redactSecrets(value),
    });
    let truncated = parsed.truncated;
    const defaultBranch = this.safeBranchMetadata(repository.defaultBranch, () => {
      truncated = true;
    });
    const selectedBranch = this.safeBranchMetadata(
      repository.selectedBranch ?? repository.defaultBranch ?? null,
      () => {
        truncated = true;
      },
    );
    return KnowledgeRepositoryBranchesResponseSchema.parse({
      branches: parsed.branches,
      truncated,
      sourceVersion: repository.sourceVersion ?? 0,
      selectedBranch,
      defaultBranch,
    });
  }

  async selectSourceBranch(repositoryId: string, rawInput: unknown): Promise<KnowledgeRepository> {
    const input = SelectRepositorySourceBranchSchema.parse(rawInput);
    return this.withRepositoryOperationLock(repositoryId, async () => {
      const repository = this.requireRepository(repositoryId);
      if (repository.status !== "ready") {
        throw new StoreError(
          "conflict",
          `#${repository.handle} must be ready before selecting a source branch.`,
        );
      }
      if (repository.refreshing) {
        throw new StoreError(
          "conflict",
          "Another source operation is already running for this item.",
        );
      }
      const currentVersion = repository.sourceVersion ?? 0;
      if (input.expectedSourceVersion !== currentVersion) {
        throw new StoreError(
          "conflict",
          `The recorded source version is ${currentVersion}, not ${input.expectedSourceVersion}. Refresh or select the source again.`,
        );
      }
      await this.validateSourceBranchName(input.branch);
      const sourceRef = `refs/heads/${input.branch}`;
      await this.store.updateKnowledgeRepository(repositoryId, {
        status: "ready",
        refreshing: true,
        refreshError: undefined,
      });
      try {
        const git = await this.git();
        const destination = this.store.knowledgePath(repository);
        const sourceCommit = await this.fetchSourceSnapshot(
          repository,
          git,
          destination,
          sourceRef,
        );
        return await this.store.updateKnowledgeRepository(repositoryId, {
          status: "ready",
          refreshing: false,
          refreshError: undefined,
          selectedBranch: input.branch,
          sourceCommit,
          sourceRef,
          refreshedAt: new Date().toISOString(),
          sourceVersion: currentVersion + 1,
        });
      } catch (error) {
        return await this.store.updateKnowledgeRepository(repositoryId, {
          status: "ready",
          refreshing: false,
          refreshError: this.store
            .redactSecrets(
              error instanceof Error ? error.message : "Git source branch selection failed.",
            )
            .slice(0, LIST_BRANCH_MAX_ERROR_CHARS),
        });
      }
    });
  }

  private safeBranchMetadata(
    value: string | null | undefined,
    onOmission: () => void,
  ): string | null {
    if (value === null || value === undefined) return null;
    if (
      !isRepresentableBranchName(value, KNOWLEDGE_BRANCH_NAME_MAX_LENGTH) ||
      this.store.redactSecrets(value) !== value
    ) {
      onOmission();
      return null;
    }
    return value;
  }

  private async validateSourceBranchName(branch: string): Promise<void> {
    if (
      [...branch].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f;
      })
    ) {
      throw new StoreError("invalid", "Branch names must not contain control characters.");
    }
    if (branch.startsWith("-")) {
      throw new StoreError("invalid", "Branch names must not start with an option-like dash.");
    }
    if (this.store.redactSecrets(branch) !== branch) {
      throw new StoreError("invalid", "Branch names must not contain stored credentials.");
    }
    const git = await this.git();
    const checked = await runCommand(git, ["check-ref-format", `refs/heads/${branch}`], {
      cwd: this.store.workspacePath,
      timeoutMs: 10_000,
      env: safeProcessEnv(this.env),
    });
    if (checked.exitCode !== 0) {
      throw new StoreError("invalid", "Enter a valid Git branch name.");
    }
  }

  private async assertSafeManagedClone(
    repository: KnowledgeRepository,
    destination: string,
    git: string,
  ): Promise<void> {
    if (!(await this.isSafeStagingSource(repository, destination, git))) {
      throw new StoreError(
        "conflict",
        "The managed clone no longer matches this repository's source or storage path.",
      );
    }
    const common = await this.runRefreshGit(git, destination, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const commonPath =
      common.exitCode === 0
        ? await realpath(common.stdout.trim()).catch(() => undefined)
        : undefined;
    if (!commonPath || commonPath !== (await realpath(join(destination, ".git")))) {
      throw new StoreError(
        "conflict",
        "The managed clone points to another repository's Git directory.",
      );
    }
  }

  private async fetchSourceSnapshot(
    repository: KnowledgeRepository,
    git: string,
    destination: string,
    sourceRef: string,
  ): Promise<string> {
    await this.assertSafeManagedClone(repository, destination, git);
    const checkedRef = await this.runRefreshGit(git, destination, ["check-ref-format", sourceRef]);
    if (checkedRef.exitCode !== 0) {
      throw new StoreError("invalid", "The recorded source branch is invalid.");
    }
    // Each fetch owns a fresh ref. Publishing metadata selects it; older refs retain
    // the last good commit if a write fails or another assignment is preparing.
    const snapshotRef = `refs/nexestra/source-refresh/${crypto.randomUUID()}`;
    await this.deps.beforeFetch?.();
    const fetched = await this.runRefreshGit(
      git,
      destination,
      [
        "fetch",
        "--atomic",
        "--no-tags",
        "--no-prune",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--no-write-fetch-head",
        "--refmap=",
        "--",
        repository.source,
        `${sourceRef}:${snapshotRef}`,
      ],
      5 * 60_000,
    );
    if (fetched.exitCode !== 0) {
      throw new Error(
        fetched.stderr.trim() || fetched.stdout.trim() || "Git source refresh failed.",
      );
    }
    const head = await this.runRefreshGit(git, destination, [
      "rev-parse",
      "--verify",
      `${snapshotRef}^{commit}`,
    ]);
    const sourceCommit = head.stdout.trim();
    if (head.exitCode !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommit)) {
      throw new Error("The refreshed source did not resolve to a commit.");
    }
    return sourceCommit;
  }

  private runRepositoryGit(
    git: string,
    destination: string,
    args: string[],
    timeoutMs = 10_000,
    maxOutputBytes = 2 * 1024 * 1024,
  ) {
    return runCommand(
      git,
      [
        "-C",
        destination,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "fetch.writeCommitGraph=false",
        "-c",
        "gc.auto=0",
        "-c",
        "protocol.ext.allow=never",
        ...args,
      ],
      {
        cwd: destination,
        timeoutMs,
        maxOutputBytes,
        env: { ...safeProcessEnv(this.env), GIT_TERMINAL_PROMPT: "0" },
      },
    );
  }

  private runRefreshGit(git: string, destination: string, args: string[], timeoutMs = 10_000) {
    return this.runRepositoryGit(git, destination, args, timeoutMs, 2 * 1024 * 1024);
  }

  private async withRepositoryOperationLock<T>(
    repositoryId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.retryLocks.has(repositoryId)) {
      throw new StoreError(
        "conflict",
        "Another repository operation is already running for this item.",
      );
    }
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    this.retryLocks.set(repositoryId, gate);
    try {
      return await operation();
    } finally {
      this.retryLocks.delete(repositoryId);
      release();
    }
  }

  private requireRepository(repositoryId: string): KnowledgeRepository {
    const item = this.store.getKnowledge(repositoryId);
    if (item?.kind !== "repository") {
      throw new StoreError("not_found", "Repository knowledge not found.");
    }
    return item;
  }

  private assertRetryable(repository: KnowledgeRepository): void {
    if (repository.status === "cloning") {
      throw new StoreError("conflict", `#${repository.handle} is already being cloned.`);
    }
    if (repository.status !== "failed") {
      throw new StoreError(
        "conflict",
        `#${repository.handle} is not failed, so retry is not available.`,
      );
    }
  }

  private async cloneAndPublish(
    repository: KnowledgeRepository,
    source: string,
  ): Promise<string | undefined> {
    const destination = this.store.knowledgePath(repository);
    const itemRoot = dirname(destination);
    await mkdir(itemRoot, { recursive: true, mode: 0o700 });
    const staging = join(itemRoot, `source.retrying-${crypto.randomUUID()}`);
    const git = await this.git();
    try {
      await this.deps.beforeClone?.(staging, source);
      const clone = await runCommand(git, ["clone", "--", source, staging], {
        cwd: this.store.workspacePath,
        timeoutMs: 5 * 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
        env: safeProcessEnv(this.env),
      });
      if (clone.exitCode !== 0) {
        throw new Error(clone.stderr.trim() || clone.stdout.trim() || "Git clone failed.");
      }
      await this.publishStagingClone(staging, destination);
      return this.defaultBranchOf(git, destination);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async publishStagingClone(staging: string, destination: string): Promise<void> {
    const state = await inspectRepositoryDestinationKind(destination);
    if (state === "missing" || state === "empty") {
      await this.deps.beforePublish?.(staging, destination);
      try {
        // Atomic publication: rename fills a missing destination or replaces
        // an empty directory. If a file or non-empty directory appears in
        // between, POSIX rename fails with ENOTDIR/ENOTEMPTY/EEXIST and leaves
        // that content untouched.
        await rename(staging, destination);
        return;
      } catch (error) {
        if (isPublicationRaceError(error)) {
          throw new StoreError(
            "conflict",
            this.destinationOccupiedMessage(destination, "files that appeared during the retry"),
          );
        }
        throw error;
      }
    }
    throw new StoreError(
      "conflict",
      this.destinationOccupiedMessage(
        destination,
        state === "git" ? "an existing git clone" : "unknown files",
      ),
    );
  }

  private destinationOccupiedMessage(destination: string, what: string): string {
    const display = relative(this.store.root, destination).replaceAll("\\", "/");
    return (
      "The destination (" +
      display +
      ") is occupied by " +
      what +
      ". Move or remove it, then retry the clone."
    );
  }

  private async defaultBranchOf(git: string, destination: string): Promise<string | undefined> {
    const result = await runCommand(git, ["-C", destination, "symbolic-ref", "--short", "HEAD"], {
      cwd: destination,
      timeoutMs: 10_000,
      env: safeProcessEnv(this.env),
    });
    return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
  }

  private async adoptExistingGitClone(
    repository: KnowledgeRepository,
    destination: string,
    git: string,
  ): Promise<{ defaultBranch?: string } | undefined> {
    if (!(await this.isSafeStagingSource(repository, destination, git))) return undefined;
    const head = await runCommand(git, ["-C", destination, "rev-parse", "--verify", "HEAD"], {
      cwd: destination,
      timeoutMs: 10_000,
      env: safeProcessEnv(this.env),
    });
    if (head.exitCode !== 0) return undefined;
    const branch = await this.defaultBranchOf(git, destination);
    return branch ? { defaultBranch: branch } : {};
  }

  private async isSafeStagingSource(
    repository: KnowledgeRepository,
    destination: string,
    git: string,
  ): Promise<boolean> {
    const gitDir = join(destination, ".git");
    const gitDirEntry = await lstat(gitDir).catch((error) => {
      if (isMissingError(error)) return undefined;
      throw error;
    });
    if (!gitDirEntry?.isDirectory()) return false;
    const canonicalDestination = await realpath(destination).catch(() => undefined);
    if (!canonicalDestination) return false;
    const expectedRoot =
      (await realpath(this.store.root).catch(() => undefined)) ?? resolve(this.store.root);
    const offset = relative(expectedRoot, canonicalDestination);
    if (offset === "" || offset.startsWith("..") || isAbsolute(offset)) return false;
    const canonicalKnowledgePath = await realpath(this.store.knowledgePath(repository)).catch(
      () => undefined,
    );
    if (canonicalKnowledgePath !== canonicalDestination) return false;
    const origin = await runCommand(
      git,
      ["-C", destination, "config", "--get", "remote.origin.url"],
      {
        cwd: destination,
        timeoutMs: 10_000,
        env: safeProcessEnv(this.env),
      },
    );
    if (origin.exitCode !== 0 || origin.stdout.trim() !== repository.source) return false;
    return true;
  }

  assignmentLocation(workspaceId: string, assignmentId: string): AssignmentLocation {
    const branch = `nexestra/${assignmentId}`;
    const absolutePath = resolve(
      this.store.managedWorkspaceDirectory,
      workspaceId,
      "worktrees",
      assignmentId,
    );
    return {
      branch,
      absolutePath,
      worktreePath: relative(this.store.root, absolutePath).replaceAll("\\", "/"),
    };
  }

  async prepareAssignment(
    repository: KnowledgeRepository,
    location: AssignmentLocation,
    signal?: AbortSignal,
  ): Promise<AssignmentPreparation> {
    repository = this.requireRepository(repository.id);
    if (repository.status !== "ready") {
      throw new StoreError("conflict", `#${repository.handle} is not ready.`);
    }
    const repositoryPath = this.store.knowledgePath(repository);
    await mkdir(dirname(location.absolutePath), { recursive: true, mode: 0o700 });
    const git = await this.git();
    const result = await runCommand(
      git,
      [
        "-C",
        repositoryPath,
        "worktree",
        "add",
        "-b",
        location.branch,
        location.absolutePath,
        repository.sourceCommit ?? "HEAD",
      ],
      {
        cwd: repositoryPath,
        timeoutMs: 60_000,
        maxOutputBytes: 1024 * 1024,
        env: safeProcessEnv(this.env),
        signal,
      },
    );
    if (result.exitCode !== 0) {
      throw new StoreError(
        "invalid",
        result.stderr.trim() || result.stdout.trim() || "Could not create the worker worktree.",
      );
    }
    const head = await runCommand(git, ["-C", location.absolutePath, "rev-parse", "HEAD"], {
      cwd: location.absolutePath,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
      env: safeProcessEnv(this.env),
      signal,
    });
    const baseCommit = head.stdout.trim();
    if (head.exitCode !== 0 || !baseCommit) {
      throw new StoreError(
        "invalid",
        head.stderr.trim() || "Could not capture the Worker starting commit.",
      );
    }
    return { baseCommit };
  }

  async cleanupAssignment(
    repository: KnowledgeRepository,
    location: AssignmentLocation,
    signal?: AbortSignal,
  ): Promise<void> {
    if (repository.status !== "ready") {
      throw new StoreError("conflict", `#${repository.handle} is not ready.`);
    }
    const repositoryPath = this.store.knowledgePath(repository);
    const git = await this.git();
    const result = await runCommand(
      git,
      ["-C", repositoryPath, "worktree", "remove", location.absolutePath],
      {
        cwd: repositoryPath,
        timeoutMs: 60_000,
        maxOutputBytes: 1024 * 1024,
        env: safeProcessEnv(this.env),
        signal,
      },
    );
    if (result.exitCode !== 0) {
      throw new StoreError(
        "conflict",
        result.stderr.trim() ||
          result.stdout.trim() ||
          "Could not remove the Worker worktree. Commit or discard its changes first.",
      );
    }
  }

  async deleteAssignmentBranch(
    repository: KnowledgeRepository,
    location: AssignmentLocation,
    signal?: AbortSignal,
  ): Promise<void> {
    if (repository.status !== "ready") {
      throw new StoreError("conflict", `#${repository.handle} is not ready.`);
    }
    const repositoryPath = this.store.knowledgePath(repository);
    const git = await this.git();
    const result = await runCommand(git, ["-C", repositoryPath, "branch", "-d", location.branch], {
      cwd: repositoryPath,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
      env: safeProcessEnv(this.env),
      signal,
    });
    if (result.exitCode !== 0) {
      throw new StoreError(
        "conflict",
        result.stderr.trim() ||
          result.stdout.trim() ||
          "Could not delete the Worker branch because it is not fully merged.",
      );
    }
  }

  private async git(): Promise<string> {
    const git = await findExecutable("git", this.env);
    if (!git) throw new StoreError("invalid", "Git is not installed or is not available in PATH.");
    return git;
  }
}

function normaliseRepositorySource(source: string, workspacePath: string): string {
  if (/^[\w.-]+@[\w.-]+:.+/.test(source)) {
    if (/[?#]/.test(source)) {
      throw new StoreError("invalid", "Repository URLs must not contain credentials.");
    }
    return source;
  }
  try {
    const url = new URL(source);
    if (!["https:", "ssh:"].includes(url.protocol)) {
      throw new StoreError("invalid", "Repository URLs must use HTTPS or SSH.");
    }
    if (url.password || (url.protocol === "https:" && url.username) || url.search || url.hash) {
      throw new StoreError("invalid", "Repository URLs must not contain credentials.");
    }
    return url.toString();
  } catch (error) {
    if (error instanceof StoreError) throw error;
  }
  const localPath = isAbsolute(source) ? resolve(source) : resolve(workspacePath, source);
  return localPath;
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isPublicationRaceError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = error.code;
  return code === "ENOTDIR" || code === "EISDIR" || code === "ENOTEMPTY" || code === "EEXIST";
}
