// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
    render(<ReviewQueueView workspaceId={workspaceId} onOpenMessage={onOpenMessage} />);
    expect(await screen.findByText("A response that needs review.")).toBeVisible();
    expect(screen.getByText("Note: Add evidence")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open response" }));
    expect(onOpenMessage).toHaveBeenCalledExactlyOnceWith(thread.id, "message-reply");
  });
});
