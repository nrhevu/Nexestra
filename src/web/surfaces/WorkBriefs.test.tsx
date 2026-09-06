// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BootstrapData, WorkBrief } from "../../shared/contracts.js";
import { WorkBriefs } from "./WorkBriefs.js";

const now = "2026-09-06T18:00:00Z";
const workspace = {
  id: "workspace",
  name: "Product",
  slug: "product",
  createdAt: now,
  updatedAt: now,
};
const thread = {
  id: "thread",
  workspaceId: workspace.id,
  name: "Research",
  slug: "research",
  createdAt: now,
  updatedAt: now,
  messageCount: 0,
  lastMessageAt: null,
};
const brief: WorkBrief = {
  title: "Understand our audience",
  kind: "research",
  outcome: "Choose a launch audience",
  deliverables: ["A recommendation memo"],
  constraints: "Use primary sources",
  nonGoals: "No code",
  acceptanceCriteria: [
    {
      behavior: "Every factual claim has a citation",
      verification: "Open each source and compare it with the claim",
    },
  ],
  openQuestions: "",
  threadId: thread.id,
  workspaceId: workspace.id,
  revision: 1,
  status: "draft",
  updatedAt: now,
  updatedBy: { kind: "user", id: "local-user" },
  confirmedAt: null,
};
const data: BootstrapData = {
  workspace,
  workspaces: [workspace],
  threads: [thread],
  workBriefs: [],
  surfaces: [],
  goals: [],
  agents: [],
  knowledge: [],
  tasks: [],
  assignments: [],
  activeRuns: [],
  runtime: {
    chatgpt: { installed: false, connected: false, message: "Offline" },
    harnesses: {
      codex: { installed: false, version: null },
      opencode: { installed: false, version: null },
    },
  },
  workspacePath: "/workspace",
  dataPath: "/workspace/.nexestra",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Work briefs surface", () => {
  it("creates a research brief with paired checks and confirms only the saved revision", async () => {
    const user = userEvent.setup();
    let current = brief;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const content = JSON.parse(String(init.body));
      current =
        init.method === "PUT"
          ? { ...brief, ...content, revision: 1 }
          : { ...current, revision: 2, status: "confirmed", confirmedAt: now };
      return new Response(JSON.stringify(current));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkBriefs data={data} onChanged={async () => undefined} onThread={() => undefined} />);
    expect(screen.getByRole("button", { name: "Confirm scope" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Type of work"), "research");
    await user.type(screen.getByLabelText(/Desired outcome/), "Choose a launch audience");
    await user.type(screen.getByLabelText(/Deliverables/), "A recommendation memo\n");
    await user.click(screen.getByRole("button", { name: "Add criterion" }));
    await user.type(screen.getByLabelText("Success criterion 1"), "Claims have citations");
    await user.type(screen.getByLabelText("How to check 1"), "Review each cited source");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirm scope" })).toBeEnabled(),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))).toMatchObject({
      expectedRevision: 0,
      kind: "research",
      deliverables: ["A recommendation memo"],
      acceptanceCriteria: [
        { behavior: "Claims have citations", verification: "Review each cited source" },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Confirm scope" }));
    await screen.findByText("Scope confirmed");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/threads/thread/brief/confirm");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1].body))).toEqual({ expectedRevision: 1 });
    await user.type(screen.getByLabelText(/Desired outcome/), " in Vietnam");
    expect(screen.getByRole("button", { name: "Confirm scope" })).toBeDisabled();
  });

  it("preserves local edits on a conflict and reloads the current revision only on request", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      init.method === "PUT"
        ? new Response(
            JSON.stringify({
              error: {
                message: "This brief changed. Reload it and reconcile your edits before saving.",
              },
            }),
            { status: 409 },
          )
        : new Response(
            JSON.stringify({ workBrief: { ...brief, title: "Updated by an agent", revision: 2 } }),
          ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <WorkBriefs
        data={{ ...data, workBriefs: [brief] }}
        onChanged={async () => undefined}
        onThread={() => undefined}
      />,
    );
    await user.clear(screen.getByLabelText("Brief title"));
    await user.type(screen.getByLabelText("Brief title"), "My local draft");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This brief changed");
    expect(screen.getByLabelText("Brief title")).toHaveValue("My local draft");
    await user.click(screen.getByRole("button", { name: "Reload latest" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Brief title")).toHaveValue("Updated by an agent"),
    );
    expect(screen.getByText(/Revision 2/)).toBeInTheDocument();
  });

  it("keeps remaining criteria intact after removing a middle row", async () => {
    const user = userEvent.setup();
    render(
      <WorkBriefs
        data={{ ...data, workBriefs: [brief] }}
        onChanged={async () => undefined}
        onThread={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add criterion" }));
    await user.click(screen.getByRole("button", { name: "Add criterion" }));
    await user.type(screen.getByLabelText("Success criterion 3"), "A final recommendation");
    await user.type(screen.getByLabelText("How to check 3"), "Human review");
    await user.click(screen.getByRole("button", { name: "Remove criterion 2" }));
    expect(screen.getByLabelText("Success criterion 2")).toHaveValue("A final recommendation");
    expect(screen.getByLabelText("How to check 2")).toHaveValue("Human review");
  });
});
