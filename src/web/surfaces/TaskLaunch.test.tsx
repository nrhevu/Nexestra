// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentView, type BootstrapData, TaskSchema } from "../../shared/contracts.js";
import { TaskLaunch } from "./TaskLaunch.js";

const task = TaskSchema.parse({
  id: "task",
  workspaceId: "workspace",
  title: "Draft a memo",
  kind: "document",
  description: "",
  status: "todo",
  assigneeId: null,
  threadId: "thread",
  createdAt: "2026-09-07",
  updatedAt: "2026-09-07",
  acceptanceCriteria: [{ behavior: "Memo addresses the audience", verification: "Read it" }],
});
const worker = {
  id: "worker",
  workspaceId: "workspace",
  kind: "worker",
  handle: "writer",
  name: "Writer",
  enabled: true,
  archived: false,
  readiness: "ready",
  readinessLabel: "Ready",
} as AgentView;
const data = { agents: [worker], knowledge: [] } as unknown as BootstrapData;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("Task assignment surface", () => {
  it("starts a document Worker without a repository and sends the current task revision", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ status: "queued" }), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetch);
    const onStarted = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<TaskLaunch task={task} data={data} onStarted={onStarted} />);
    expect(screen.getByLabelText("Task workspace")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Start Worker" }));
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      workerHandle: "writer",
      expectedRevision: 1,
    });
    expect(onStarted).toHaveBeenCalledOnce();
  });
  it("explains missing acceptance criteria and blocks an incomplete assignment", () => {
    render(
      <TaskLaunch
        task={{ ...task, acceptanceCriteria: [] }}
        data={data}
        onStarted={async () => undefined}
      />,
    );
    expect(screen.getByText(/Add an acceptance criterion/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Start Worker" })).toBeDisabled();
  });
});
