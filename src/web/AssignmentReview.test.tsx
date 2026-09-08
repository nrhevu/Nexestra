// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentView,
  AssignmentGitReview,
  BootstrapData,
  KnowledgeRepository,
  Task,
  WorkAssignment,
} from "../shared/contracts.js";
import { App } from "./App.js";

const now = "2026-09-08T10:00:00.000Z";
const workspace = {
  id: "ws-review",
  name: "Review",
  slug: "review",
  createdAt: now,
  updatedAt: now,
};
const common = { workspaceId: workspace.id, createdAt: now, updatedAt: now };
const worker: AgentView = {
  ...common,
  id: "worker",
  kind: "worker",
  name: "Builder",
  handle: "builder",
  description: "",
  instructions: "",
  enabled: true,
  archived: false,
  harness: "codex",
  readiness: "ready",
  readinessLabel: "Ready",
};
const repository: KnowledgeRepository = {
  ...common,
  id: "repository",
  kind: "repository",
  name: "Project",
  handle: "project",
  description: "",
  source: "/test/project",
  storagePath: "workspaces/ws-review/repositories/repository/source",
  status: "ready",
};
const task: Task = {
  ...common,
  id: "task",
  title: "Inspect changes",
  description: "",
  status: "done",
  assigneeId: worker.id,
  threadId: "thread",
  verificationCommand: "",
};
const assignment: WorkAssignment = {
  ...common,
  id: "attempt-one",
  taskId: task.id,
  threadId: "thread",
  masterRunId: "manual",
  workerAgentId: worker.id,
  repositoryId: repository.id,
  status: "completed",
  branch: "nexestra/attempt-one",
  worktreePath: "workspaces/ws-review/worktrees/attempt-one",
  baseCommit: "a".repeat(40),
};

function snapshot(attempt = assignment, content = "-old line\n+new line"): AssignmentGitReview {
  const changes = {
    files: [{ path: "README.md", insertions: 1, deletions: 1 }],
    insertions: 1,
    deletions: 1,
    truncated: false,
  };
  const empty = { files: [], insertions: 0, deletions: 0, truncated: false };
  return {
    assignment: attempt,
    state: "available",
    branch: attempt.branch,
    baseCommit: attempt.baseCommit,
    headCommit: "b".repeat(40),
    tracked: {
      committed: changes,
      staged: empty,
      unstaged: empty,
      baseToWorktree: changes,
      patch: { content, truncated: false, binaryPaths: [] },
    },
    untracked: { files: ["notes.md"], truncated: false },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function openProcess(review: (id: string) => Promise<Response>, initial = assignment) {
  let current = initial;
  const next = { ...assignment, id: "attempt-two", branch: "nexestra/attempt-two" };
  const bootstrap: BootstrapData = {
    workspaces: [workspace],
    workspace,
    agents: [worker],
    knowledge: [repository],
    tasks: [task],
    threads: [],
    assignments: [current],
    activeRuns: [],
    attention: [],
    workspacePath: "/test",
    dataPath: "/test/.nexestra",
    runtime: {
      chatgpt: { installed: false, connected: false, message: "Fixture" },
      harnesses: {
        codex: { installed: true, version: "fixture" },
        opencode: { installed: false, version: null },
      },
    },
  };
  window.history.replaceState({}, "", "/surfaces/taskboard");
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.startsWith("/api/bootstrap")) return json(bootstrap);
    if (path === `/api/tasks/${task.id}/process`) {
      return json({ task, assignment: current, assignments: [current], toolCalls: [] });
    }
    if (path === `/api/tasks/${task.id}/delegate`) {
      current = next;
      return json(next, 202);
    }
    if (path.startsWith("/api/assignments/") && path.endsWith("/review")) {
      return review(path.split("/")[3] ?? "");
    }
    return json({ error: { message: "Unexpected fixture request" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: `Open process for ${task.title}` }));
  const dialog = await screen.findByRole("dialog", { name: task.title });
  await within(dialog).findByRole("button", { name: "Review worker changes" });
  return { user, dialog, fetchMock, next };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Assignment review UI", () => {
  it("loads only on request, shows changes and untracked files, and refreshes the snapshot explicitly", async () => {
    const review = vi.fn(async () =>
      json(snapshot(assignment, `patch version ${review.mock.calls.length}`)),
    );
    const { user, dialog } = await openProcess(review);
    expect(review).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Review worker changes" }));
    const region = within(dialog).getByRole("region", { name: "Git review" });
    expect(await within(region).findByText("Snapshot loaded")).toBeVisible();
    expect(within(region).getByText("notes.md")).toBeVisible();
    await user.click(within(region).getByText("Diff preview"));
    expect(within(region).getByText("patch version 1")).toBeVisible();
    expect(review).toHaveBeenCalledTimes(1);
    await user.click(within(region).getByRole("button", { name: "Refresh" }));
    expect(await within(region).findByText("patch version 2")).toBeVisible();
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed inspection retryable and reports why a comparison is unavailable", async () => {
    let calls = 0;
    const { user, dialog } = await openProcess(async () => {
      calls += 1;
      return calls === 1
        ? json({ error: { message: "Git inspection failed." } }, 500)
        : json({
            assignment,
            state: "legacy",
            reason: "This assignment has no recorded starting commit.",
          });
    });
    await user.click(within(dialog).getByRole("button", { name: "Review worker changes" }));
    expect(await within(dialog).findByText("Git inspection failed.")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Review worker changes" }));
    expect(
      await within(dialog).findByText("This assignment has no recorded starting commit."),
    ).toBeVisible();
    expect(within(dialog).queryByText("Diff preview")).not.toBeInTheDocument();
  });

  it("does not attach a delayed snapshot to a newer Worker assignment", async () => {
    let resolveOld!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    const oldAttempt = { ...assignment, status: "failed" as const };
    const { user, dialog, next } = await openProcess(async (id) => {
      return id === oldAttempt.id
        ? pending
        : json(snapshot({ ...assignment, id }, "new attempt patch"));
    }, oldAttempt);
    await user.click(within(dialog).getByRole("button", { name: "Review worker changes" }));
    expect(within(dialog).getByRole("button", { name: "Review worker changes" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Retry Worker" }));
    await within(dialog).findAllByText(next.branch);
    await act(async () => {
      resolveOld(json(snapshot(oldAttempt, "obsolete patch")));
    });
    expect(within(dialog).queryByText("Snapshot loaded")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Review worker changes" }));
    await within(dialog).findByText("Snapshot loaded");
    await user.click(within(dialog).getByText("Diff preview"));
    expect(within(dialog).getByText("new attempt patch")).toBeVisible();
    expect(within(dialog).queryByText("obsolete patch")).not.toBeInTheDocument();
  });
});
