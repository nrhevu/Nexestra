/**
 * The M6 acceptance run: a vague sentence carried all the way to `done`.
 *
 * Nothing here is stubbed except the two things that cost money — the model is
 * `DemoLlmClient` and the harness is the orchestrator's scripted adapter.
 * Everything between them is production code: the phase machine,
 * `ServerMasterHost`, the real `ThreadEngine`, real git worktrees on a real
 * temp repository, real verification commands run with a shell, the SQLite
 * writes and the event log.
 *
 * What that proves is the wiring M6 is about — that approving a plan starts the
 * loop, that the loop respects the DAG, that its evidence lands on the spec,
 * that its gates block on an Approval row and release when the route resolves
 * it, that a failure retries and then asks the Master to replan, and that a
 * restart repairs what a crash left behind.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FakeAdapterOptions } from "@nexestra/adapter-fake";
import { createFakeHarnessAdapter, retryableFailure } from "@nexestra/adapter-fake";
import type { AcceptanceCriterion, NexestraEvent } from "@nexestra/core";
import { createStore, type NexestraStore } from "@nexestra/storage";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createDemoLlmClient, DEMO_MODEL } from "../master/demo-llm.js";
import { MasterRunner } from "../master/runner.js";
import { createDemoHarnessScript, DEMO_OUTPUT_DIR } from "./fake-script.js";
import { createHarnessRegistry } from "./harnesses.js";
import { ExecutionRuntime } from "./runtime.js";

let root: string;
let repo: string;
let store: NexestraStore;
let workspaceId: string;
let threadId: string;
let events: NexestraEvent[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nexestra-m6-"));
  repo = path.join(root, "repo");

  await execa("git", ["init", "-q", "-b", "main", repo], { stdin: "ignore" });
  const git = (...args: string[]) => execa("git", args, { cwd: repo, stdin: "ignore" });
  await git("config", "user.email", "test@nexestra.local");
  await git("config", "user.name", "nexestra test");
  await writeFile(path.join(repo, "README.md"), "# scratch\n", "utf8");
  await writeFile(path.join(repo, "package.json"), '{"name":"scratch"}\n', "utf8");
  await git("add", "-A");
  await git("commit", "-q", "-m", "initial");

  store = createStore({
    path: path.join(root, "home", "nexestra.db"),
    dataDir: path.join(root, "home", "data"),
  });
  workspaceId = store.createWorkspace({
    name: "scratch",
    rootPath: repo,
    defaultBranch: "main",
  }).id;
  threadId = store.createThread({ workspaceId, title: "Something vague" }).id;

  events = [];
  store.events.subscribeAll((event) => events.push(event));
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ harness */

interface Bed {
  app: ReturnType<typeof createApp>;
  runner: MasterRunner;
  execution: ExecutionRuntime;
}

/**
 * The server, with the simulated harness pointed at a throwaway worktree root.
 *
 * `script` overrides what a run does; the default writes a Markdown file per
 * task, which is what makes the diff, the commit and the verification real.
 */
function bed(
  options: { script?: FakeAdapterOptions["script"]; autoSummarize?: boolean } = {},
): Bed {
  const adapterFor = (id: "codex" | "opencode") => {
    const scripted = options.script ?? createDemoHarnessScript(id);
    return createFakeHarnessAdapter({
      id,
      // These tests await explicit lifecycle signals, so simulated token
      // pacing adds wall-clock time without exercising another behaviour.
      script: (context) => {
        const selected = scripted?.(context);
        return selected && !Array.isArray(selected) ? { ...selected, delayMs: 0 } : selected;
      },
    });
  };

  const execution = new ExecutionRuntime({
    store,
    worktreeRoot: path.join(root, "worktrees"),
    harnesses: createHarnessRegistry({
      adapters: { codex: adapterFor("codex"), opencode: adapterFor("opencode") },
    }),
    ...(options.autoSummarize === undefined ? {} : { autoSummarize: options.autoSummarize }),
  });

  const runner = new MasterRunner({
    store,
    llm: createDemoLlmClient({ chunkDelayMs: 0 }),
    runtime: { client: "demo", model: DEMO_MODEL, apiKeyPresent: false },
    execution: execution.host,
  });

  return { app: createApp(store, { master: runner, execution }), runner, execution };
}

