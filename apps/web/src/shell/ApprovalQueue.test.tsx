import type { Approval, ApprovalKind, Task } from "@nexestra/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApprovalQueue } from "./ApprovalQueue.js";

const approval = (kind: ApprovalKind, overrides: Partial<Approval> = {}): Approval => ({
  id: `ap_${kind}`,
  workspaceId: "ws_1",
  threadId: "th_1",
  kind,
  title: `${kind} approval`,
  description: "",
  risk: "low",
  status: "pending",
  requestedAt: "2026-09-02T10:00:00.000Z",
  createdAt: "2026-09-02T10:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
  ...overrides,
});

const task = (id: string, title: string): Task => ({
  id,
  workspaceId: "ws_1",
  threadId: "th_1",
  planId: "pl_1",
  title,
  description: "",
  dependsOn: [],
  harnessConfig: {
    reasoning: "medium",
    sandbox: "workspace-write",
    tools: [],
    skills: [],
    mcpServers: [],
    timeoutMs: 900_000,
  },
  status: "running",
  attempts: 1,
  maxAttempts: 3,
  acceptanceCriteriaIds: [],
  costUSD: 0,
  order: 0,
  createdAt: "2026-09-02T10:00:00.000Z",
  updatedAt: "2026-09-02T10:00:00.000Z",
});

describe("ApprovalQueue", () => {
  it("lists every pending kind the orchestrator can raise", () => {
    const kinds: ApprovalKind[] = [
      "spec",
      "sandbox_escalation",
      "spend",
      "merge",
      "manual_verification",
      "permission",
    ];
    render(<ApprovalQueue approvals={kinds.map((kind) => approval(kind))} onResolve={() => {}} />);

    for (const kind of kinds) {
      expect(screen.getByText(`${kind} approval`)).toBeDefined();
    }
    expect(screen.getAllByRole("button", { name: /Approve/ })).toHaveLength(kinds.length);
  });

  it("hides resolved rows and says so when nothing is waiting", () => {
    render(
      <ApprovalQueue
        approvals={[
          approval("merge", { status: "approved" }),
          approval("spend", { status: "rejected" }),
        ]}
        onResolve={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.getByText("nothing waiting on you")).toBeDefined();
  });

  it("names the task an approval belongs to rather than its id", () => {
    render(
      <ApprovalQueue
        approvals={[approval("merge", { taskId: "task_2", runId: "run_9" })]}
        tasks={[task("task_2", "Implement the change")]}
        onResolve={() => {}}
      />,
    );

    expect(screen.getByText("Implement the change")).toBeDefined();
    expect(screen.getByText("run_9")).toBeDefined();
  });

  it("falls back to a per-kind explanation when the approval carries no description", () => {
    render(<ApprovalQueue approvals={[approval("sandbox_escalation")]} onResolve={() => {}} />);
    expect(screen.getByText("A run asked for full filesystem and network access.")).toBeDefined();
  });

  it("reports the decision with the approval id", async () => {
    const onResolve = vi.fn();
    const user = userEvent.setup();
    render(
      <ApprovalQueue
        approvals={[approval("manual_verification"), approval("spend")]}
        onResolve={onResolve}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: /Approve/ })[0] as HTMLElement);
    expect(onResolve).toHaveBeenCalledWith("ap_manual_verification", "approved");

    await user.click(screen.getAllByRole("button", { name: /Reject/ })[1] as HTMLElement);
    expect(onResolve).toHaveBeenCalledWith("ap_spend", "rejected");
  });

  it("disables only the row that is being resolved", () => {
    render(
      <ApprovalQueue
        approvals={[approval("merge"), approval("spend")]}
        busyId="ap_merge"
        onResolve={() => {}}
      />,
    );

    const buttons = screen.getAllByRole("button", { name: /Approve/ }) as HTMLButtonElement[];
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[1]?.disabled).toBe(false);
  });
});
