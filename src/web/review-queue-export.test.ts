import { describe, expect, it } from "vitest";
import type { ReviewQueuePage } from "../shared/contracts.js";
import { reviewQueueExportFilename, serializeReviewQueueExport } from "./review-queue-export.js";

const page: ReviewQueuePage = {
  workspaceId: "workspace-review",
  items: [
    {
      id: "thread-1:message-1",
      prompt: { id: "prompt-1", content: "Investigate", createdAt: "2026-09-12T00:00:00Z" },
      message: {
        id: "message-1",
        threadId: "thread-1",
        content: "Needs evidence",
        createdAt: "2026-09-12T00:01:00Z",
        runId: "run-1",
      },
      feedback: {
        threadId: "thread-1",
        messageId: "message-1",
        value: "negative",
        note: "Add a source",
        reviewStatus: "open",
        agentId: "agent-1",
        runId: "run-1",
        updatedAt: "2026-09-12T00:02:00Z",
      },
      thread: { id: "thread-1", name: "Research", archived: false },
      agent: { id: "agent-1", name: "Reviewer", handle: "reviewer" },
    },
  ],
  page: { nextCursor: null },
  total: 1,
  coverage: { complete: true, unavailableThreads: 0 },
};

describe("review queue export", () => {
  it("serializes a typed, bounded envelope with provenance", () => {
    const payload = JSON.parse(
      serializeReviewQueueExport(page, "open", "2026-09-12T01:00:00.000Z"),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      format: "nexestra.review-cases",
      version: 1,
      workspaceId: page.workspaceId,
      status: "open",
      exportedAt: "2026-09-12T01:00:00.000Z",
    });
    expect(payload.cases).toEqual(page.items);
  });

  it("records the active agent and thread filters", () => {
    const payload = JSON.parse(
      serializeReviewQueueExport(page, "open", undefined, {
        agentId: "agent-1",
        threadId: "thread-1",
      }),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({ agentId: "agent-1", threadId: "thread-1" });
  });

  it("uses a safe deterministic filename", () => {
    expect(reviewQueueExportFilename("workspace / private", new Date("2026-09-12T00:00:00Z"))).toBe(
      "nexestra-review-cases-workspace-private-2026-09-12.json",
    );
  });

  it("caps packets even when the browser has loaded more rows", () => {
    const seed = page.items[0];
    if (!seed) throw new Error("expected review fixture");
    const expanded: ReviewQueuePage = {
      ...page,
      items: Array.from({ length: 201 }, (_, index) => ({
        ...seed,
        id: `thread-1:message-${index}`,
        message: { ...seed.message, id: `message-${index}` },
        feedback: { ...seed.feedback, messageId: `message-${index}` },
      })),
    };
    const payload = JSON.parse(serializeReviewQueueExport(expanded, "all")) as {
      cases: unknown[];
    };
    expect(payload.cases).toHaveLength(200);
  });
});