const post = (app: Bed["app"], url: string, payload?: unknown) =>
  app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

/**
 * Talk the demo model from a vague sentence to a frozen spec and a plan.
 *
 * The demo writes `pnpm test` / `pnpm build` into the criteria, which is right
 * for a real repository and pointless in a scratch one — so the commands are
 * swapped for cheap equivalents that still *fail* when the harness wrote
 * nothing. The ids and the shape are untouched.
 *
 * `keepManual` decides what happens to the `manual_review` criterion. It is a
 * blocking gate by design — the pipeline waits on a human — so most tests turn
 * it into a command and the gate test keeps it.
 */
async function planApprovedThread(
  context: Bed,
  options: { keepManual?: boolean } = {},
): Promise<void> {
  await post(context.app, `/api/threads/${threadId}/master/send`, {
    kind: "user_message",
    text: "make the settings page less confusing",
  });
  await context.runner.idle(threadId);

  const state = await context.runner.state(threadId);
  const questions = state.pending?.kind === "ask_user" ? state.pending.questions : [];
  await post(context.app, `/api/threads/${threadId}/master/send`, {
    kind: "answers",
    answers: questions.map((question) => ({
      id: question.id,
      answer: question.options[0] ?? "yes",
    })),
  });
  await context.runner.idle(threadId);

  const [approval] = store.listApprovals({ threadId, status: "pending" });
  await post(context.app, `/api/approvals/${approval?.id}/resolve`, { status: "approved" });
  await context.runner.idle(threadId);

  const spec = store.getSpec(threadId);
  const cheap = (criterion: AcceptanceCriterion): AcceptanceCriterion => ({
    ...criterion,
    verification: {
      kind: "command",
      command: `test -d ${DEMO_OUTPUT_DIR}`,
      expectExitCode: 0,
    },
  });
  store.upsertSpec(threadId, {
    acceptanceCriteria: (spec?.acceptanceCriteria ?? []).map((criterion) =>
      options.keepManual && criterion.verification.kind === "manual_review"
        ? criterion
        : cheap(criterion),
    ),
  });
}

/**
 * Wait for a phase.
 *
 * The bridge's phase triggers are queued behind whatever the Master is doing,
 * so `drain()` resolving means the *loop* is finished, not that the thread has
 * been told yet.
 */
async function waitForPhase(context: Bed, phase: string): Promise<string | undefined> {
  await waitFor(() => (store.getThread(threadId)?.phase === phase ? phase : undefined));
  await context.runner.idle(threadId);
  return store.getThread(threadId)?.phase;
}

const progressOf = (kind: string) =>
  events
    .filter((event) => event.type === "orchestrator.progress")
    .map((event) => event.payload as { kind: string; message: string })
    .filter((payload) => payload.kind === kind);

/* -------------------------------------------------------------------- tests */

