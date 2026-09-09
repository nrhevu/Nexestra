// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeItem, Task, Thread } from "../shared/contracts.js";
import { TopBar, type TopBarProps } from "./TopBar.js";

const now = "2026-09-08T12:00:00.000Z";
const firstThread: Thread = {
  id: "thread-planning",
  workspaceId: "workspace-one",
  name: "Alpha planning",
  slug: "alpha-planning",
  createdAt: now,
  updatedAt: now,
  messageCount: 1,
  lastMessageAt: now,
  archived: false,
};
const secondThread: Thread = {
  ...firstThread,
  id: "thread-review",
  name: "Alpha review",
  slug: "alpha-review",
};
const task: Task = {
  id: "task-plan",
  workspaceId: "workspace-one",
  title: "Prepare Alpha plan",
  description: "Plan the next release.",
  status: "todo",
  assigneeId: null,
  threadId: firstThread.id,
  verificationCommand: "",
  createdAt: now,
  updatedAt: now,
};
const document: KnowledgeItem = {
  id: "knowledge-guide",
  workspaceId: "workspace-one",
  name: "Alpha Guide",
  handle: "alpha-guide",
  description: "Release notes and decisions.",
  kind: "document",
  fileName: "guide.md",
  mediaType: "text/markdown",
  size: 12,
  storagePath: "knowledge/guide/document",
  revisions: [],
  createdAt: now,
  updatedAt: now,
};
const repository: KnowledgeItem = {
  id: "knowledge-repository",
  workspaceId: "workspace-one",
  name: "Alpha Source",
  handle: "alpha-source",
  description: "The project repository.",
  kind: "repository",
  source: "/workspace/alpha",
  storagePath: "repositories/alpha/source",
  status: "ready",
  createdAt: now,
  updatedAt: now,
};

