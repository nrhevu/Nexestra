import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NexestraEvent } from "@nexestra/core";
import type { FakeTurn } from "@nexestra/master";
import { createFakeLlmClient } from "@nexestra/master";
import { createStore, type NexestraStore } from "@nexestra/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  createNotYetAvailableExecutionHost,
  ExecutionNotAvailableError,
} from "./execution-host.js";
import { createServerMasterHost } from "./host.js";
import { MasterRunner } from "./runner.js";

/**
 * The M3 acceptance run, end to end through the real store.
 *
 * The model is scripted (`createFakeLlmClient`) but nothing else is: the phase
 * machine, the tool validation, `ServerMasterHost`, the SQLite writes and the
 * event log are the production ones. What the test proves is the wiring —
 * clarify → spec → approval → plan lands as rows, the approval route resumes a
 * suspended turn, and the `master.*` events reach the log in stream order.
 */

let home: string;
let repository: string;
let store: NexestraStore;
let workspaceId: string;
let threadId: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nexestra-master-"));
  repository = join(home, "repo");
  mkdirSync(join(repository, "src"), { recursive: true });
  writeFileSync(join(repository, "README.md"), "# demo repo\n");
  writeFileSync(join(repository, "src", "index.ts"), "export const todo = [];\n");

  store = createStore({ path: join(home, "nexestra.db"), dataDir: join(home, "data") });
  workspaceId = store.createWorkspace({ name: "demo", rootPath: repository }).id;
  threadId = store.createThread({ workspaceId, title: "Todo CLI" }).id;
});

afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

/* --------------------------------------------------------------- the script */

const QUESTIONS = [
  { id: "q_outcome", text: "What does done look like?", options: ["A working CLI"] },
  { id: "q_scope", text: "Which parts may change?" },
  { id: "q_proof", text: "How do we prove it works?" },
];

const CRITERIA = [
  {
    id: "ac_tests",
    text: "The test suite passes with the new behaviour covered.",
    verification: { kind: "test", command: "pnpm test" },
  },
  {
    id: "ac_build",
    text: "A clean build exits 0.",
    verification: { kind: "command", command: "pnpm build", expectExitCode: 0 },
  },
  {
    id: "ac_docs",
    text: "The CLI is documented in the README.",
    verification: { kind: "manual_review", instructions: "Read the README next to the diff." },
  },
];

const HARNESS_CONFIG = { reasoning: "high", sandbox: "workspace-write", timeoutMs: 900_000 };

const PLAN_TASKS = [
  {
    id: "t1",
    title: "Scaffold the CLI entry point",
    description: "Create the binary and wire it into the package manifest.",
    dependsOn: [],
    acceptanceCriteriaIds: ["ac_build"],
    harness: "codex",
    harnessConfig: HARNESS_CONFIG,
  },
  {
    id: "t2",
    title: "Implement add / list / done",
    description: "Implement the three commands over the existing store.",
    dependsOn: ["t1"],
    acceptanceCriteriaIds: ["ac_build"],
    harness: "codex",
    harnessConfig: HARNESS_CONFIG,
  },
  {
    id: "t3",
    title: "Cover the commands with tests",
    description: "One test per command, failing without the implementation.",
    dependsOn: ["t2"],
    acceptanceCriteriaIds: ["ac_tests"],
    harness: "opencode",
    harnessConfig: HARNESS_CONFIG,
  },
  {
    id: "t4",
    title: "Document the CLI",
    description: "A usage section in the README.",
    dependsOn: ["t2"],
    acceptanceCriteriaIds: ["ac_docs"],
    harness: "opencode",
    harnessConfig: HARNESS_CONFIG,
  },
];

/** Exactly the model calls the run makes, in order. */
function script(): FakeTurn[] {
  return [
    // Turn 1 — intake
    {
      text: "Let me look at the repository first.",
      toolUses: [{ id: "c1", name: "read_workspace", input: { depth: 2 } }],
    },
    {
      text: "Three questions and I can write the spec.",
      toolUses: [{ id: "c2", name: "ask_user", input: { questions: QUESTIONS } }],
    },
    // Turn 2 — clarifying
    {
      text: "Drafting the spec.",
      toolUses: [
        {
          id: "c3",
          name: "update_spec",
          input: {
            patch: {
              goal: "A todo CLI over the existing store",
              scope: { in: ["add/list/done commands"], out: ["A GUI"] },
              constraints: ["Node 24, no new runtime dependency"],
              expectedOutcome: "A working `todo` command",
              acceptanceCriteria: CRITERIA,
            },
          },
        },
      ],
    },
    {
      text: "Approve the spec and I will plan the work.",
      toolUses: [
        {
          id: "c4",
          name: "request_approval",
          input: { kind: "spec", summary: "Freeze the todo CLI spec" },
        },
      ],
    },
    // Turn 3 — spec_frozen, reached by resolving the approval
    {
      text: "Spec frozen.",
      toolUses: [
        {
          id: "c5",
          name: "summarize",
          input: { outcome: "progress", summary: "Spec approved; planning next." },
        },
      ],
    },
    { text: "Ready to plan." },
    // Turn 4 — the auto-continue into planning
    {
      text: "Here is the plan.",
      toolUses: [
        {
          id: "c6",
          name: "propose_plan",
          input: { summary: "Four tasks", tasks: PLAN_TASKS },
        },
      ],
    },
    { text: "The plan is on the board." },
  ];
}