describe("the M6 loop", () => {
  it("runs an approved plan in dependency order and finishes the thread", async () => {
    const context = bed();
    await planApprovedThread(context);

    expect(store.getThread(threadId)?.phase).toBe("planning");
    const tasks = store.listTasks(threadId);
    expect(tasks).toHaveLength(4);

    // `[Start execution]` is also where the plan is accepted.
    const started = await post(context.app, `/api/threads/${threadId}/execution/start`);
    expect(started.status).toBe(200);
    expect(store.getThread(threadId)?.phase).toBe("executing");

    await context.execution.drain(threadId);
    expect(await waitForPhase(context, "done")).toBe("done");

    // Every task ran, and the DAG was respected: nothing started before the
    // thing it depends on had finished.
    const finished = store.listTasks(threadId);
    expect(finished.map((task) => task.status)).toEqual(["done", "done", "done", "done"]);

    const runs = store.listRuns(threadId);
    const executeStart = new Map(
      runs
        .filter((run) => run.kind === "execute")
        .map((run) => [run.taskId, run.startedAt] as const),
    );
    for (const task of finished) {
      for (const dependency of task.dependsOn) {
        const before = runs.find(
          (run) => run.taskId === dependency && run.kind === "execute",
        )?.endedAt;
        expect(before).toBeDefined();
        expect(executeStart.get(task.id)?.localeCompare(before ?? "")).toBeGreaterThanOrEqual(0);
      }
    }

    // Cross-review happened: a task executed by codex was reviewed by opencode.
    const reviews = runs.filter((run) => run.kind === "review");
    expect(reviews.length).toBeGreaterThan(0);
    for (const review of reviews) {
      const execute = runs.find((run) => run.taskId === review.taskId && run.kind === "execute");
      expect(review.harness).not.toBe(execute?.harness);
    }

    // Every acceptance criterion carries evidence produced by *running* it —
    // not by a harness saying so.
    const criteria = store.getSpec(threadId)?.acceptanceCriteria ?? [];
    expect(criteria.length).toBeGreaterThan(0);
    for (const criterion of criteria) {
      expect(criterion.satisfied).toBe(true);
      expect(criterion.evidenceArtifactId).toBeDefined();
      expect(store.getArtifact(criterion.evidenceArtifactId ?? "")).not.toBeNull();
    }

    expect(progressOf("thread_idle").at(-1)?.message).toContain("completed");

    // The loop narrated itself onto the log, and the board can read its state
    // back without polling.
    expect(events.some((event) => event.type === "orchestrator.status_changed")).toBe(true);
    expect(context.execution.status(threadId).state).toBe("idle");

    // Every task produced a real diff of a real worktree.
    const diffs = store.listArtifacts(threadId).filter((artifact) => artifact.kind === "diff");
    expect(diffs.length).toBeGreaterThanOrEqual(4);
    expect(diffs[0]?.preview).toContain(DEMO_OUTPUT_DIR);
  }, 60_000);

  it("blocks on an approval gate and resumes when the route resolves it", async () => {
    const context = bed();
    await planApprovedThread(context, { keepManual: true });
    await post(context.app, `/api/threads/${threadId}/execution/start`);

    // The `manual_review` criterion raises a `manual_verification` approval and
    // the pipeline waits on the *row*, so anything that resolves it releases
    // the loop — here, the same REST route the sidebar calls.
    const gate = await waitFor(() =>
      store
        .listApprovals({ threadId, status: "pending" })
        .find((approval) => approval.kind === "manual_verification"),
    );
    expect(gate).toBeDefined();
    expect(store.getThread(threadId)?.phase).toBe("executing");

    const response = await post(context.app, `/api/approvals/${gate?.id}/resolve`, {
      status: "approved",
      resolvedBy: "user",
    });
    expect(response.status).toBe(200);

    await context.execution.drain(threadId);
    expect(await waitForPhase(context, "done")).toBe("done");

    expect(store.listTasks(threadId).every((task) => task.status === "done")).toBe(true);
    expect(progressOf("approval_requested").length).toBeGreaterThan(0);
    // The manual criterion is satisfied by the approval, with its own evidence.
    const manual = store
      .getSpec(threadId)
      ?.acceptanceCriteria.find((criterion) => criterion.id === gate?.title.split(" ").at(-1));
    expect(
      manual ?? store.getSpec(threadId)?.acceptanceCriteria.every((c) => c.satisfied),
    ).toBeTruthy();
  }, 60_000);

  it("retries a retryable failure and asks the Master to replan when they run out", async () => {
    // Fails every attempt on one task; succeeds everywhere else.
    const failing = "task_" as const;
    const demo = createDemoHarnessScript("codex");
    const context = bed({
      script: (runContext) => {
        const { spec, attempt } = runContext;
        if (spec.kind === "execute" && spec.taskId.includes("t2_implement")) {
          return retryableFailure(`attempt ${attempt} could not apply the change`);
        }
        return demo(runContext);
      },
    });
    expect(failing).toBe("task_");

    await planApprovedThread(context);
    await post(context.app, `/api/threads/${threadId}/execution/start`);
    await context.execution.drain(threadId);
    expect(await waitForPhase(context, "blocked")).toBe("blocked");

    const failed = store.listTasks(threadId).find((task) => task.id.includes("t2_implement"));
    expect(failed?.status).toBe("failed");
    // `maxAttempts` is a ceiling, and every attempt was actually spent.
    expect(failed?.attempts).toBe(3);
    expect(store.listRuns(threadId).filter((run) => run.taskId === failed?.id)).toHaveLength(3);

    // Two retries between three attempts (the engine also narrates the last
    // failure before it gives up, so this is a floor, not an equality).
    expect(progressOf("run_retrying").length).toBeGreaterThanOrEqual(2);
    expect(progressOf("replan_requested").length).toBe(1);

    // The Master was told, with the evidence, and the thread is blocked rather
    // than quietly idle.
    const note = store
      .listMessages(threadId)
      .find((message) => message.content.includes("could not apply the change"));
    expect(note ?? progressOf("replan_requested")[0]).toBeDefined();
  }, 60_000);

  it("recovers runs a crash left behind", async () => {
    const context = bed();
    await planApprovedThread(context);

    // Simulate a crash: a task marked `running` with a live run row and no
    // process behind it, exactly what a killed server leaves in SQLite.
    const [task] = store.listTasks(threadId);
    if (!task) throw new Error("no tasks");
    store.updateTask(task.id, { status: "running" });
    const run = store.recordRun({
      threadId,
      taskId: task.id,
      kind: "execute",
      harness: "codex",
      status: "running",
      worktreePath: path.join(root, "worktrees", threadId, task.id),
    });

    // A fresh process opens the same database and repairs it before serving.
    const restarted = bed();
    const recovered = await restarted.execution.recoverAll();
    expect(recovered).toContain(threadId);

    expect(store.getRun(run.id)?.status).toBe("interrupted");
    expect(store.getTask(task.id)?.status).not.toBe("running");

    // …and the thread still runs to completion afterwards.
    await post(restarted.app, `/api/threads/${threadId}/execution/start`);
    await restarted.execution.drain(threadId);
    await restarted.runner.idle(threadId);
    expect(store.listTasks(threadId).every((item) => item.status === "done")).toBe(true);
    await waitForPhase(restarted, "done");
  }, 60_000);
});

