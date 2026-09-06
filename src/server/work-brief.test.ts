import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SaveWorkBriefSchema } from "../shared/contracts.js";
import { createApp } from "./app.js";
import { createMasterToolSession } from "./master-harness.js";
import type { AgentInvocation, AgentRunner } from "./runtime.js";
import { FileStore } from "./store.js";

const research = {
  title: "Choose a launch audience",
  kind: "research",
  outcome: "Choose one audience using traceable evidence.",
  deliverables: ["Audience comparison", "Recommendation memo"],
  constraints: "Public sources only; distinguish facts from assumptions.",
  nonGoals: "No code or product launch.",
  acceptanceCriteria: [
    {
      behavior: "Each factual claim is traceable.",
      verification: "A reviewer opens each cited primary source and checks the claim.",
    },
  ],
  openQuestions: "",
  expectedRevision: 0,
};

describe("Work briefs", () => {
  let store: FileStore;
  let root: string;
  let threadId: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nexestra-brief-"));
    store = await FileStore.open({ root, workspacePath: root });
    threadId = store.listThreads()[0]?.id ?? "";
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("replays the latest revision from the canonical transcript across restart and repairs an incomplete tail", async () => {
    await store.createUserMessage(threadId, "Let's research this.", []);
    const before = await readFile(store.transcriptPath(threadId), "utf8");
    await store.saveWorkBrief(threadId, research);
    await store.confirmWorkBrief(threadId, { expectedRevision: 1 });
    await appendFile(
      store.transcriptPath(threadId),
      '{"type":"brief.updated","sequence":4,"workBrief":',
    );
    const reopened = await FileStore.open({ root, workspacePath: root });
    const data = await reopened.threadData(threadId);
    expect(data.workBrief).toMatchObject({
      title: research.title,
      status: "confirmed",
      revision: 2,
    });
    expect(data.messages).toHaveLength(1);
    expect(data.thread.messageCount).toBe(1);
    const revised = await reopened.saveWorkBrief(threadId, {
      ...research,
      title: "Reconsider the audience",
      expectedRevision: 2,
    });
    expect(revised).toMatchObject({ status: "draft", confirmedAt: null, revision: 3 });
    const transcript = await readFile(store.transcriptPath(threadId), "utf8");
    expect(transcript.startsWith(before)).toBe(true);
    expect(
      transcript
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).sequence),
    ).toEqual([1, 2, 3, 4]);
    expect(await readFile(store.stateFile, "utf8")).not.toContain(research.title);
  });

  it("accepts only one concurrent edit of a revision and rejects stale confirmations", async () => {
    await store.saveWorkBrief(threadId, research);
    const writes = await Promise.allSettled([
      store.saveWorkBrief(threadId, { ...research, title: "Human edit", expectedRevision: 1 }),
      store.saveWorkBrief(threadId, { ...research, title: "Agent edit", expectedRevision: 1 }),
    ]);
    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "conflict" } },
    ]);
    await expect(store.confirmWorkBrief(threadId, { expectedRevision: 1 })).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await store.getWorkBrief(threadId))?.title).toBe("Human edit");
  });

  it("allows incomplete drafts but requires an outcome, deliverable, checks and resolved questions to confirm", async () => {
    await store.saveWorkBrief(threadId, { title: "An idea", expectedRevision: 0 });
    await expect(store.confirmWorkBrief(threadId, { expectedRevision: 1 })).rejects.toMatchObject({
      code: "invalid",
    });
    await store.saveWorkBrief(threadId, {
      ...research,
      openQuestions: "Which country?",
      expectedRevision: 1,
    });
    await expect(store.confirmWorkBrief(threadId, { expectedRevision: 2 })).rejects.toThrow(
      "Resolve the open questions",
    );
    await store.saveWorkBrief(threadId, { ...research, expectedRevision: 2 });
    await expect(store.confirmWorkBrief(threadId, { expectedRevision: 3 })).resolves.toMatchObject({
      status: "confirmed",
      revision: 4,
    });
  });

  it("bounds the contract and rejects attempts to supply completion or author metadata", () => {
    expect(SaveWorkBriefSchema.safeParse({ ...research, status: "confirmed" }).success).toBe(false);
    expect(
      SaveWorkBriefSchema.safeParse({ ...research, updatedBy: { kind: "user", id: "local-user" } })
        .success,
    ).toBe(false);
    expect(
      SaveWorkBriefSchema.safeParse({
        ...research,
        acceptanceCriteria: [{ behavior: "Looks right" }],
      }).success,
    ).toBe(false);
    expect(SaveWorkBriefSchema.safeParse({ ...research, outcome: "x".repeat(2001) }).success).toBe(
      false,
    );
    expect(
      SaveWorkBriefSchema.safeParse({ ...research, deliverables: Array(11).fill("memo") }).success,
    ).toBe(false);
  });

  it("redacts every content field, scopes workspace listings and refuses a foreign author", async () => {
    const foreign = await store.createWorkspace({ name: "Other workspace" });
    const secret = "brief-test-secret";
    const agent = await store.createAgent({
      workspaceId: foreign.id,
      kind: "master",
      name: "Planner",
      handle: "planner",
      provider: {
        type: "custom",
        name: "Test",
        model: "test",
        baseUrl: "https://example.test/v1",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });
    await expect(store.saveWorkBrief(threadId, research, agent.id)).rejects.toMatchObject({
      code: "invalid",
    });
    await store.saveWorkBrief(threadId, {
      ...research,
      title: secret,
      outcome: secret,
      deliverables: [secret],
      constraints: secret,
      nonGoals: secret,
      openQuestions: secret,
      acceptanceCriteria: [{ behavior: secret, verification: secret }],
    });
    expect(await readFile(store.transcriptPath(threadId), "utf8")).not.toContain(secret);
    expect(await store.listWorkBriefs(foreign.id)).toEqual([]);
  });

  it("runs the HTTP → mention → brief tool → restart flow without a repository or provider, and never dispatches from a brief", async () => {
    const invocations: AgentInvocation[] = [];
    const runner: AgentRunner = {
      runtimeStatus: async () => ({
        chatgpt: { installed: false, connected: false, message: "Offline" },
        harnesses: {
          codex: { installed: false, version: null },
          opencode: { installed: false, version: null },
        },
      }),
      invoke: async (agent, invocation) => {
        invocations.push(invocation);
        expect((await store.threadData(threadId)).messages.at(-1)?.id).toBe(invocation.trigger.id);
        if (agent.kind !== "master") throw new Error("Expected a Master.");
        const session = await createMasterToolSession({
          agent,
          runId: invocation.runId ?? "test",
          threadId,
          workspacePath: root,
          dataPath: root,
          hooks: invocation.toolHooks,
          env: { HOME: root, XDG_CONFIG_HOME: root },
          redact: (value) => store.redactSecrets(value),
        });
        try {
          expect(
            session.definitions.some((definition) => definition.name === "confirm_brief"),
          ).toBe(false);
          const read = JSON.parse(
            await session.execute({ id: "read", name: "read_brief", arguments: "{}" }),
          );
          expect(read.workBrief).toMatchObject({ revision: 2, status: "confirmed" });
          const write = await session.execute({
            id: "write",
            name: "draft_brief",
            arguments: JSON.stringify({
              ...research,
              outcome: "Compare launch audiences with a source matrix.",
              expectedRevision: 2,
            }),
          });
          expect(JSON.parse(write)).toMatchObject({
            revision: 3,
            status: "draft",
            updatedBy: { kind: "agent", id: agent.id },
          });
          return "I refined the research brief. @planner is a reference, not another invocation.";
        } finally {
          await session.close();
        }
      },
    };
    await store.createAgent({
      kind: "master",
      name: "Planner",
      handle: "planner",
      provider: {
        type: "custom",
        name: "Offline fake",
        model: "fake",
        baseUrl: "https://example.test/v1",
        protocol: "openai-chat",
      },
    });
    const app = createApp({ store, runner });
    const request = (
      path: string,
      body: unknown,
      method = "POST",
      origin = "http://127.0.0.1:5173",
    ) =>
      app.request(path, {
        method,
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(body),
      });
    expect(
      (await request(`/api/threads/${threadId}/brief`, research, "PUT", "https://evil.test"))
        .status,
    ).toBe(403);
    expect((await request(`/api/threads/${threadId}/brief`, research, "PUT")).status).toBe(200);
    expect(
      (await request(`/api/threads/${threadId}/brief/confirm`, { expectedRevision: 1 })).status,
    ).toBe(200);
    expect(invocations).toHaveLength(0);
    expect((await request(`/api/threads/${threadId}/brief`, research, "PUT")).status).toBe(409);
    await request(`/api/threads/${threadId}/messages`, {
      content: "@planner refine the research scope",
    });
    await app.dispatcher.waitForIdle();
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.workBrief).toMatchObject({
      revision: 2,
      status: "confirmed",
      kind: "research",
    });
    const bootstrap = await (await app.request("/api/bootstrap")).json();
    expect(bootstrap.workBriefs).toMatchObject([{ revision: 3, status: "draft" }]);
    expect(bootstrap.tasks).toEqual([]);
    expect(bootstrap.assignments).toEqual([]);
    const reopened = await FileStore.open({ root, workspacePath: root });
    expect((await reopened.getWorkBrief(threadId))?.outcome).toContain("source matrix");
    expect((await reopened.threadData(threadId)).messages).toHaveLength(2);
  });
});
