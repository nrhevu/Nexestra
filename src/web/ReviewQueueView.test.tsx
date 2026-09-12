// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentView, ReviewQueuePage, Thread } from "../shared/contracts.js";
import { ReviewQueueView } from "./ReviewQueueView.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const workspaceId = "workspace-review";
const now = "2026-09-12T00:00:00.000Z";
const agent: AgentView = {
  id: "agent-reviewer",
  workspaceId,
  kind: "worker",
  name: "Reviewer",
  handle: "reviewer",
  description: "",
  instructions: "",
  enabled: true,
  archived: false,
  harness: "codex",
  createdAt: now,
  updatedAt: now,
  readiness: "ready",
  readinessLabel: "Ready",
};
const thread: Thread = {
  id: "thread-research",
  workspaceId,
  name: "Research",
  slug: "research",
  createdAt: now,
  updatedAt: now,
  messageCount: 2,
  lastMessageAt: now,
  archived: false,
};

function page(): ReviewQueuePage {
  return {
    workspaceId,
    items: [
      {
        id: `${thread.id}:message-reply`,
        feedback: {
          threadId: thread.id,
          messageId: "message-reply",
          value: "negative",
          note: "Add evidence",
          agentId: agent.id,
          updatedAt: now,
        },
        prompt: {
          id: "message-prompt",
          content: "Investigate the request",
          createdAt: now,
        },
        message: {
          id: "message-reply",
          threadId: thread.id,
          content: "A response that needs review.",
          createdAt: now,
        },
        thread: { id: thread.id, name: thread.name, archived: false },
        agent: { id: agent.id, name: agent.name, handle: agent.handle },
      },
    ],
    page: { nextCursor: null },
    total: 1,
    coverage: { complete: true, unavailableThreads: 0 },
  };
}

describe("ReviewQueueView", () => {
  it("loads needs-work replies and opens the exact source message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => page(),
    } as Response);
    const onOpenMessage = vi.fn();
    const onCaptureMessage = vi.fn();
    const onSetReviewStatus = vi.fn().mockResolvedValue(undefined);
    const createObjectURL = vi.fn(() => "blob:review-export");
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    render(
      <ReviewQueueView
        workspaceId={workspaceId}
        agents={[agent]}
        threads={[thread]}
        onOpenMessage={onOpenMessage}
        onCaptureMessage={onCaptureMessage}
        onSetReviewStatus={onSetReviewStatus}
      />,
    );
    expect(await screen.findByText("A response that needs review.")).toBeVisible();
    expect(screen.getByText("Investigate the request")).toBeVisible();
    expect(screen.getByText("1 matching review")).toBeVisible();
    expect(screen.getByText("Note: Add evidence")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open response" }));
    expect(onOpenMessage).toHaveBeenCalledExactlyOnceWith(thread.id, "message-reply");
    await userEvent.click(screen.getByRole("button", { name: "Capture as Knowledge" }));
    expect(onCaptureMessage).toHaveBeenCalledExactlyOnceWith(page().items[0]);
    await userEvent.click(screen.getByRole("button", { name: "Export loaded reviews" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    expect(onSetReviewStatus).toHaveBeenCalledExactlyOnceWith(
      thread.id,
      "message-reply",
      "resolved",
    );
  });

  it("can inspect resolved reviews and reopen them", async () => {
    const resolvedPage = page();
    const review = resolvedPage.items[0];
    if (!review) throw new Error("expected review fixture");
    review.feedback.reviewStatus = "resolved";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => resolvedPage,
    } as Response);
    const onSetReviewStatus = vi.fn().mockResolvedValue(undefined);
    render(
      <ReviewQueueView
        workspaceId={workspaceId}
        onOpenMessage={vi.fn()}
        onSetReviewStatus={onSetReviewStatus}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Review status"), "resolved");
    expect(await screen.findByText("A response that needs review.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reopen review" }));
    expect(onSetReviewStatus).toHaveBeenCalledExactlyOnceWith(thread.id, "message-reply", "open");
  });

  it("applies agent and thread filters without carrying a stale cursor", async () => {
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      requests.push(String(input));
      return {
        ok: true,
        status: 200,
        json: async () => page(),
      } as Response;
    });
    render(
      <ReviewQueueView
        workspaceId={workspaceId}
        agents={[agent]}
        threads={[thread]}
        onOpenMessage={vi.fn()}
        onSetReviewStatus={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(await screen.findByText("A response that needs review.")).toBeVisible();

    await userEvent.selectOptions(screen.getByLabelText("Agent"), agent.id);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests.at(-1)).toContain(`agentId=${agent.id}`);
    expect(requests.at(-1)).not.toContain("cursor=");

    await userEvent.selectOptions(screen.getByLabelText("Thread"), thread.id);
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests.at(-1)).toContain(`agentId=${agent.id}`);
    expect(requests.at(-1)).toContain(`threadId=${thread.id}`);
    expect(requests.at(-1)).not.toContain("cursor=");
  });
});
