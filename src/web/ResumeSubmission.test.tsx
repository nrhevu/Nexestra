// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Artifact,
  BootstrapData,
  Message,
  Thread,
  ThreadData,
  ThreadHistoryPage,
} from "../shared/contracts.js";
import { App } from "./App.js";

const now = "2026-09-02T12:00:00.000Z";

const workspace = {
  id: "workspace-nexestra",
  name: "Nexestra",
  slug: "nexestra",
  createdAt: now,
  updatedAt: now,
};

function threadRow(id: string, name: string): Thread {
  return {
    id,
    name,
    slug: name,
    workspaceId: workspace.id,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    lastMessageAt: null,
    archived: false,
  };
}

function historyUrl(thread: Thread): string {
  return (
    "/api/threads/" +
    encodeURIComponent(thread.id) +
    "/history?workspaceId=" +
    encodeURIComponent(thread.workspaceId) +
    "&limit=50"
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pendingKey(workspaceId: string, threadId: string): string {
  return `nexestra.pendingSubmission.1.${workspaceId}:${threadId}`;
}

function uploadFile(name: string): File {
  return new File(["diagram"], name, { type: "image/png" });
}

async function fileText(file: File): Promise<string> {
  return new TextDecoder().decode(await file.arrayBuffer());
}

const bootstrapData: BootstrapData = {
  workspaces: [workspace],
  workspace,
  agents: [],
  threads: [],
  tasks: [],
  knowledge: [],
  assignments: [],
  activeRuns: [],
  attention: [],
  runtime: {
    chatgpt: { installed: true, connected: true, message: "Connected." },
    harnesses: {
      codex: { installed: true, version: "codex 1.0" },
      opencode: { installed: true, version: "opencode 1.0" },
    },
  },
  workspacePath: "/workspace",
  dataPath: "/workspace/.nexestra",
};

function historySnapshot(
  thread: Thread,
  messages: Message[],
  artifacts: Artifact[],
): ThreadHistoryPage {
  const updatedThread: Thread = {
    ...thread,
    messageCount: messages.length,
    lastMessageAt: messages.length > 0 ? now : null,
  };
  const data: ThreadData = { thread: updatedThread, runs: [], messages, artifacts, toolCalls: [] };
  return {
    ...data,
    activeRuns: [],
    page: {
      totalMessages: messages.length,
      totalArtifacts: artifacts.length,
      firstMessageIndex: messages.length ? 1 : 0,
      lastMessageIndex: messages.length,
      beforeCursor: null,
      afterCursor: null,
    },
  };
}

function takePost(posts: FormData[], index: number): FormData {
  const post = posts[index];
  if (!post) throw new Error(`missing post ${index}`);
  return post;
}

function fakeServer(thread: Thread) {
  const savedMessages: Message[] = [];
  const savedArtifacts: Artifact[] = [];
  const posts: FormData[] = [];
  let bootstrapFetches = 0;
  let historyFetches = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap" || path === `/api/bootstrap?workspaceId=${workspace.id}`) {
        bootstrapFetches += 1;
        const messageCount = savedMessages.length;
        return jsonResponse({
          ...bootstrapData,
          threads: [
            {
              ...thread,
              messageCount,
              lastMessageAt: messageCount > 0 ? now : null,
            },
          ],
        });
      }
      if (path === historyUrl(thread)) {
        historyFetches += 1;
        return jsonResponse(historySnapshot(thread, [...savedMessages], [...savedArtifacts]));
      }
      if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
        const form = init.body as FormData;
        posts.push(form);
        if (savedMessages.length === 0) {
          const file = form.get("files") as File;
          savedMessages.push({
            id: "saved-message-1",
            threadId: thread.id,
            sequence: 1,
            author: { kind: "user", id: "local-user", name: "Local user" },
            content: String(form.get("content")),
            mentions: [],
            knowledgeReferences: [],
            artifactIds: ["artifact-resume-1"],
            createdAt: now,
          });
          savedArtifacts.push({
            id: "artifact-resume-1",
            threadId: thread.id,
            messageId: "saved-message-1",
            sequence: 1,
            kind: "file",
            source: "upload",
            name: file.name,
            mediaType: file.type,
            size: file.size,
            createdAt: now,
          });
          return jsonResponse({ error: { message: "Unavailable" } }, 503);
        }
        return jsonResponse({ message: savedMessages[0], runs: [], replayed: true }, 200);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    }),
  );
  return {
    savedMessages,
    savedArtifacts,
    posts,
    bootstrapFetches: () => bootstrapFetches,
    historyFetches: () => historyFetches,
  };
}

