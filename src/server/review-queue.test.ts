import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewQueueItem } from "../shared/contracts.js";
import { createApp } from "./app.js";
import {
  compareReviewQueueItems,
  decodeReviewQueueCursor,
  encodeReviewQueueCursor,
  reviewQueueItemAfterCursor,
} from "./review-queue.js";
import type { AgentRunner } from "./runtime.js";
import { FileStore } from "./store.js";

async function openStore() {
  const root = await mkdtemp(join(tmpdir(), "nexestra-review-queue-"));
  return FileStore.open({ root, workspacePath: root });
}

describe("review queue", () => {
  it("keeps equal-timestamp cursor pages in stable item order", () => {
    const item = (id: string): ReviewQueueItem => ({
      id,
      feedback: {
        threadId: "thread",
        messageId: id,
        value: "negative",
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
      message: {
        id,
        threadId: "thread",
        content: id,
        createdAt: "2026-09-12T00:00:00.000Z",
      },
      thread: { id: "thread", name: "Thread", archived: false },
      agent: { id: "agent", name: "Agent", handle: "agent" },
    });
    const items = [item("thread:c"), item("thread:a"), item("thread:b")].sort(
      compareReviewQueueItems,
    );
    expect(items.map((entry) => entry.id)).toEqual(["thread:a", "thread:b", "thread:c"]);
    const cursor = decodeReviewQueueCursor(
      encodeReviewQueueCursor(
        { workspaceId: "workspace", status: "open", limit: 1 },
        items[0] as ReviewQueueItem,
      ),
    );
    expect(cursor).toBeDefined();
    if (!cursor) throw new Error("expected cursor");
    expect(items.filter((entry) => reviewQueueItemAfterCursor(entry, cursor))).toEqual([
      items[1],
      items[2],
    ]);
  });

  it("lists redacted needs-work replies with cursor pagination and workspace scoping", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const foreign = await store.createWorkspace({ name: "Foreign" });
    const agent = await store.createAgent({
      kind: "master",
      name: "Reviewer sk-review-secret",
      handle: "reviewer",
      description: "",
      instructions: "",
      accessMode: "ask",
      provider: {
        type: "custom",
        name: "Review provider",
        baseUrl: "https://example.com",
        model: "review-model",
        protocol: "openai-chat",
        apiKey: "sk-review-secret",
      },
    });
    const thread = await store.createThread({ name: "Research" });
    const prompt = await store.createUserMessage(
      thread.id,
      "Investigate this request sk-review-secret",
      [],
    );
    const first = await store.createAgentMessage(
      thread.id,
      agent,
      "First response sk-review-secret",
      prompt.id,
    );
    const second = await store.createAgentMessage(thread.id, agent, "Second response", "trigger-2");
    await store.setMessageFeedback(thread.id, first.id, {
      value: "negative",
      note: "Needs a source sk-review-secret",
    });
    await store.setMessageFeedback(thread.id, second.id, { value: "negative" });

    const firstPage = await store.listReviewQueue({ workspaceId: workspace.id, limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.total).toBe(2);
    expect(firstPage.page.nextCursor).toBeTruthy();
    expect(JSON.stringify(firstPage)).not.toContain("sk-review-secret");
    expect(firstPage.items[0]?.feedback.value).toBe("negative");
    expect(firstPage.items[0]?.feedback.reviewStatus).toBe("open");
    expect(firstPage.items[0]?.message.content.length).toBeLessThanOrEqual(800);
    const allReviews = await store.listReviewQueue({ workspaceId: workspace.id, limit: 50 });
    const firstReview = allReviews.items.find((item) => item.message.id === first.id);
    expect(firstReview?.prompt).toMatchObject({
      id: prompt.id,
      content: "Investigate this request [REDACTED]",
    });
    expect(JSON.stringify(firstReview?.prompt)).not.toContain("sk-review-secret");

    const secondPage = await store.listReviewQueue({
      workspaceId: workspace.id,
      limit: 1,
      cursor: firstPage.page.nextCursor ?? undefined,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(new Set([firstPage.items[0]?.id, secondPage.items[0]?.id]).size).toBe(2);

    const foreignAgent = await store.createAgent({
      workspaceId: foreign.id,
      kind: "worker",
      name: "Foreign",
      handle: "foreign",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const foreignThread = await store.createThread({ workspaceId: foreign.id, name: "Foreign" });
    const foreignMessage = await store.createAgentMessage(
      foreignThread.id,
      foreignAgent,
      "Foreign response",
      "foreign-trigger",
    );
    await store.setMessageFeedback(foreignThread.id, foreignMessage.id, { value: "negative" });
    const scoped = await store.listReviewQueue({ workspaceId: workspace.id, limit: 50 });
    expect(scoped.items).toHaveLength(2);
    expect(JSON.stringify(scoped)).not.toContain(foreignMessage.id);

    const resolved = await store.setMessageReviewStatus(thread.id, first.id, {
      status: "resolved",
    });
    expect(resolved.reviewStatus).toBe("resolved");
    expect(
      (await store.listReviewQueue({ workspaceId: workspace.id, limit: 50 })).items,
    ).toHaveLength(1);
    expect(
      (await store.listReviewQueue({ workspaceId: workspace.id, status: "resolved", limit: 50 }))
        .items,
    ).toHaveLength(1);
    await expect(
      store.setMessageReviewStatus(thread.id, first.id, { status: "open" }),
    ).resolves.toMatchObject({ reviewStatus: "open" });
  });

  it("serves the review queue through the loopback API", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const agent = await store.createAgent({
      kind: "worker",
      name: "Reviewer",
      handle: "reviewer",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const thread = await store.createThread({ name: "API" });
    const message = await store.createAgentMessage(thread.id, agent, "Needs work", "trigger");
    await store.setMessageFeedback(thread.id, message.id, { value: "negative", note: "Fix it" });
    const app = createApp({ store, runner: {} as AgentRunner });
    const response = await app.request(`/api/reviews?workspaceId=${workspace.id}&limit=50`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: workspace.id,
      items: [
        expect.objectContaining({
          message: expect.objectContaining({ id: message.id, content: "Needs work" }),
          feedback: expect.objectContaining({ value: "negative", note: "Fix it" }),
        }),
      ],
    });
    const resolved = await app.request(`/api/reviews/${thread.id}/${message.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ reviewStatus: "resolved" });
  });
});
