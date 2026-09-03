// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RichMessage } from "./RichMessage.js";

afterEach(cleanup);

describe("RichMessage", () => {
  it("renders GFM structure, links, math, and mentions without executing raw HTML", () => {
    const content = [
      "## Proposal",
      "",
      "**Hello @planner** using #architecture and `@inside-code #inside-code` with $\\gamma$.",
      "",
      "1. First item",
      "2. Second item",
      "",
      "| Part | Status |",
      "| --- | --- |",
      "| Parser | Ready |",
      "",
      "[Documentation](https://example.com/docs)",
      "",
      "<script>window.__unsafe = true</script>",
    ].join("\n");
    const { container } = render(
      <RichMessage
        content={content}
        knownHandles={new Set(["planner"])}
        knownKnowledgeHandles={new Set(["architecture"])}
      />,
    );

    expect(screen.getByRole("heading", { name: "Proposal", level: 2 })).toBeInTheDocument();
    const greeting = screen.getByText(/Hello/).closest("strong");
    expect(greeting).not.toBeNull();
    expect(within(greeting as HTMLElement).getByText("@planner").tagName).toBe("MARK");
    expect(screen.getByText("#architecture")).toHaveClass("knowledge-reference");
    expect(screen.getByText(/@inside-code/).tagName).toBe("CODE");
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(container.querySelector(".katex")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Documentation" })).toHaveAttribute("target", "_blank");
    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(screen.getByText(/<script>/)).toBeInTheDocument();
  });

  it("marks unknown mentions and keeps dangerous link schemes inert", () => {
    render(
      <RichMessage
        content={"Ask @unknown and open [unsafe](javascript:alert(1))."}
        knownHandles={new Set()}
      />,
    );

    expect(screen.getByText("@unknown")).toHaveClass("unresolved");
    expect(screen.getByText("unsafe").tagName).toBe("SPAN");
  });
});