describe("resume pending submission", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("focus revalidation surfaces the server-saved message while the pending send stays intact", async () => {
    const user = userEvent.setup();
    const thread = threadRow("thread-resume-saved", "general");
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const server = fakeServer(thread);
    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Resume me");
    await user.upload(screen.getByLabelText("Choose files or images"), uploadFile("diagram.png"));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(server.posts).toHaveLength(1));
    expect(await screen.findByText("Unavailable")).toBeVisible();
    const savedRequestId = String(takePost(server.posts, 0).get("requestId"));
    expect(
      JSON.parse(window.localStorage.getItem(pendingKey(workspace.id, thread.id)) as string)
        .requestId,
    ).toBe(savedRequestId);
    expect(composer).toHaveValue("Resume me");
    expect(screen.getByRole("button", { name: "Remove diagram.png" })).toBeInTheDocument();

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(server.bootstrapFetches()).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(server.historyFetches()).toBeGreaterThanOrEqual(2));
    expect(await within(await screen.findByRole("article")).findByText("Resume me")).toBeVisible();

    expect(server.posts).toHaveLength(1);
    expect(
      JSON.parse(window.localStorage.getItem(pendingKey(workspace.id, thread.id)) as string)
        .requestId,
    ).toBe(savedRequestId);
    expect(composer).toHaveValue("Resume me");
    expect(screen.getByRole("button", { name: "Remove diagram.png" })).toBeInTheDocument();
  });

  it("explicit retry replays the same request identity and file bytes after resume revalidation", async () => {
    const user = userEvent.setup();
    const thread = threadRow("thread-resume-retry", "general");
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const server = fakeServer(thread);
    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Resume me");
    await user.upload(screen.getByLabelText("Choose files or images"), uploadFile("diagram.png"));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(server.posts).toHaveLength(1));
    expect(await screen.findByText("Unavailable")).toBeVisible();
    const savedRequestId = String(takePost(server.posts, 0).get("requestId"));
    const firstFile = takePost(server.posts, 0).get("files") as File;

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(server.bootstrapFetches()).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(server.historyFetches()).toBeGreaterThanOrEqual(2));
    expect(await within(await screen.findByRole("article")).findByText("Resume me")).toBeVisible();
    expect(server.posts).toHaveLength(1);
    expect(composer).toHaveValue("Resume me");
    expect(screen.getByRole("button", { name: "Remove diagram.png" })).toBeInTheDocument();
    expect(
      JSON.parse(window.localStorage.getItem(pendingKey(workspace.id, thread.id)) as string)
        .requestId,
    ).toBe(savedRequestId);

    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(server.posts).toHaveLength(2));
    const first = takePost(server.posts, 0);
    const second = takePost(server.posts, 1);
    expect(String(second.get("requestId"))).toBe(String(first.get("requestId")));
    expect(String(second.get("content"))).toBe("Resume me");
    const secondFile = second.get("files") as File;
    expect(secondFile.name).toBe(firstFile.name);
    expect(secondFile.type).toBe(firstFile.type);
    expect(secondFile.size).toBe(firstFile.size);
    expect(await fileText(secondFile)).toBe(await fileText(firstFile));
    expect(server.savedMessages).toHaveLength(1);
    expect(server.savedArtifacts).toHaveLength(1);

    await waitFor(() =>
      expect(window.localStorage.getItem(pendingKey(workspace.id, thread.id))).toBeNull(),
    );
    expect(composer).toHaveValue("");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(within(screen.getByRole("article")).getByText("Resume me")).toBeVisible();
  });
});