function makeProps(overrides: Partial<TopBarProps> = {}): TopBarProps {
  return {
    data: { threads: [firstThread, secondThread], tasks: [], agents: [], knowledge: [] },
    theme: "dark",
    refreshStatus: "idle" as const,
    onRefresh: vi.fn(),
    onMarkAllRead: vi.fn(),
    onThemeToggle: vi.fn(),
    onThread: vi.fn(),
    onSurface: vi.fn(),
    onTask: vi.fn(),
    onKnowledge: vi.fn(),
    onSearchMessages: vi.fn(),
    onSettings: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Global search", () => {
  it.each(["/runs", "/run history"])("opens workspace run history with %s", async (command) => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<TopBar {...props} />);
    const input = screen.getByRole("combobox");
    await user.type(input, command);
    expect(screen.getByRole("option", { name: /Run history/ })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(props.onSurface).toHaveBeenCalledExactlyOnceWith("runs");
    expect(props.onThread).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
  });

  it("supports the shortcut and wraps keyboard selection while focus stays in the combobox", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<TopBar {...props} />);
    const input = screen.getByRole("combobox");

    expect(input).not.toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{Meta>}k{/Meta}");
    expect(input).toHaveFocus();
    await user.type(input, "Alpha");

    const options = screen.getAllByRole("option");
    const listbox = screen.getByRole("listbox", { name: "Search results" });
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[0]?.id);

    await user.keyboard("{ArrowDown}");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}{Enter}");

    expect(props.onThread).toHaveBeenCalledExactlyOnceWith(secondThread.id);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("dismisses without clearing the query and reopens with arrows or Ctrl+K", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<TopBar {...props} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "Alpha");
    await user.keyboard("{Escape}{Enter}");

    expect(input).toHaveFocus();
    expect(input).toHaveValue("Alpha");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(props.onThread).not.toHaveBeenCalled();
    await user.keyboard("{ArrowUp}");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Switch to light theme" }));
    await user.keyboard("{Control>}k{/Control}");

    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect((input as HTMLInputElement).selectionStart).toBe(0);
    expect((input as HTMLInputElement).selectionEnd).toBe(5);
  });

  it("resets selection when either the query or the result records change", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    const view = render(<TopBar {...props} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "Alph");
    await user.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("a");
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowDown}");
    view.rerender(
      <TopBar {...props} data={{ ...props.data, threads: [secondThread, firstThread] }} />,
    );
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveFocus();

    view.rerender(<TopBar {...props} data={{ ...props.data, threads: [] }} />);
    expect(input).not.toHaveAttribute("aria-activedescendant");
    expect(screen.getByRole("status")).toHaveTextContent("No results found.");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(props.onThread).not.toHaveBeenCalled();
  });

  it("opens the exact task from a mouse result without navigating to the whole board", async () => {
    const user = userEvent.setup();
    const props = makeProps({
      data: { threads: [firstThread], agents: [], tasks: [task], knowledge: [] },
    });
    render(<TopBar {...props} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "plan");
    await user.click(screen.getByRole("option", { name: `${task.title} Task` }));

    expect(props.onTask).toHaveBeenCalledExactlyOnceWith(task.id);
    expect(props.onThread).not.toHaveBeenCalled();
    expect(props.onSurface).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it.each([document, repository])(
    "opens the exact $kind knowledge record from search",
    async (item) => {
      const user = userEvent.setup();
      const props = makeProps({
        data: { threads: [], agents: [], tasks: [], knowledge: [document, repository] },
      });
      render(<TopBar {...props} />);
      await user.type(screen.getByRole("combobox"), item.name);
      await user.keyboard("{Enter}");

      expect(props.onKnowledge).toHaveBeenCalledExactlyOnceWith(item.id);
      expect(props.onSurface).not.toHaveBeenCalled();
    },
  );

  it("preserves slash commands and makes Attention available from the keyboard", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    const onNewTask = vi.fn();
    window.document.addEventListener("nexestra:new-task", onNewTask);
    render(<TopBar {...props} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "/new task");
    await user.keyboard("{Enter}");
    window.document.removeEventListener("nexestra:new-task", onNewTask);

    expect(onNewTask).toHaveBeenCalledOnce();
    await user.type(input, "/attention");
    await user.keyboard("{Enter}");
    expect(props.onSurface).toHaveBeenCalledExactlyOnceWith("attention");
  });

  it("opens message search with the entered phrase and supports a search command", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<TopBar {...props} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "  Ship on Friday  ");
    await user.click(screen.getByRole("button", { name: "Search messages" }));
    expect(props.onSearchMessages).toHaveBeenCalledExactlyOnceWith("Ship on Friday");
    expect(input).toHaveAttribute("aria-expanded", "false");

    await user.clear(input);
    await user.type(input, "/search messages");
    await user.keyboard("{Enter}");
    expect(props.onSearchMessages).toHaveBeenLastCalledWith("");
    expect(input).toHaveValue("");
  });

  it("allows Tab to leave search and does not execute Enter during text composition", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    const view = render(<TopBar {...props} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "Alpha");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(props.onThread).not.toHaveBeenCalled();

    await user.tab();
    const refresh = screen.getByRole("button", { name: "Refresh workspace" });
    expect(refresh).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "false");
    await user.tab();
    const searchMessages = screen.getByRole("button", { name: "Search messages" });
    expect(searchMessages).toHaveFocus();
    view.rerender(<TopBar {...props} data={{ ...props.data, threads: [secondThread] }} />);
    expect(searchMessages).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps the global shortcut from moving focus outside an open modal", async () => {
    const user = userEvent.setup();
    render(
      <>
        <TopBar {...makeProps()} />
        <section role="dialog" aria-modal="true" aria-label="Find messages">
          <input aria-label="Message phrase" />
        </section>
      </>,
    );
    const phrase = screen.getByRole("textbox", { name: "Message phrase" });
    await user.click(phrase);
    await user.keyboard("{Control>}k{/Control}");
    expect(phrase).toHaveFocus();
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "false");
  });
});

