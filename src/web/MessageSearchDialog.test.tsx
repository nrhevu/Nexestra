// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../shared/contracts.js";
import {
  MessageSearchDialog,
  type MessageSearchHit,
  type MessageSearchResponse,
} from "./MessageSearchDialog.js";

const now = "2026-09-09T00:00:00.000Z";

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-active",
    workspaceId: "ws-1",
    name: "Active thread",
    slug: "active-thread",
    createdAt: now,
    updatedAt: now,
    messageCount: 2,
    lastMessageAt: now,
    archived: false,
    ...overrides,
  };
}

const activeThread = thread();
const archivedThread = thread({
  id: "thread-archived",
  name: "Old log",
  slug: "old-log",
  archived: true,
});

function hit(overrides: Partial<MessageSearchHit> = {}): MessageSearchHit {
  return {
    messageId: "msg-1",
    sequence: 2,
    thread: {
      id: archivedThread.id,
      name: archivedThread.name,
      slug: archivedThread.slug,
      archived: true,
    },
    author: { kind: "agent", id: "agent-1", name: "Ada", handle: "ada" },
    createdAt: now,
    snippet: "<script>alert(1)</script> deploy plan",
    ...overrides,
  };
}

function searchResponse(overrides: Partial<MessageSearchResponse> = {}): MessageSearchResponse {
  return {
    query: { term: "wire", workspaceId: "ws-1", threadId: null, archived: "all" },
    matches: [],
    matchesFound: 0,
    complete: true,
    nextOffset: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferredResponse() {
  let resolve: (response: Response) => void = () => {};
  const promise = new Promise<Response>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MessageSearchDialog", () => {
  it("is an accessible modal that focuses the query and closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <MessageSearchDialog
        workspaceId="ws-1"
        threads={[]}
        onClose={onClose}
        onOpenMessage={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Search messages" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveFocus();
    expect(screen.getByRole("searchbox")).toHaveAttribute("maxlength", "200");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps focus on the focused control when a parent rerender changes onClose", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(searchResponse({ matches: [hit()], matchesFound: 1 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = render(
      <MessageSearchDialog
        workspaceId="ws-1"
        threads={[]}
        initialQuery="wire"
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: /Old log/ });
    const threadSelect = screen.getByLabelText("Thread") as HTMLSelectElement;
    threadSelect.focus();
    expect(threadSelect).toHaveFocus();
    view.rerender(
      <MessageSearchDialog
        workspaceId="ws-1"
        threads={[]}
        initialQuery="wire"
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );
    expect(threadSelect).toHaveFocus();
  });

  it("sends thread and archive filters and opens the archived result with stable IDs", async () => {
    const openMessage = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.searchParams.get("q") === "wire" &&
        url.searchParams.get("workspaceId") === "ws-1" &&
        url.searchParams.get("threadId") === archivedThread.id &&
        url.searchParams.get("archived") === "archived" &&
        url.searchParams.get("limit") === "50" &&
        url.searchParams.get("offset") === null
      ) {
        return jsonResponse(
          searchResponse({
            query: {
              term: "wire",
              workspaceId: "ws-1",
              threadId: archivedThread.id,
              archived: "archived",
            },
            matches: [hit()],
            matchesFound: 1,
          }),
        );
      }
      return jsonResponse({ error: { message: "Unexpected request" } }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <MessageSearchDialog
        workspaceId="ws-1"
        threads={[
          archivedThread,
          activeThread,
          thread({ id: "thread-other", workspaceId: "ws-2", name: "Other workspace" }),
        ]}
        onClose={vi.fn()}
        onOpenMessage={openMessage}
      />,
    );

    expect(screen.queryByRole("option", { name: "Other workspace" })).not.toBeInTheDocument();

    await user.type(screen.getByRole("searchbox"), "wire");
    await user.selectOptions(screen.getByLabelText("Thread"), archivedThread.id);
    await user.selectOptions(screen.getByLabelText("Archive status"), "archived");
    await user.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const result = await screen.findByRole("button", { name: /Old log/ });
    expect(within(result).getByText("Archived")).toBeInTheDocument();
    expect(within(result).getByText("Ada (ada)")).toBeInTheDocument();
    expect(within(result).getByText(new Date(now).toLocaleString())).toBeInTheDocument();
    expect(within(result).getByText("<script>alert(1)</script> deploy plan")).toBeInTheDocument();

    await user.click(result);
    expect(openMessage).toHaveBeenCalledWith(archivedThread.id, "msg-1");
  });

  it("auto-searches once for a nonempty initial query", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.searchParams.get("q") === "wire") {
        return jsonResponse(searchResponse({ matches: [hit()], matchesFound: 1 }));
      }
      return jsonResponse({ error: { message: "Unexpected request" } }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MessageSearchDialog
        workspaceId="ws-1"
        threads={[]}
        initialQuery="wire"
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: /Old log/ })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("searchbox")).toHaveValue("wire");
  });

  it("never requests with an empty query", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <MessageSearchDialog
        workspaceId="ws-1"
        threads={[]}
        initialQuery="   "
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    await user.type(screen.getByRole("searchbox"), "   ");
    await user.keyboard("{Enter}");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows loading, surfaces errors, and retries the same search", async () => {
    const first = deferredResponse();
    let calls = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL) => {
      calls += 1;
      if (calls === 1) return first.promise;
      return Promise.resolve(jsonResponse(searchResponse({ matches: [hit()], matchesFound: 1 })));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <MessageSearchDialog
        workspaceId="ws-1"
        threads={[]}
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("searchbox"), "wire");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByText("Searching messages…")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(jsonResponse({ error: { message: "Backend exploded" } }, 500));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Backend exploded");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: /Old log/ })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("distinguishes complete no-results from partial scans", async () => {
    let partial = false;
    const fetchMock = vi.fn(async () => {
      if (partial) {
        return jsonResponse(
          searchResponse({
            matches: [hit()],
            matchesFound: 7,
            complete: false,
            nextOffset: 50,
          }),
        );
      }
      return jsonResponse(searchResponse({ matches: [], matchesFound: 0, complete: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <MessageSearchDialog
        workspaceId="ws-1"
        threads={[]}
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("searchbox"), "wire");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("No messages matched your search.")).toBeInTheDocument();
    expect(screen.queryByText(/Results are partial/)).not.toBeInTheDocument();

    partial = true;
    await user.type(screen.getByRole("searchbox"), "2");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(
      await screen.findByText("Results may be incomplete. Try narrowing the search to a thread."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(screen.getByText("At least 7 matches in the scanned portion")).toBeInTheDocument();
    expect(screen.queryByText("No messages matched your search.")).not.toBeInTheDocument();
  });

  it("pages with nextOffset when present and appends results", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.searchParams.get("offset") === "50") {
        expect(url.searchParams.get("threadId")).toBeNull();
        expect(url.searchParams.get("archived")).toBe("all");
        return jsonResponse(
          searchResponse({
            matches: [
              hit({
                messageId: "msg-1",
                snippet: "first page result",
                thread: {
                  id: activeThread.id,
                  name: activeThread.name,
                  slug: activeThread.slug,
                  archived: false,
                },
              }),
              hit({
                messageId: "msg-2",
                snippet: "second page result",
                thread: {
                  id: activeThread.id,
                  name: activeThread.name,
                  slug: activeThread.slug,
                  archived: false,
                },
              }),
            ],
            matchesFound: 3,
            nextOffset: null,
          }),
        );
      }
      return jsonResponse(
        searchResponse({
          matches: [
            hit({
              messageId: "msg-1",
              snippet: "first page result",
              thread: {
                id: activeThread.id,
                name: activeThread.name,
                slug: activeThread.slug,
                archived: false,
              },
            }),
          ],
          matchesFound: 3,
          nextOffset: 50,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <MessageSearchDialog
        workspaceId="ws-1"
        threads={[]}
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("searchbox"), "wire");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("first page result")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("second page result")).toBeInTheDocument();
    expect(screen.getAllByText("first page result")).toHaveLength(1);
    expect(screen.getByText("first page result")).toBeInTheDocument();
    expect(screen.getByText("3 matches")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("clears results and errors on form edits and submits the current fields", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calls += 1;
      const url = new URL(String(input), "http://localhost");
      if (calls === 1) {
        return jsonResponse(searchResponse({ matches: [hit()], matchesFound: 1 }));
      }
      if (
        calls === 2 &&
        url.searchParams.get("q") === "new" &&
        url.searchParams.get("threadId") === archivedThread.id &&
        url.searchParams.get("archived") === "archived"
      ) {
        return jsonResponse(
          searchResponse({
            query: {
              term: "new",
              workspaceId: "ws-1",
              threadId: archivedThread.id,
              archived: "archived",
            },
            matches: [hit({ messageId: "msg-2", snippet: "fresh result" })],
            matchesFound: 1,
          }),
        );
      }
      return jsonResponse({ error: { message: "Unexpected request" } }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    let view = render(
      <MessageSearchDialog
        workspaceId="ws-1"
        threads={[archivedThread, activeThread]}
        initialQuery="old"
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );
    expect(await screen.findByRole("button", { name: /Old log/ })).toBeInTheDocument();
    const input = screen.getByRole("searchbox");
    await user.clear(input);
    await user.type(input, "new");
    expect(screen.queryByRole("button", { name: /Old log/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Thread"), archivedThread.id);
    await user.selectOptions(screen.getByLabelText("Archive status"), "archived");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("fresh result")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    view.unmount();

    const errorFetch = vi.fn(async () =>
      jsonResponse({ error: { message: "Backend exploded" } }, 500),
    );
    vi.stubGlobal("fetch", errorFetch);
    view = render(
      <MessageSearchDialog
        workspaceId="ws-1"
        threads={[]}
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );
    await user.type(screen.getByRole("searchbox"), "old");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Backend exploded");
    await user.type(screen.getByRole("searchbox"), "now");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    view.unmount();
  });

  it("filters thread options to the workspace and resets the selected thread on workspace change", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(searchResponse())),
    );
    const user = userEvent.setup();
    const view = render(
      <MessageSearchDialog
        workspaceId="ws-1"
        threads={[activeThread]}
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: "Active thread" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Thread"), activeThread.id);
    expect(screen.getByLabelText("Thread")).toHaveValue(activeThread.id);
    const otherThread = thread({
      id: "thread-other",
      workspaceId: "ws-2",
      name: "Other workspace",
    });
    view.rerender(
      <MessageSearchDialog
        workspaceId="ws-2"
        threads={[otherThread]}
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );
    const select = screen.getByLabelText("Thread") as HTMLSelectElement;
    expect(select).toHaveValue("");
    expect(screen.queryByRole("option", { name: "Active thread" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Other workspace" })).toBeInTheDocument();
  });

  it("discards late responses after query changes, workspace switches, and unmount", async () => {
    const user = userEvent.setup();

    const staleQuery = deferredResponse();
    const staleQueryFetch = vi.fn(() => staleQuery.promise);
    vi.stubGlobal("fetch", staleQueryFetch);
    let view = render(
      <MessageSearchDialog
        workspaceId="ws-1"
        threads={[]}
        initialQuery="old"
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );
    await waitFor(() => expect(staleQueryFetch).toHaveBeenCalledTimes(1));
    await user.type(screen.getByRole("searchbox"), "new");
    await act(async () => {
      staleQuery.resolve(jsonResponse(searchResponse({ matches: [hit()], matchesFound: 1 })));
    });
    expect(screen.queryByRole("button", { name: /Old log/ })).not.toBeInTheDocument();
    view.unmount();

    const staleWorkspace = deferredResponse();
    const staleWorkspaceFetch = vi.fn(() => staleWorkspace.promise);
    vi.stubGlobal("fetch", staleWorkspaceFetch);
    view = render(
      <MessageSearchDialog
        workspaceId="ws-1"
        threads={[]}
        initialQuery="old"
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );
    await waitFor(() => expect(staleWorkspaceFetch).toHaveBeenCalledTimes(1));
    view.rerender(
      <MessageSearchDialog
        workspaceId="ws-2"
        threads={[]}
        initialQuery="old"
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );
    await act(async () => {
      staleWorkspace.resolve(jsonResponse(searchResponse({ matches: [hit()], matchesFound: 1 })));
    });
    expect(screen.queryByRole("button", { name: /Old log/ })).not.toBeInTheDocument();
    view.unmount();

    let signal: AbortSignal | null | undefined;
    const unmountDeferred = deferredResponse();
    const unmountFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return unmountDeferred.promise;
    });
    vi.stubGlobal("fetch", unmountFetch);
    view = render(
      <MessageSearchDialog
        workspaceId="ws-1"
        threads={[]}
        initialQuery="old"
        onClose={vi.fn()}
        onOpenMessage={vi.fn()}
      />,
    );
    await waitFor(() => expect(unmountFetch).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      unmountDeferred.resolve(jsonResponse(searchResponse({ matches: [hit()], matchesFound: 1 })));
    });
  });
});
