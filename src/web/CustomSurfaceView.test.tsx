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
  ],
};

describe("CustomSurfaceView", () => {
  it("renders configured cards and dispatches their safe built-in action", async () => {
    const onAction = vi.fn();
    render(<CustomSurfaceView surface={surface} onAction={onAction} />);
    expect(screen.getByRole("heading", { name: "Inference lab" })).toBeVisible();
    expect(screen.getByText("Compare configured agents and costs.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open Agents" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("agents");
  });
});
