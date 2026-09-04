import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { CreateKnowledgeRepositorySchema, type KnowledgeRepository } from "../shared/contracts.js";
import { findExecutable, runCommand, safeProcessEnv } from "./process.js";
import { type FileStore, StoreError } from "./store.js";

export interface AssignmentLocation {
  branch: string;
  worktreePath: string;
  absolutePath: string;
}

export interface AssignmentRepositoryManager {
  assignmentLocation(workspaceId: string, assignmentId: string): AssignmentLocation;
  prepareAssignment(
    repository: KnowledgeRepository,
    location: AssignmentLocation,
    signal?: AbortSignal,
  ): Promise<void>;
}

export class RepositoryManager implements AssignmentRepositoryManager {
  constructor(
    private readonly store: FileStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async addRepository(rawInput: unknown): Promise<KnowledgeRepository> {
    const input = CreateKnowledgeRepositorySchema.parse(rawInput);
    const source = normaliseRepositorySource(input.source, this.store.workspacePath);
    const repository = await this.store.createKnowledgeRepository({ ...input, source });
    const destination = this.store.knowledgePath(repository);
    try {
      const git = await this.git();
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const clone = await runCommand(git, ["clone", "--", source, destination], {
        cwd: this.store.workspacePath,
        timeoutMs: 5 * 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
        env: safeProcessEnv(this.env),
      });
      if (clone.exitCode !== 0) {
        throw new Error(clone.stderr.trim() || clone.stdout.trim() || "Git clone failed.");
      }
      const branchResult = await runCommand(
        git,
        ["-C", destination, "symbolic-ref", "--short", "HEAD"],
        {
          cwd: destination,
          timeoutMs: 10_000,
          env: safeProcessEnv(this.env),
        },
      );
      return this.store.updateKnowledgeRepository(repository.id, {
        status: "ready",
        ...(branchResult.exitCode === 0 && branchResult.stdout.trim()
          ? { defaultBranch: branchResult.stdout.trim() }
          : {}),
      });
    } catch (error) {
      const message = this.store
        .redactSecrets(error instanceof Error ? error.message : "Repository clone failed.")
        .slice(0, 2_000);
      return this.store.updateKnowledgeRepository(repository.id, {
        status: "failed",
        error: message,
      });
    }
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
  ): Promise<void> {
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
        "HEAD",
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