interface Harness {
  app: ReturnType<typeof createApp>;
  runner: MasterRunner;
  events: NexestraEvent[];
}

function harness(turns: FakeTurn[] = script()): Harness {
  const runner = new MasterRunner({
    store,
    llm: createFakeLlmClient(turns),
    runtime: { client: "demo", model: "fake-opus", apiKeyPresent: false },
    execution: createNotYetAvailableExecutionHost(),
  });
  const events: NexestraEvent[] = [];
  store.events.subscribeAll((event) => events.push(event));
  return { app: createApp(store, { master: runner }), runner, events };
}

const post = (app: Harness["app"], path: string, payload?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

/** Run the whole acceptance flow and hand back what it produced. */
async function runToPlan(context: Harness): Promise<void> {
  await post(context.app, `/api/threads/${threadId}/master/send`, {
    kind: "user_message",
    text: "make me a todo cli",
  });
  await context.runner.idle(threadId);

  await post(context.app, `/api/threads/${threadId}/master/send`, {
    kind: "answers",
    answers: [
      { id: "q_outcome", answer: "A working CLI" },
      { id: "q_scope", answer: "src/ only" },
      { id: "q_proof", answer: "The test suite" },
    ],
  });
  await context.runner.idle(threadId);

  const approval = store.listApprovals({ threadId, status: "pending" })[0];
  await post(context.app, `/api/approvals/${approval?.id}/resolve`, { status: "approved" });
  await context.runner.idle(threadId);
}

/* ------------------------------------------------------------------- tests */

describe("the M3 acceptance run", () => {
  it("takes a vague request through clarification, spec, approval and plan", async () => {
    const context = harness();

    await post(context.app, `/api/threads/${threadId}/master/send`, {
      kind: "user_message",
      text: "make me a todo cli",
    });
    await context.runner.idle(threadId);

    // Clarifying: the questions are on the spec and the turn is suspended.
    let state = await context.runner.state(threadId);
    expect(state.phase).toBe("clarifying");
    expect(state.pending?.kind).toBe("ask_user");
    expect(state.lastOutcome).toBe("awaiting_answers");
    expect(store.getSpec(threadId)?.openQuestions).toHaveLength(3);
    expect(store.getThread(threadId)?.phase).toBe("clarifying");

    await post(context.app, `/api/threads/${threadId}/master/send`, {
      kind: "answers",
      answers: [
        { id: "q_outcome", answer: "A working CLI" },
        { id: "q_scope", answer: "src/ only" },
        { id: "q_proof", answer: "The test suite" },
      ],
    });
    await context.runner.idle(threadId);

    // The spec is complete and an approval is waiting on the user.
    const spec = store.getSpec(threadId);
    expect(spec?.goal).toBe("A todo CLI over the existing store");
    expect(spec?.acceptanceCriteria).toHaveLength(3);
    expect(spec?.acceptanceCriteria.map((c) => c.verification.kind)).toEqual([
      "test",
      "command",
      "manual_review",
    ]);
    expect(spec?.openQuestions.every((question) => question.answer)).toBe(true);
    expect(spec?.frozen).toBe(false);

    const [approval] = store.listApprovals({ threadId, status: "pending" });
    expect(approval?.kind).toBe("spec");
    state = await context.runner.state(threadId);
    expect(state.pending).toEqual({
      kind: "request_approval",
      callId: "c4",
      approvalId: approval?.id,
      summary: "Freeze the todo CLI spec",
    });

    // Resolving the approval resumes the suspended turn, which runs on into
    // planning without any further prompting.
    const response = await post(context.app, `/api/approvals/${approval?.id}/resolve`, {
      status: "approved",
    });
    expect(response.status).toBe(200);
    await context.runner.idle(threadId);

    expect(store.getSpec(threadId)?.frozen).toBe(true);
    expect(store.getThread(threadId)?.phase).toBe("planning");

    const plan = store.getPlan(threadId);
    expect(plan?.taskIds).toHaveLength(4);
    expect(plan?.edges).toHaveLength(3);

    const tasks = store.listTasks(threadId);
    expect(tasks.map((task) => task.title)).toEqual(PLAN_TASKS.map((task) => task.title));
    expect(tasks[0]?.dependsOn).toEqual([]);
    expect(tasks[1]?.dependsOn).toEqual([tasks[0]?.id]);
    expect(tasks[2]?.harnessConfig.sandbox).toBe("workspace-write");
    expect(tasks[2]?.assignedHarness).toBe("opencode");
    expect(tasks[3]?.acceptanceCriteriaIds).toEqual(["ac_docs"]);

    // Every plan edge names real task rows.
    const ids = new Set(tasks.map((task) => task.id));
    for (const edge of plan?.edges ?? []) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });

  it("emits the master events of a turn in stream order", async () => {
    const context = harness();
    await post(context.app, `/api/threads/${threadId}/master/send`, {
      kind: "user_message",
      text: "make me a todo cli",
    });
    await context.runner.idle(threadId);

    const master = context.events
      .filter((event) => event.type.startsWith("master."))
      .map((event) => event.type);

    expect(master[0]).toBe("master.started");
    expect(master.at(-1)).toBe("master.done");
    expect(master).toContain("master.text_delta");
    expect(master).toContain("master.tool_call");
    expect(master).toContain("master.tool_result");
    expect(master).toContain("master.question");
    expect(master).toContain("master.usage");

    // A tool call is always narrated before its result.
    expect(master.indexOf("master.tool_call")).toBeLessThan(master.indexOf("master.tool_result"));
    // The question card only appears once the tool that asked it has run.
    expect(master.indexOf("master.tool_call")).toBeLessThan(master.indexOf("master.question"));

    const done = context.events.find((event) => event.type === "master.done");
    expect(done).toBeDefined();
    expect((done?.payload as { outcome: string } | undefined)?.outcome).toBe("awaiting_answers");

    // Everything that is durable also arrived as an ordinary entity event.
    const types = context.events.map((event) => event.type);
    expect(types).toContain("spec.upserted");
    expect(types).toContain("thread.phase_changed");
    expect(types).toContain("message.added");
  });

  it("writes the user's half and the Master's reply into the transcript", async () => {
    const context = harness();
    await runToPlan(context);

    const messages = store.listMessages(threadId);
    const roles = messages.map((message) => message.role);
    expect(roles[0]).toBe("user");
    expect(roles).toContain("master");
    expect(roles).toContain("system");

    const withPlan = messages.find((message) =>
      message.attachments.some((attachment) => attachment.kind === "plan_preview"),
    );
    expect(withPlan).toBeDefined();

    const withTools = messages.find((message) => message.toolCalls.length > 0);
    expect(withTools?.toolCalls[0]?.ok).toBe(true);

    // The answers the user picked are visible in the timeline, not only in the
    // model's private history.
    expect(messages.some((message) => message.content.includes("A working CLI"))).toBe(true);
  });

  it("keeps the model conversation verbatim and resumable", async () => {
    const context = harness();
    await runToPlan(context);

    const conversation = store.listMasterMessages(threadId);
    expect(conversation.length).toBeGreaterThan(4);
    expect(conversation[0]).toEqual({ role: "user", content: "make me a todo cli" });

    // A fresh runner over the same database picks the thread back up.
    context.runner.reset();
    const state = await context.runner.state(threadId);
    expect(state.phase).toBe("planning");
    expect(state.specApproved).toBe(true);
    expect(state.pending).toBeNull();
  });

  it("refuses execution-phase tools with a message the Master can relay", async () => {
    const context = harness();
    await runToPlan(context);

    const host = createServerMasterHost({
      store,
      workspaceId,
      threadId,
      workspacePath: repository,
      execution: createNotYetAvailableExecutionHost(),
    });
    const [task] = store.listTasks(threadId);

    // The model's own task id (`t1`) resolves onto the persisted row before the
    // ExecutionHost ever sees it.
    await expect(host.dispatchTask({ taskId: "t1" })).rejects.toThrow(/not available yet/);
    await expect(host.dispatchTask({ taskId: task?.id ?? "" })).rejects.toThrow(
      ExecutionNotAvailableError,
    );
    await expect(host.dispatchTask({ taskId: "nope" })).rejects.toThrow(/no task `nope`/);
    await expect(host.runVerification({ taskId: "t3" })).rejects.toThrow(/not available yet/);
  });

  it("serialises two sends on the same thread", async () => {
    const context = harness();
    await post(context.app, `/api/threads/${threadId}/master/send`, {
      kind: "user_message",
      text: "make me a todo cli",
    });
    // A second user message while the first turn is in flight is refused
    // rather than interleaved.
    const second = await post(context.app, `/api/threads/${threadId}/master/send`, {
      kind: "user_message",
      text: "actually, make it a web app",
    });
    expect(second.status).toBe(409);
    await context.runner.idle(threadId);
  });
});

describe("master routes", () => {
  it("exposes the runtime at /api/health and /api/settings", async () => {
    const context = harness();
    const health = (await (await context.app.request("/api/health")).json()) as {
      master: { client: string; apiKeyPresent: boolean };
    };
    expect(health.master.client).toBe("demo");
    expect(health.master.apiKeyPresent).toBe(false);

    const settings = (await (await context.app.request("/api/settings")).json()) as {
      concurrency: number;
      master: { model: string };
    };
    expect(settings.master.model).toBe("fake-opus");
    expect(settings.concurrency).toBe(2);
  });

  it("404s the master routes of an unknown thread", async () => {
    const context = harness();
    const response = await context.app.request("/api/threads/nope/master/state");
    expect(response.status).toBe(404);
  });

  it("cancels nothing when no turn is running", async () => {
    const context = harness();
    const response = await post(context.app, `/api/threads/${threadId}/master/cancel`);
    expect(await response.json()).toEqual({ threadId, cancelled: false });
  });
});
