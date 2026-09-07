// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskSchema, WorkAssignmentSchema } from "../../shared/contracts.js";
import { TaskReview } from "./TaskReview.js";

const task = TaskSchema.parse({
  id: "task",
  workspaceId: "workspace",
  threadId: "thread",
  title: "Research",
  description: "",
  status: "in_review",
  assigneeId: "worker",
  createdAt: "2026-09-06",
  updatedAt: "2026-09-06",
  acceptanceCriteria: [{ behavior: "Claims are sourced", verification: "Open the source" }],
});
const assignment = WorkAssignmentSchema.parse({
  id: "assignment",
  workspaceId: "workspace",
  taskId: task.id,
  threadId: "thread",
  masterRunId: "run",
  workerAgentId: "worker",
  repositoryId: "repo",
  status: "completed",
  branch: "branch",
  worktreePath: "worktree",
  contract: task,
  createdAt: "2026-09-06",
  updatedAt: "2026-09-06",
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("Task review surface", () => {
  it("collects evidence and notes before submitting an acceptance for the exact assignment", async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ...task, status: "done" })),
    );
    vi.stubGlobal("fetch", fetch);
    const onReviewed = vi.fn(async () => undefined);
    render(<TaskReview task={task} assignment={assignment} onReviewed={onReviewed} />);
    expect(screen.getByRole("button", { name: "Accept result" })).toBeDisabled();
    await user.type(screen.getByLabelText("Review notes"), "Approved after review");
    expect(screen.getByRole("button", { name: "Accept result" })).toBeDisabled();
    await user.type(screen.getByLabelText("Evidence for criterion 1"), "Source supports the claim");
    await user.click(screen.getByRole("button", { name: "Accept result" }));
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      assignmentId: "assignment",
      expectedRevision: 1,
      outcome: "accepted",
      notes: "Approved after review",
      evidence: [{ criterionIndex: 0, observation: "Source supports the claim" }],
    });
    expect(onReviewed).toHaveBeenCalledOnce();
  });
  it("preserves review notes when a newer task revision makes submission fail", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "The requirements changed. Reload the task." } }),
            { status: 409 },
          ),
      ),
    );
    render(<TaskReview task={task} assignment={assignment} onReviewed={async () => undefined} />);
    await user.type(screen.getByLabelText("Review notes"), "Source does not support this claim");
    await user.click(screen.getByRole("button", { name: "Request changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The requirements changed");
    expect(screen.getByLabelText("Review notes")).toHaveValue("Source does not support this claim");
  });
});
