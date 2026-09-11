// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationReadControls } from "./ConversationReadControls.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConversationReadControls", () => {
  it("renders a labelled toolbar with fixed accessible button names", () => {
    render(
      <ConversationReadControls unreadCount={3} onFirstUnread={vi.fn()} onMarkRead={vi.fn()} />,
    );
    expect(
      screen.getByRole("toolbar", { name: "Current conversation read controls" }),
    ).toBeInTheDocument();
    const first = screen.getByRole("button", { name: "First unread message" });
    const mark = screen.getByRole("button", { name: "Mark conversation read" });
    expect(first).toHaveTextContent("First unread");
    expect(mark).toHaveTextContent("Mark read");
  });

  it("describes unread messages with singular and plural count text", () => {
    const { rerender } = render(
      <ConversationReadControls unreadCount={1} onFirstUnread={vi.fn()} onMarkRead={vi.fn()} />,
    );
    expect(screen.getByText("1 unread message")).toBeInTheDocument();
    rerender(
      <ConversationReadControls unreadCount={4} onFirstUnread={vi.fn()} onMarkRead={vi.fn()} />,
    );
    expect(screen.getByText("4 unread messages")).toBeInTheDocument();
  });

  it("fires both callbacks while enabled for a positive integer count", async () => {
    const user = userEvent.setup();
    const onFirstUnread = vi.fn();
    const onMarkRead = vi.fn();
    render(
      <ConversationReadControls
        unreadCount={2}
        onFirstUnread={onFirstUnread}
        onMarkRead={onMarkRead}
      />,
    );
    const first = screen.getByRole("button", { name: "First unread message" });
    const mark = screen.getByRole("button", { name: "Mark conversation read" });
    expect(first).toBeEnabled();
    expect(mark).toBeEnabled();
    await user.click(first);
    await user.click(mark);
    expect(onFirstUnread).toHaveBeenCalledTimes(1);
    expect(onMarkRead).toHaveBeenCalledTimes(1);
  });

  it("disables both buttons for non-positive, fractional, infinite, and NaN counts", async () => {
    const user = userEvent.setup();
    for (const value of [0, -1, 2.5, Infinity, NaN]) {
      const onFirstUnread = vi.fn();
      const onMarkRead = vi.fn();
      const { unmount } = render(
        <ConversationReadControls
          unreadCount={value}
          onFirstUnread={onFirstUnread}
          onMarkRead={onMarkRead}
        />,
      );
      const first = screen.getByRole("button", { name: "First unread message" });
      const mark = screen.getByRole("button", { name: "Mark conversation read" });
      expect(first).toBeDisabled();
      expect(mark).toBeDisabled();
      await user.click(first);
      await user.click(mark);
      expect(onFirstUnread).not.toHaveBeenCalled();
      expect(onMarkRead).not.toHaveBeenCalled();
      expect(screen.getByText("No unread messages")).toBeInTheDocument();
      unmount();
    }
  });

  it("activates both actions with keyboard navigation", async () => {
    const user = userEvent.setup();
    const onFirstUnread = vi.fn();
    const onMarkRead = vi.fn();
    render(
      <ConversationReadControls
        unreadCount={5}
        onFirstUnread={onFirstUnread}
        onMarkRead={onMarkRead}
      />,
    );
    await user.tab();
    await user.keyboard("{Enter}");
    expect(onFirstUnread).toHaveBeenCalledTimes(1);
    await user.tab();
    await user.keyboard("{ }");
    expect(onMarkRead).toHaveBeenCalledTimes(1);
  });
});
