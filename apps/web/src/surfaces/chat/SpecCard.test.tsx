import type { Spec } from "@nexestra/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SpecCard } from "./SpecCard.js";

const SPEC: Spec = {
  id: "spec_1",
  workspaceId: "ws_1",
  threadId: "th_1",
  version: 3,
  goal: "A todo CLI over the existing store",
  scope: { in: ["add / list / done commands"], out: ["A graphical client"] },
  constraints: ["Node 24, no new runtime dependency"],
  expectedOutcome: "A working `todo` command on PATH",
  acceptanceCriteria: [
    {
      id: "ac_tests",
      text: "The suite passes with the new behaviour covered.",
      verification: { kind: "test", command: "pnpm test" },
      satisfied: false,
    },
    {
      id: "ac_docs",
      text: "The CLI is documented in the README.",
      verification: { kind: "manual_review", instructions: "Read the README next to the diff." },
      satisfied: true,
      evidenceArtifactId: "art_1",
    },
  ],
  openQuestions: [
    { id: "q_done", question: "Anything else before I plan?", options: [] },
    { id: "q_scope", question: "Which package?", options: [], answer: "the CLI one" },
  ],
  decisions: [],
  frozen: false,
  createdAt: "2026-09-02T09:00:00.000Z",
  updatedAt: "2026-09-02T09:05:00.000Z",
};

describe("SpecCard", () => {
  it("shows the goal, the scope and the constraints", () => {
    render(<SpecCard spec={SPEC} />);
    expect(screen.getByText("A todo CLI over the existing store")).toBeDefined();
    expect(screen.getByText("A working `todo` command on PATH")).toBeDefined();
    expect(screen.getByText("add / list / done commands")).toBeDefined();
    expect(screen.getByText("A graphical client")).toBeDefined();
    expect(screen.getByText("Node 24, no new runtime dependency")).toBeDefined();
  });

  it("says how every acceptance criterion is proved", () => {
    render(<SpecCard spec={SPEC} />);
    expect(screen.getByText("Acceptance criteria (2)")).toBeDefined();
    expect(screen.getByText("test")).toBeDefined();
    expect(screen.getByText("pnpm test")).toBeDefined();
    // `manual_review` reads as prose, and shows the instructions as its proof.
    expect(screen.getByText("manual review")).toBeDefined();
    expect(screen.getByText("Read the README next to the diff.")).toBeDefined();
  });

  it("marks a criterion that already has evidence", () => {
    const { container } = render(<SpecCard spec={SPEC} />);
    const bullets = [...container.querySelectorAll(".spec__bullet")].map(
      (node) => node.textContent,
    );
    expect(bullets).toContain("[ ]");
    expect(bullets).toContain("[x]");
  });

  it("lists only the questions still waiting on an answer", () => {
    render(<SpecCard spec={SPEC} />);
    expect(screen.getByText("Open questions (1)")).toBeDefined();
    expect(screen.getByText("Anything else before I plan?")).toBeDefined();
    expect(screen.queryByText("Which package?")).toBeNull();
  });

  it("distinguishes a draft from a frozen spec", () => {
    const { rerender } = render(<SpecCard spec={SPEC} />);
    expect(screen.getByText("draft")).toBeDefined();
    expect(screen.getByText("v3")).toBeDefined();

    rerender(<SpecCard spec={{ ...SPEC, frozen: true }} />);
    expect(screen.getByText("frozen")).toBeDefined();
  });

  it("drops the card chrome in the sidebar", () => {
    const { container } = render(<SpecCard spec={SPEC} bare />);
    expect(container.querySelector(".card")).toBeNull();
    expect(container.querySelector(".spec--bare")).not.toBeNull();
    expect(screen.getByText("A todo CLI over the existing store")).toBeDefined();
  });
});