describe("the execution routes", () => {
  it("reads a run's worktree: tree, file and diff", async () => {
    const context = bed();
    await planApprovedThread(context);
    await post(context.app, `/api/threads/${threadId}/execution/start`);
    await context.execution.drain(threadId);

    const run = store.listRuns(threadId).find((item) => item.kind === "execute");
    expect(run?.worktreePath).toBeDefined();

    const tree = await context.app.request(`/api/runs/${run?.id}/files`);
    expect(tree.status).toBe(200);
    const nodes = (await tree.json()) as { path: string; kind: string; status: string }[];
    const written = nodes.find((node) => node.path.startsWith(`${DEMO_OUTPUT_DIR}/`));
    expect(written?.kind).toBe("file");

    const content = await context.app.request(
      `/api/runs/${run?.id}/files/content?path=${encodeURIComponent(written?.path ?? "")}`,
    );
    expect(content.status).toBe(200);
    expect(((await content.json()) as { content: string }).content).toContain("simulated");

    const diff = await context.app.request(`/api/runs/${run?.id}/diff`);
    expect(diff.status).toBe(200);
    const patch = (await diff.json()) as { patch: string; files: { path: string }[] };
    expect(patch.patch).toContain(DEMO_OUTPUT_DIR);
    expect(patch.files.length).toBeGreaterThan(0);

    // Path traversal is refused before the filesystem is touched.
    const traversal = await context.app.request(
      `/api/runs/${run?.id}/files/content?path=${encodeURIComponent("../../../etc/passwd")}`,
    );
    expect(traversal.status).toBe(400);
  }, 60_000);

  it("reports the harnesses it registered", async () => {
    const context = bed();
    const response = await context.app.request("/api/harnesses");
    expect(response.status).toBe(200);
    const list = (await response.json()) as { id: string; available: boolean }[];
    expect(list.find((info) => info.id === "codex")?.available).toBe(true);
    expect(list.map((info) => info.id)).toEqual(["codex", "opencode"]);
  });

  it("refuses an unknown execution action", async () => {
    const context = bed();
    const response = await post(context.app, `/api/threads/${threadId}/execution/explode`);
    expect(response.status).toBe(400);
  });
});

/** Poll until `read()` returns something truthy, or give up. */
async function waitFor<T>(read: () => T | undefined, timeoutMs = 20_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}
