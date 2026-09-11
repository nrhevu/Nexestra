// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationFilterControls,
  type ConversationFilterControlsProps,
} from "./ConversationFilterControls.js";

function makeProps(
  overrides: Partial<ConversationFilterControlsProps> = {},
): ConversationFilterControlsProps {
  return {
    filter: "all",
    onFilterChange: vi.fn(),
    unreadConversationCount: 3,
    onNextUnread: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConversationFilterControls", () => {
  it("renders a labeled group with stable toggle labels and the unread conversation count", () => {
    render(<ConversationFilterControls {...makeProps()} />);

    expect(screen.getByRole("group", { name: "Conversation filter" })).toBeInTheDocument();
    const all = screen.getByRole("button", { name: "All conversations" });
    const unread = screen.getByRole("button", { name: "Unread conversations" });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(unread).toHaveAttribute("aria-pressed", "false");
    expect(all).toHaveTextContent("All");
    expect(unread).toHaveTextContent("Unread");
    expect(unread).toHaveTextContent("3");
  });

  it("toggles filters while keeping accessible names stable", async () => {
    const user = userEvent.setup();
    const props = makeProps({ filter: "all" });
    const view = render(<ConversationFilterControls {...props} />);

    await user.click(screen.getByRole("button", { name: "Unread conversations" }));
    expect(props.onFilterChange).toHaveBeenCalledExactlyOnceWith("unread");

    view.rerender(<ConversationFilterControls {...props} filter="unread" />);
    expect(screen.getByRole("button", { name: "All conversations" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Unread conversations" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "All conversations" }));
    expect(props.onFilterChange).toHaveBeenLastCalledWith("all");
  });

  it("disables next and shows a zero count when no conversation is unread, then enables it", async () => {
    const user = userEvent.setup();
    const props = makeProps({ unreadConversationCount: 0 });
    const view = render(<ConversationFilterControls {...props} />);

    const unread = screen.getByRole("button", { name: "Unread conversations" });
    const next = screen.getByRole("button", { name: "Next unread conversation" });
    expect(unread).toHaveTextContent("0");
    expect(next).toBeDisabled();
    expect(next).toHaveAttribute("title", expect.stringContaining("/next unread"));
    await user.click(next);
    expect(props.onNextUnread).not.toHaveBeenCalled();

    view.rerender(<ConversationFilterControls {...props} unreadConversationCount={2} />);
    expect(screen.getByRole("button", { name: "Unread conversations" })).toHaveTextContent("2");
    expect(next).toBeEnabled();
    await user.click(next);
    expect(props.onNextUnread).toHaveBeenCalledTimes(1);
  });
});
