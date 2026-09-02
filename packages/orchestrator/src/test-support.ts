/**
 * Test-only scaffolding: a throwaway git repo, a throwaway store, and a thread
 * with a spec and tasks in it.
 *
 * Kept out of `index.ts` so nothing in the runtime surface depends on it.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AcceptanceCriterion, HarnessId, Spec, Task, Thread, Workspace } from "@nexestra/core";
import { createStore, type NexestraStore } from "@nexestra/storage";
import { execa } from "execa";

export interface TestBed {
  root: string;
  repo: string;
  home: string;
  worktreeRoot: string;
  store: NexestraStore;
  workspace: Workspace;
  thread: Thread;
  spec: Spec;
  addTask(input: {
    id?: string;
    title: string;
    description?: string;
    dependsOn?: string[];
    harness?: HarnessId;
    criteria?: string[];
    maxAttempts?: number;
    sandbox?: Task["harnessConfig"]["sandbox"];
    mcpServers?: Task["harnessConfig"]["mcpServers"];
  }): Task;
  setCriteria(criteria: AcceptanceCriterion[]): Spec;
  git(...args: string[]): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createTestBed(
  options: { criteria?: AcceptanceCriterion[]; budgetUSD?: number } = {},
): Promise<TestBed> {
  const root = await mkdtemp(path.join(tmpdir(), "nexestra-orch-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  const worktreeRoot = path.join(root, "worktrees");

  const git = async (...args: string[]): Promise<string> => {
    const result = await execa("git", args, { cwd: repo, stdin: "ignore" });
    return typeof result.stdout === "string" ? result.stdout : "";
  };

  await execa("git", ["init", "-q", "-b", "main", repo], { stdin: "ignore" });
  await git("config", "user.email", "test@nexestra.local");
  await git("config", "user.name", "nexestra test");
  await writeFile(path.join(repo, "README.md"), "# scratch\n", "utf8");
  await git("add", "-A");
  await git("commit", "-q", "-m", "initial");

  const store = createStore({
    path: path.join(home, "nexestra.db"),
    dataDir: path.join(home, "data"),
  });
  const workspace = store.createWorkspace({ name: "demo", rootPath: repo, defaultBranch: "main" });
  const thread = store.createThread({
    workspaceId: workspace.id,
    title: "M5 thread",
    phase: "executing",
    ...(options.budgetUSD !== undefined ? { budgetUSD: options.budgetUSD } : {}),
  });
  const spec = store.upsertSpec(thread.id, {
    goal: "Make the acceptance criteria pass",
    constraints: ["Do not touch unrelated files"],
    acceptanceCriteria: options.criteria ?? [],
    frozen: true,
  });

  return {
    root,
    repo,
    home,
    worktreeRoot,
    store,
    workspace,
    thread,
    spec,
    git,
    addTask(input) {
      return store.createTask({
        threadId: thread.id,
        ...(input.id ? { id: input.id } : {}),
        title: input.title,
        description: input.description ?? input.title,
        dependsOn: input.dependsOn ?? [],
        assignedHarness: input.harness ?? "codex",
        acceptanceCriteriaIds: input.criteria ?? [],
        ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
        harnessConfig: {
          ...(input.sandbox ? { sandbox: input.sandbox } : {}),
          ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
          timeoutMs: 60_000,
        },
        status: "todo",
      });
    },
    setCriteria(criteria) {
      return store.upsertSpec(thread.id, { acceptanceCriteria: criteria });
    },
    async cleanup() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A `command` criterion that shells out inside the worktree. */
export function commandCriterion(id: string, command: string, text = id): AcceptanceCriterion {
  return {
    id,
    text,
    verification: { kind: "command", command, expectExitCode: 0 },
    satisfied: false,
  };
}

/** A `test` criterion. */
export function testCriterion(id: string, command: string, text = id): AcceptanceCriterion {
  return { id, text, verification: { kind: "test", command }, satisfied: false };
}

/** A `manual_review` criterion, which raises a `manual_verification` approval. */
export function manualCriterion(id: string, instructions: string): AcceptanceCriterion {
  return {
    id,
    text: instructions,
    verification: { kind: "manual_review", instructions },
    satisfied: false,
  };
}

/** Poll until `predicate` is true, or fail after `timeoutMs`. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
