import { SpecSchema } from "@nexestra/core";
import { describe, expect, it } from "vitest";
import type { MasterEvent } from "./events.js";
import { createFakeHost } from "./fake-host.js";
import { createFakeLlmClient, type FakeTurn } from "./llm/fake.js";
import { createMasterSession, type MasterSessionConfig } from "./session.js";
import { applySpecPatch, createEmptySpec } from "./spec.js";
import { createInMemoryMasterStore } from "./store.js";
import { ZERO_USAGE } from "./usage.js";

const NOW = "2026-09-02T09:00:00.000Z";

async function collect(events: AsyncIterable<MasterEvent>): Promise<MasterEvent[]> {
  const out: MasterEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function of<T extends MasterEvent["type"]>(
  events: readonly MasterEvent[],
  type: T,
): Extract<MasterEvent, { type: T }>[] {
  return events.filter((event): event is Extract<MasterEvent, { type: T }> => event.type === type);
}

function session(script: readonly FakeTurn[], overrides: Partial<MasterSessionConfig> = {}) {
  const host = (overrides.host ?? createFakeHost({ files: FILES })) as ReturnType<
    typeof createFakeHost
  >;
  const llm = createFakeLlmClient(script, { model: "claude-opus-5" });
  const store = overrides.store ?? createInMemoryMasterStore();
  return {
    host,
    llm,
    store,
    session: createMasterSession({
      threadId: "th_1",
      workspaceId: "ws_1",
      now: () => NOW,
      ...overrides,
      host,
      llm,
      store,
    }),
  };
}

const FILES = {
  "README.md": "# demo\n\nA TypeScript monorepo.\n",
  "package.json": '{"name":"demo","scripts":{"test":"vitest run"}}',
  "src/index.ts": "export const hello = () => 'hi';\n",
};

/* -------------------------------------------------------------------------- */
/* The M2 acceptance run: vague request → questions → spec → approval → plan   */
/* -------------------------------------------------------------------------- */

const CRITERIA = [
  {
    id: "ac_add",
    text: '`todo add "buy milk"` appends the item and exits 0',
    verification: { kind: "test" as const, command: "pnpm test", testPath: "src/add.test.ts" },
  },
  {
    id: "ac_list",
    text: "`todo list` prints stored items one per line",
    verification: { kind: "command" as const, command: "node dist/cli.js list", expectExitCode: 0 },
  },
  {
    id: "ac_persist",
    text: "Items survive a process restart via a JSON file in the home directory",
    verification: { kind: "test" as const, command: "pnpm test" },
  },
];

const PLAN_TASKS = [
  {
    id: "t_store",
    title: "JSON-backed todo store",
    description: "Implement load/save of the todo list in a JSON file.",
    dependsOn: [] as string[],
    acceptanceCriteriaIds: ["ac_persist"],
    harness: "codex" as const,
    harnessConfig: { reasoning: "high" as const, sandbox: "workspace-write" as const },
  },
  {
    id: "t_cli",
    title: "add and list commands",
    description: "Wire the CLI commands on top of the store, with tests.",
    dependsOn: ["t_store"],
    acceptanceCriteriaIds: ["ac_add", "ac_list"],
    harness: "opencode" as const,
    harnessConfig: {
      model: "claude-sonnet-5",
      reasoning: "medium" as const,
      sandbox: "workspace-write" as const,
      timeoutMs: 600_000,
    },
  },
];

describe("a full scripted run from a vague request to a validated plan", () => {
  it("asks at most six questions, freezes a spec with three verifiable criteria, then plans", async () => {
    const host = createFakeHost({ files: FILES });
    const { session: master, llm } = session(
      [
        // 1: look at the repo before asking anything.
        {
          thinking: "Check what the workspace already answers.",
          toolUses: [{ id: "c1", name: "read_workspace", input: { includeManifests: true } }],
          usage: { input_tokens: 4_000, output_tokens: 300 },
        },
        // 2: draft what is already known, then ask the rest in one batch.
        {
          text: "Nothing in the repo covers a todo CLI yet, so four questions.",
          toolUses: [
            {
              id: "c2",
              name: "update_spec",
              input: {
                patch: {
                  goal: "A local todo CLI for this repo",
                  scope: { in: ["add", "list"], out: ["sync", "auth"] },
                  constraints: ["TypeScript", "no runtime dependencies"],
                },
                note: "initial draft from the repo",
              },
            },
            {
              id: "c3",
              name: "ask_user",
              input: {
                questions: [
                  {
                    id: "q_store",
                    text: "Where should items live?",
                    options: ["JSON file", "SQLite"],
                  },
                  {
                    id: "q_scope",
                    text: "Do you need `done` and `remove` too?",
                    options: ["yes", "no"],
                  },
                  { id: "q_name", text: "What should the binary be called?" },
                  { id: "q_node", text: "Minimum Node version?", options: ["22", "24"] },
                ],
              },
            },
          ],
          usage: { input_tokens: 5_000, output_tokens: 800 },
        },
        // 3: fold the answers into the spec and ask for approval.
        {
          toolUses: [
            {
              id: "c4",
              name: "update_spec",
              input: {
                patch: {
                  expectedOutcome: "`todo` binary with add/list backed by a JSON file",
                  acceptanceCriteria: CRITERIA,
                  decisions: [
                    { id: "d_store", text: "Store items in JSON", rationale: "no dependencies" },
                  ],
                },
              },
            },
            {
              id: "c5",
              name: "request_approval",
              input: {
                kind: "spec",
                summary: "Todo CLI with add/list, JSON storage, three verifiable criteria.",
              },
            },
          ],
          usage: { input_tokens: 6_000, output_tokens: 900 },
        },
        // 4: post-approval wrap-up in `spec_frozen`.
        {
          text: "Frozen. Recording the storage decision before planning.",
          toolUses: [
            {
              id: "c6",
              name: "record_memory",
              input: {
                type: "decision",
                title: "JSON storage for the todo CLI",
                content: "Chosen over SQLite to keep the dependency list empty.",
              },
            },
          ],
        },
        { text: "Ready to plan." },
        // 5: the plan itself.
        {
          toolUses: [
            {
              id: "c7",
              name: "propose_plan",
              input: { summary: "Store first, then the CLI on top of it.", tasks: PLAN_TASKS },
            },
          ],
          usage: { input_tokens: 7_000, output_tokens: 1_200 },
        },
        { text: "Two tasks, one dependency edge." },
      ],
      { host },
    );

    /* --- turn 1: the vague request ------------------------------------- */
    const first = await collect(master.send("make me a todo cli"));
    expect(of(first, "question")).toHaveLength(1);
    expect(of(first, "question")[0]?.questions).toHaveLength(4);
    expect(of(first, "done")[0]?.outcome).toBe("awaiting_answers");
    expect(of(first, "phase_changed")[0]).toMatchObject({ from: "intake", to: "clarifying" });
    // The workspace was read before the user was asked anything.
    expect(host.callsTo("readWorkspace")).toHaveLength(1);

    let state = await master.state();
    expect(state.phase).toBe("clarifying");
    expect(state.questionsAsked).toBe(4);
    expect(state.pending?.kind).toBe("ask_user");

    /* --- turn 2: the answers -------------------------------------------- */
    const second = await collect(
      master.send({
        kind: "answers",
        answers: [
          { id: "q_store", answer: "JSON file" },
          { id: "q_scope", answer: "no, add and list only" },
          { id: "q_name", answer: "todo" },
          { id: "q_node", answer: "24" },
        ],
      }),
    );
    expect(of(second, "approval_requested")).toHaveLength(1);
    expect(of(second, "done")[0]?.outcome).toBe("awaiting_approval");

    state = await master.state();
    expect(state.spec?.acceptanceCriteria).toHaveLength(3);
    for (const criterion of state.spec?.acceptanceCriteria ?? []) {
      expect(["command", "test"]).toContain(criterion.verification.kind);
    }
    expect(state.spec?.openQuestions.every((question) => question.answer)).toBe(true);
    expect(state.phase).toBe("clarifying");

    /* --- turn 3: approval freezes the spec ------------------------------ */
    const third = await collect(master.send({ kind: "approval", decision: "approved" }));
    expect(of(third, "phase_changed")[0]).toMatchObject({
      from: "clarifying",
      to: "spec_frozen",
    });
    expect(of(third, "done")[0]?.outcome).toBe("end_turn");

    state = await master.state();
    expect(state.phase).toBe("spec_frozen");
    expect(state.specApproved).toBe(true);
    expect(state.spec?.frozen).toBe(true);
    expect(SpecSchema.safeParse(state.spec).success).toBe(true);
    expect(host.memories).toHaveLength(1);

    /* --- turn 4: planning ----------------------------------------------- */
    const fourth = await collect(master.send({ kind: "continue" }));
    expect(of(fourth, "phase_changed")[0]).toMatchObject({ from: "spec_frozen", to: "planning" });
    const proposed = of(fourth, "plan_proposed")[0]?.plan;
    expect(proposed?.tasks).toHaveLength(2);
    expect(proposed?.edges).toEqual([{ from: "t_store", to: "t_cli" }]);
    for (const task of proposed?.tasks ?? []) {
      expect(task.acceptanceCriteriaIds.length).toBeGreaterThanOrEqual(1);
      expect(task.harnessConfig.reasoning).toBeTruthy();
      expect(task.harnessConfig.sandbox).toBeTruthy();
      expect(task.harnessConfig.timeoutMs).toBeGreaterThan(0);
    }
    expect(host.plans).toHaveLength(1);

    /* --- the whole script was consumed, nothing improvised -------------- */
    expect(llm.remaining).toBe(0);

    // Planning ran at high effort; the conversational turns did not.
    const efforts = llm.requests.map((request) => request.effort);
    expect(efforts.at(-2)).toBe("high");
    expect(efforts[0]).toBe("medium");

    /* --- the orchestrator can now accept the plan ----------------------- */
    const accepted = await master.applyTrigger({ type: "plan_accepted" });
    expect(accepted).toMatchObject({ ok: true, to: "executing" });
    expect((await master.state()).phase).toBe("executing");
  });
});

/* -------------------------------------------------------------------------- */
/* Phase gating                                                               */
/* -------------------------------------------------------------------------- */

describe("phase gating", () => {
  it("refuses propose_plan outside the planning phase", async () => {
    const { session: master } = session([
      {
        toolUses: [
          {
            id: "c1",
            name: "propose_plan",
            input: { summary: "too early", tasks: PLAN_TASKS },
          },
        ],
      },
      { text: "Understood — I will finish the spec first." },
    ]);

    const events = await collect(master.send("plan it now"));
    const result = of(events, "tool_result")[0];
    expect(result?.ok).toBe(false);
    expect(JSON.stringify(result?.output)).toMatch(/not available in phase `intake`/);
    expect(of(events, "plan_proposed")).toHaveLength(0);
  });

  it("refuses propose_plan while open questions remain, even in the planning phase", async () => {
    const store = createInMemoryMasterStore();
    const spec = applySpecPatch(
      createEmptySpec({ specId: "spec_th_1", threadId: "th_1", workspaceId: "ws_1" }, NOW),
      {
        goal: "todo cli",
        acceptanceCriteria: CRITERIA,
        openQuestions: [{ id: "q_open", question: "Which storage?" }],
      },
      NOW,
    );
    await store.saveState({
      threadId: "th_1",
      phase: "planning",
      spec,
      plan: null,
      specApproved: true,
      planAccepted: false,
      questionsAsked: 1,
      usage: ZERO_USAGE,
      budgetUSD: 20,
      budgetWarned: false,
      pending: null,
    });

    const { session: master } = session(
      [
        {
          toolUses: [
            { id: "c1", name: "propose_plan", input: { summary: "s", tasks: PLAN_TASKS } },
          ],
        },
        { text: "I will resolve the open question first." },
      ],
      { store },
    );

    const events = await collect(master.send({ kind: "continue" }));
    const result = of(events, "tool_result")[0];
    expect(result?.ok).toBe(false);
    expect(JSON.stringify(result?.output)).toMatch(/open question/);
    expect(of(events, "plan_proposed")).toHaveLength(0);
    // The model got the error back and was able to keep talking.
    expect(of(events, "done")[0]?.outcome).toBe("end_turn");
  });

  it("refuses a spec approval while questions are unanswered", async () => {
    const { session: master } = session([
      {
        toolUses: [
          {
            id: "c1",
            name: "ask_user",
            input: { questions: [{ id: "q1", text: "Which storage?" }] },
          },
        ],
      },
      {
        toolUses: [
          {
            id: "c2",
            name: "request_approval",
            input: { kind: "spec", summary: "approve please" },
          },
        ],
      },
      { text: "I still need the storage answer." },
    ]);

    await collect(master.send("build it"));
    const events = await collect(
      master.send({ kind: "answers", answers: [{ id: "q1", answer: "" }] }),
    );
    const result = of(events, "tool_result").at(-1);
    expect(result?.ok).toBe(false);
    expect(JSON.stringify(result?.output)).toMatch(/unanswered/);
  });

  it("rejects a plan whose DAG has a cycle", async () => {
    const store = createInMemoryMasterStore();
    const spec = applySpecPatch(
      createEmptySpec({ specId: "spec_th_1", threadId: "th_1", workspaceId: "ws_1" }, NOW),
      { goal: "g", acceptanceCriteria: CRITERIA },
      NOW,
    );
    await store.saveState({
      threadId: "th_1",
      phase: "planning",
      spec: { ...spec, frozen: true },
      plan: null,
      specApproved: true,
      planAccepted: false,
      questionsAsked: 0,
      usage: ZERO_USAGE,
      budgetUSD: 20,
      budgetWarned: false,
      pending: null,
    });

    const cyclic = [
      { ...PLAN_TASKS[0]!, dependsOn: ["t_cli"] },
      { ...PLAN_TASKS[1]!, dependsOn: ["t_store"] },
    ];
    const { session: master } = session(
      [
        { toolUses: [{ id: "c1", name: "propose_plan", input: { summary: "s", tasks: cyclic } }] },
        { text: "Fixing the cycle." },
      ],
      { store },
    );

    const events = await collect(master.send({ kind: "continue" }));
    const output = JSON.stringify(of(events, "tool_result")[0]?.output);
    expect(output).toMatch(/cycle/);
    expect(of(events, "plan_proposed")).toHaveLength(0);
  });

  it("stops asking once the question budget is spent", async () => {
    const questions = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, text: `q${index}` }));

    const { session: master } = session([
      { toolUses: [{ id: "c1", name: "ask_user", input: { questions: questions("a", 6) } }] },
      { toolUses: [{ id: "c2", name: "ask_user", input: { questions: questions("b", 2) } }] },
      { text: "I will proceed on assumptions instead." },
    ]);

    await collect(master.send("go"));
    const events = await collect(
      master.send({
        kind: "answers",
        answers: questions("a", 6).map((question) => ({ id: question.id, answer: "yes" })),
      }),
    );
    const result = of(events, "tool_result")[0];
    expect(result?.ok).toBe(false);
    expect(JSON.stringify(result?.output)).toMatch(/already asked 6 of 6 questions/);
    expect(of(events, "question")).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Tool input validation and error handling                                    */
/* -------------------------------------------------------------------------- */

describe("tool validation inside the loop", () => {
  it("hands a schema violation back as a recoverable tool error", async () => {
    const { session: master, host } = session([
      {
        toolUses: [
          {
            id: "c1",
            name: "update_spec",
            // `verification` is missing — the schema must catch it.
            input: { patch: { acceptanceCriteria: [{ id: "ac1", text: "it works" }] } },
          },
        ],
      },
      { text: "Retrying with a verification attached." },
    ]);

    const events = await collect(master.send("go"));
    const result = of(events, "tool_result")[0];
    expect(result?.ok).toBe(false);
    expect(JSON.stringify(result?.output)).toMatch(/schema validation/);
    expect(of(events, "spec_updated")).toHaveLength(0);
    expect(host.calls.filter((call) => call.name === "onSpecUpdated")).toHaveLength(0);
    expect(of(events, "done")[0]?.outcome).toBe("end_turn");
  });

  it("turns a host failure into a tool error rather than aborting the turn", async () => {
    const host = createFakeHost({ files: FILES });
    const { session: master } = session(
      [
        { toolUses: [{ id: "c1", name: "read_workspace", input: { path: "../escape" } }] },
        { text: "Staying inside the workspace." },
      ],
      {
        host: {
          ...host,
          async readWorkspace() {
            throw new Error("path `../escape` escapes the workspace root");
          },
        },
      },
    );

    const events = await collect(master.send("look around"));
    expect(of(events, "tool_result")[0]?.ok).toBe(false);
    expect(JSON.stringify(of(events, "tool_result")[0]?.output)).toMatch(/escapes the workspace/);
    expect(of(events, "done")[0]?.outcome).toBe("end_turn");
  });

  it("will not pass an acceptance criterion without evidence", async () => {
    const store = createInMemoryMasterStore();
    const spec = applySpecPatch(
      createEmptySpec({ specId: "spec_th_1", threadId: "th_1", workspaceId: "ws_1" }, NOW),
      { goal: "g", acceptanceCriteria: CRITERIA },
      NOW,
    );
    await store.saveState({
      threadId: "th_1",
      phase: "verifying",
      spec: { ...spec, frozen: true },
      plan: null,
      specApproved: true,
      planAccepted: true,
      questionsAsked: 0,
      usage: ZERO_USAGE,
      budgetUSD: 20,
      budgetWarned: false,
      pending: null,
    });

    const { session: master } = session(
      [
        {
          toolUses: [
            { id: "c1", name: "mark_criterion", input: { criterionId: "ac_add", passed: true } },
          ],
        },
        {
          toolUses: [
            {
              id: "c2",
              name: "run_verification",
              input: { taskId: "t_cli", criterionIds: CRITERIA.map((c) => c.id) },
            },
          ],
        },
        { text: "Verified with evidence." },
      ],
      { store },
    );

    const events = await collect(master.send({ kind: "continue" }));
    const rejected = of(events, "tool_result")[0];
    expect(rejected?.ok).toBe(false);
    expect(JSON.stringify(rejected?.output)).toMatch(/evidenceArtifactId/);

    // The verification run *does* attach evidence, which is what unlocks `done`.
    const verified = of(events, "spec_updated").at(-1)?.spec;
    expect(verified?.acceptanceCriteria.every((c) => c.evidenceArtifactId)).toBe(true);
    expect(await master.applyTrigger({ type: "all_criteria_verified" })).toMatchObject({
      ok: true,
      to: "done",
    });
  });
});

describe("model-level failures", () => {
  it("surfaces a refusal and stops the turn", async () => {
    const { session: master, store } = session([
      {
        stopReason: "refusal",
        stopDetails: {
          type: "refusal",
          category: "cyber",
          explanation: "declined for policy reasons",
          fallback_credit_token: null,
          fallback_has_prefill_claim: null,
          recommended_model: null,
        },
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    ]);

    const events = await collect(master.send("do something questionable"));
    const error = of(events, "error")[0]?.error;
    expect(error?.code).toBe("refusal");
    expect(error?.category).toBe("cyber");
    expect(error?.retryable).toBe(false);
    expect(of(events, "done")[0]?.outcome).toBe("error");
    // A refused turn is not written into the history.
    const history = await store.loadMessages("th_1");
    expect(history.filter((message) => message.role === "assistant")).toHaveLength(0);
  });

  it("reports a truncated turn", async () => {
    const { session: master } = session([{ text: "half a th", stopReason: "max_tokens" }]);
    const events = await collect(master.send("write a novel"));
    expect(of(events, "error")[0]?.error).toMatchObject({ code: "max_tokens", retryable: true });
  });

  it("reports a transport failure", async () => {
    const { session: master } = session([{ error: new Error("socket hang up") }]);
    const events = await collect(master.send("hello"));
    expect(of(events, "error")[0]?.error).toMatchObject({ code: "transport", retryable: true });
    expect(of(events, "done")[0]?.outcome).toBe("error");
  });

  it("stops a runaway tool loop", async () => {
    const turn: FakeTurn = {
      toolUses: [{ id: "c1", name: "read_workspace", input: {} }],
    };
    const { session: master } = session([turn, turn, turn], { maxIterations: 3 });
    const events = await collect(master.send("look"));
    expect(of(events, "done")[0]?.outcome).toBe("max_iterations");
  });

  it("refuses to run a cancelled thread", async () => {
    const { session: master } = session([{ text: "never reached" }]);
    await master.applyTrigger({ type: "cancelled" });
    const events = await collect(master.send("still there?"));
    expect(of(events, "error")[0]?.error.code).toBe("phase");
    expect(of(events, "done")[0]?.outcome).toBe("cancelled");
  });
});

/* -------------------------------------------------------------------------- */
/* Usage and budget                                                           */
/* -------------------------------------------------------------------------- */

describe("usage accounting", () => {
  it("accumulates tokens and dollars across turns", async () => {
    const { session: master } = session([
      {
        toolUses: [{ id: "c1", name: "read_workspace", input: {} }],
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
      {
        text: "done",
        usage: {
          input_tokens: 0,
          output_tokens: 1_000_000,
          cache_read_input_tokens: 1_000_000,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    const events = await collect(master.send("go"));
    const usages = of(events, "usage");
    expect(usages).toHaveLength(2);
    // 1M input at $5/MTok.
    expect(usages[0]?.turn.costUSD).toBeCloseTo(5, 6);
    // 1M output at $25/MTok + 1M cache reads at 0.1 × $5/MTok.
    expect(usages[1]?.turn.costUSD).toBeCloseTo(25.5, 6);
    expect(usages[1]?.thread.costUSD).toBeCloseTo(30.5, 6);
    expect(usages[1]?.thread.inputTokens).toBe(1_000_000);
    expect(usages[1]?.thread.outputTokens).toBe(1_000_000);
    expect(usages[1]?.thread.cacheReadTokens).toBe(1_000_000);

    const state = await master.state();
    expect(state.usage.costUSD).toBeCloseTo(30.5, 6);
  });

  it("raises a spend approval at 80% and blocks the thread at 100%", async () => {
    const host = createFakeHost({ files: FILES });
    const { session: master } = session(
      [
        // $4.50 of a $5 budget → warning.
        {
          toolUses: [{ id: "c1", name: "read_workspace", input: {} }],
          usage: { input_tokens: 900_000, output_tokens: 0 },
        },
        // another $2.50 → over budget.
        { text: "…", usage: { input_tokens: 500_000, output_tokens: 0 } },
      ],
      { host, budgetUSD: 5 },
    );

    const events = await collect(master.send("go"));
    const approvals = of(events, "approval_requested");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.request.kind).toBe("spend");
    expect(approvals[0]?.callId).toBeUndefined();

    expect(of(events, "error")[0]?.error.code).toBe("budget");
    expect(of(events, "done")[0]?.outcome).toBe("budget_exceeded");
    expect((await master.state()).phase).toBe("blocked");
  });
});

/* -------------------------------------------------------------------------- */
/* Conversation persistence                                                    */
/* -------------------------------------------------------------------------- */

describe("conversation persistence", () => {
  it("appends assistant content verbatim so thinking blocks survive", async () => {
    const { session: master, store } = session([
      {
        thinking: "weighing the options",
        text: "Here is what I think.",
        toolUses: [{ id: "c1", name: "read_workspace", input: {} }],
      },
      { text: "All set." },
    ]);

    await collect(master.send("hello"));
    const history = await store.loadMessages("th_1");
    const assistant = history.filter((message) => message.role === "assistant");
    expect(assistant).toHaveLength(2);
    const blocks = assistant[0]?.content;
    expect(Array.isArray(blocks)).toBe(true);
    expect((blocks as { type: string }[]).map((block) => block.type)).toEqual([
      "thinking",
      "text",
      "tool_use",
    ]);
    expect((blocks as { signature?: string }[])[0]?.signature).toBe("fake-signature");
  });

  it("answers every tool_use in a batch, including the ones after a suspension", async () => {
    const { session: master, store } = session([
      {
        toolUses: [
          { id: "c1", name: "read_workspace", input: {} },
          { id: "c2", name: "ask_user", input: { questions: [{ id: "q1", text: "which one?" }] } },
          { id: "c3", name: "search_code", input: { query: "todo" } },
        ],
      },
      { text: "Thanks." },
    ]);

    await collect(master.send("go"));
    await collect(master.send({ kind: "answers", answers: [{ id: "q1", answer: "the first" }] }));

    const history = await store.loadMessages("th_1");
    const resultMessage = history.find(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((block) => (block as { type: string }).type === "tool_result"),
    );
    const resultBlocks = (resultMessage?.content ?? []) as { tool_use_id: string }[];
    const ids = resultBlocks.map((block) => block.tool_use_id);
    expect(ids).toEqual(["c1", "c2", "c3"]);
  });

  it("builds the request from the phase's tool surface", async () => {
    const { session: master, llm } = session([
      { toolUses: [{ id: "c1", name: "read_workspace", input: {} }] },
      { text: "ok" },
    ]);
    await collect(master.send("hi"));
    const names = llm.requests[0]?.tools.map((tool) => ("name" in tool ? tool.name : tool.type));
    expect(names).toContain("web_search");
    expect(names).not.toContain("dispatch_task");
    expect(llm.requests[0]?.system).toContain("Phase: intake");
    expect(llm.requests[0]?.systemSuffix).toContain("phase: intake");
  });
});
