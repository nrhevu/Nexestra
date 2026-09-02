import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type NexestraStore } from "@nexestra/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createDemoLlmClient, DEMO_MODEL } from "./demo-llm.js";
import { MasterRunner } from "./runner.js";

/**
 * The demo model is what someone without an API key actually meets, so it gets
 * the same acceptance test as the real one: a vague request has to come out
 * the other end as a frozen spec with three verifiable criteria and a
 * four-task plan on the board, entirely through the production wiring.
 */

let home: string;
let store: NexestraStore;
let threadId: string;
let runner: MasterRunner;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nexestra-demo-"));
  const repository = join(home, "repo");
  mkdirSync(repository, { recursive: true });
  writeFileSync(join(repository, "README.md"), "# a repository\n");
  writeFileSync(join(repository, "package.json"), '{"name":"demo"}\n');

  store = createStore({ path: join(home, "nexestra.db"), dataDir: join(home, "data") });
  const workspaceId = store.createWorkspace({ name: "demo", rootPath: repository }).id;
  threadId = store.createThread({ workspaceId, title: "Something vague" }).id;

  runner = new MasterRunner({
    store,
    llm: createDemoLlmClient({ chunkDelayMs: 0 }),
    runtime: { client: "demo", model: DEMO_MODEL, apiKeyPresent: false },
  });
  app = createApp(store, { master: runner });
});

afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

const post = (path: string, payload?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

describe("the demo model", () => {
  it("carries a vague request to an approved spec and a plan", async () => {
    await post(`/api/threads/${threadId}/master/send`, {
      kind: "user_message",
      text: "make the settings page less confusing",
    });
    await runner.idle(threadId);

    let state = await runner.state(threadId);
    expect(state.phase).toBe("clarifying");
    expect(state.pending?.kind).toBe("ask_user");
    const questions = state.pending?.kind === "ask_user" ? state.pending.questions : [];
    expect(questions).toHaveLength(3);
    expect(questions.every((question) => question.options.length > 0)).toBe(true);

    await post(`/api/threads/${threadId}/master/send`, {
      kind: "answers",
      answers: questions.map((question) => ({
        id: question.id,
        answer: question.options[0] ?? "yes",
      })),
    });
    await runner.idle(threadId);

    const spec = store.getSpec(threadId);
    expect(spec?.goal).toContain("settings page");
    expect(spec?.acceptanceCriteria).toHaveLength(3);
    // Every criterion says how it is proved, and at least two are executable.
    const kinds = spec?.acceptanceCriteria.map((c) => c.verification.kind) ?? [];
    expect(kinds.filter((kind) => kind !== "manual_review").length).toBeGreaterThanOrEqual(2);
    expect(spec?.openQuestions.every((question) => question.answer)).toBe(true);

    const [approval] = store.listApprovals({ threadId, status: "pending" });
    expect(approval?.kind).toBe("spec");

    await post(`/api/approvals/${approval?.id}/resolve`, { status: "approved" });
    await runner.idle(threadId);

    state = await runner.state(threadId);
    expect(state.phase).toBe("planning");
    expect(store.getSpec(threadId)?.frozen).toBe(true);

    const tasks = store.listTasks(threadId);
    expect(tasks).toHaveLength(4);
    expect(tasks.some((task) => task.dependsOn.length > 0)).toBe(true);
    expect(new Set(tasks.map((task) => task.assignedHarness))).toEqual(
      new Set(["codex", "opencode"]),
    );
    // The plan covers every acceptance criterion.
    const covered = new Set(tasks.flatMap((task) => task.acceptanceCriteriaIds));
    for (const criterion of store.getSpec(threadId)?.acceptanceCriteria ?? []) {
      expect(covered.has(criterion.id)).toBe(true);
    }
  });

  it("closes questions the user skipped with a stated assumption", async () => {
    await post(`/api/threads/${threadId}/master/send`, {
      kind: "user_message",
      text: "tidy up the error handling",
    });
    await runner.idle(threadId);

    const state = await runner.state(threadId);
    const questions = state.pending?.kind === "ask_user" ? state.pending.questions : [];

    // Answer only the first; a free-text reply to `ask_user` does exactly this.
    await post(`/api/threads/${threadId}/master/send`, {
      kind: "answers",
      answers: [{ id: questions[0]?.id ?? "q_outcome", answer: "just the happy path" }],
    });
    await runner.idle(threadId);

    const spec = store.getSpec(threadId);
    expect(spec?.openQuestions.every((question) => question.answer)).toBe(true);
    expect(spec?.openQuestions.some((question) => question.answer?.startsWith("(assumed)"))).toBe(
      true,
    );
    expect(store.listApprovals({ threadId, status: "pending" })).toHaveLength(1);
  });
});