describe("Workspace refresh action", () => {
  it("runs the manual refresh and announces an in-progress state", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    const view = render(<TopBar {...props} />);
    const refresh = screen.getByRole("button", { name: "Refresh workspace" });
    await user.click(refresh);
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveAttribute("aria-busy", "false");

    view.rerender(<TopBar {...props} refreshStatus="refreshing" />);
    expect(refresh).toHaveAttribute("aria-busy", "true");
  });

  it("shows an actionable retry status after a failed refresh and clears it on success", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    const view = render(<TopBar {...props} refreshStatus="error" refreshError="Network down" />);
    expect(screen.getByRole("status")).toHaveTextContent("Network down");
    expect(screen.getByRole("button", { name: "Refresh workspace" })).toHaveAccessibleDescription(
      "Network down",
    );
    await user.click(screen.getByRole("button", { name: "Refresh workspace" }));
    expect(props.onRefresh).toHaveBeenCalled();
    view.rerender(<TopBar {...props} refreshStatus="idle" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh workspace" })).not.toHaveAttribute(
      "aria-describedby",
    );
  });

  it("exposes a /refresh command from the palette", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<TopBar {...props} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "/refresh");
    const option = screen.getByRole("option", { name: /Refresh workspace/ });
    await user.keyboard("{Enter}");
    expect(option).not.toBeInTheDocument();
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });

  it("exposes a /mark all read command from the palette", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<TopBar {...props} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "/mark all read");
    const option = screen.getByRole("option", { name: /Mark all conversations read/ });
    await user.keyboard("{Enter}");
    expect(option).not.toBeInTheDocument();
    expect(props.onMarkAllRead).toHaveBeenCalledTimes(1);
  });
});

describe("Next unread command", () => {
  it("runs the next-unread command from the palette with its full slash phrase", async () => {
    const user = userEvent.setup();
    const onNextUnread = vi.fn();
    const props = makeProps({ onNextUnread });
    render(<TopBar {...props} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "/next unread");
    const option = screen.getByRole("option", { name: /Next unread conversation/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(option).not.toBeInTheDocument();
    expect(onNextUnread).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue("");
  });
});

describe("Current conversation read commands", () => {
  it("runs the /first unread command from the palette with its full slash phrase", async () => {
    const user = userEvent.setup();
    const onFirstUnread = vi.fn();
    const onMarkRead = vi.fn();
    const props = makeProps({ onFirstUnread, onMarkRead });
    render(<TopBar {...props} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "/first unread");
    const option = screen.getByRole("option", { name: /First unread message/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(option).not.toBeInTheDocument();
    expect(onFirstUnread).toHaveBeenCalledTimes(1);
    expect(props.onMarkAllRead).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
  });

  it("runs the /mark read command without triggering mark-all", async () => {
    const user = userEvent.setup();
    const onFirstUnread = vi.fn();
    const onMarkRead = vi.fn();
    const props = makeProps({ onFirstUnread, onMarkRead });
    render(<TopBar {...props} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "/mark read");
    const option = screen.getByRole("option", { name: /Mark conversation read/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(option).not.toBeInTheDocument();
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onFirstUnread).not.toHaveBeenCalled();
    expect(props.onMarkAllRead).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
  });

  it("keeps /mark all read bound to mark-all only", async () => {
    const user = userEvent.setup();
    const onMarkRead = vi.fn();
    const props = makeProps({ onMarkRead });
    render(<TopBar {...props} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "/mark all read");
    const option = screen.getByRole("option", { name: /Mark all conversations read/ });
    await user.keyboard("{Enter}");
    expect(option).not.toBeInTheDocument();
    expect(props.onMarkAllRead).toHaveBeenCalledTimes(1);
    expect(onMarkRead).not.toHaveBeenCalled();
  });
});
