// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomSurface } from "../shared/contracts.js";
import { CustomSurfaceView } from "./CustomSurfaceView.js";

afterEach(cleanup);

const surface: CustomSurface = {
  id: "inference",
  title: "Inference lab",
  description: "A focused workspace for model experiments.",
  cards: [
    {
      id: "profiles",
      title: "Model profiles",
      description: "Compare configured agents and costs.",
      action: "agents",
    },
    { id: "runs", title: "Active runs", description: "", action: "runs" },
    { id: "reviews", title: "Needs-work", description: "", action: "reviews" },
  ],
};

describe("CustomSurfaceView", () => {
  it("renders configured cards and dispatches their safe built-in action", async () => {
    const onAction = vi.fn();
    render(
      <CustomSurfaceView
        surface={surface}
        counts={{ agents: 3, runs: 2, reviews: 4 }}
        onAction={onAction}
      />,
    );
    expect(screen.getByRole("heading", { name: "Inference lab" })).toBeVisible();
    expect(screen.getByText("Compare configured agents and costs.")).toBeVisible();
    expect(screen.getByText("3 matching items")).toBeVisible();
    expect(screen.getByText("2 matching items")).toBeVisible();
    expect(screen.getByText("4 matching items")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open Agents" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("agents");
  });
});
