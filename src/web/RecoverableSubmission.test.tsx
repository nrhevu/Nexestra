// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BootstrapData, Thread, ThreadData, ThreadHistoryPage } from "../shared/contracts.js";
import { App } from "./App.js";
import { fingerprintSubmission, newRequestId, SubmissionState } from "./submissionState.js";

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
  return `/api/threads/${encodeURIComponent(thread.id)}/history?workspaceId=${encodeURIComponent(thread.workspaceId)}&limit=50`;
}
function historySnapshot(thread: Thread): ThreadHistoryPage {
  const data: ThreadData = { thread, runs: [], messages: [], artifacts: [], toolCalls: [] };
  return {
    ...data,
    activeRuns: [],
    page: {
      totalMessages: 0,
      totalArtifacts: 0,
      firstMessageIndex: 0,
      lastMessageIndex: 0,
      beforeCursor: null,
      afterCursor: null,
    },
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

function pendingKey(workspaceId: string, threadId: string): string {
  return `nexestra.pendingSubmission.1.${workspaceId}:${threadId}`;
}

function uploadFile(name: string): File {
  return new File(["diagram"], name, { type: "image/png" });
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

describe("SubmissionState", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fingerprints content, edited content and file order", async () => {
    const first = new File(["alpha"], "x.txt", { type: "text/plain" });
    const second = new File(["beta"], "x.txt", { type: "text/plain" });
    const orderA = await fingerprintSubmission("hello", [first, second]);
    const orderB = await fingerprintSubmission("hello", [second, first]);
    const edited = await fingerprintSubmission("hello!", [first, second]);
    expect(orderA).not.toBe(orderB);
    expect(orderA).not.toBe(edited);
  });

  it("persists and retires only the exact request identity", () => {
    const state = new SubmissionState();
    const thread = threadRow("thread-storage", "general");
    const requestId = newRequestId();
    state.remember(workspace.id, thread.id, {
      requestId,
      key: "v1:abc",
      files: [{ name: "a.txt", type: "text/plain", size: 2 }],
      createdAt: now,
    });
    expect(state.pendingFor(workspace.id, thread.id)?.requestId).toBe(requestId);
    expect(state.retire(workspace.id, thread.id, newRequestId()).matched).toBe(false);
    expect(state.retire(workspace.id, thread.id, requestId).matched).toBe(true);
    expect(state.pendingFor(workspace.id, thread.id)).toBeNull();
    expect(window.localStorage.getItem(pendingKey(workspace.id, thread.id))).toBeNull();
  });

  it("serializes the payload structure so delimiter characters cannot collide", async () => {
    const file = new File(["b"], "a\u0000b.txt", { type: "text/plain" });
    const withContent = await fingerprintSubmission("a\u0000b", []);
    const withFile = await fingerprintSubmission("a", [file]);
    expect(withContent).not.toBe(withFile);
  });

  it("ignores invalid persisted pending payloads instead of resubmitting them", () => {
    window.localStorage.setItem(
      pendingKey(workspace.id, "thread-invalid"),
      JSON.stringify({ requestId: "not-a-uuid", key: "v1:x", files: [], createdAt: now }),
    );
    const state = new SubmissionState();
    expect(state.pendingFor(workspace.id, "thread-invalid")).toBeNull();
    expect(window.localStorage.getItem(pendingKey(workspace.id, "thread-invalid"))).toBeNull();
  });
});

describe("Recoverable message submission", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reuses one request identity while the failing payload keeps its files and content", async () => {
    const user = userEvent.setup();
    const thread = threadRow("thread-retry-files", "general");
    const posts: (FormData | Record<string, unknown>)[] = [];
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") return jsonResponse({ ...bootstrapData, threads: [thread] });
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(thread));
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          if (init.body instanceof FormData) posts.push(init.body as FormData);
          else posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return jsonResponse({ error: { message: "Unavailable" } }, 503);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Retry me");
    const input = await screen.findByLabelText("Choose files or images");
    await user.upload(input, uploadFile("diagram.png"));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Unavailable");

    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts.length).toBe(2));
    expect(composer).toHaveValue("Retry me");
    expect(screen.getByText("diagram.png")).toBeInTheDocument();
    const bodies = posts.map((body) => ({
      requestId: body instanceof FormData ? String(body.get("requestId")) : String(body.requestId),
      content: body instanceof FormData ? String(body.get("content")) : String(body.content),
    }));
    expect(bodies[0]?.requestId).toBe(bodies[1]?.requestId);
    expect(bodies[0]?.content).toBe("Retry me");
    expect(bodies[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("gives edited content a new request identity because it is a new intent", async () => {
    const user = userEvent.setup();
    const thread = threadRow("thread-retry-edit", "general");
    const requestIds: string[] = [];
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") return jsonResponse({ ...bootstrapData, threads: [thread] });
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(thread));
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          requestIds.push((JSON.parse(String(init.body)) as { requestId: string }).requestId);
          return jsonResponse({ error: { message: "Unavailable" } }, 503);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "First attempt");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Unavailable");
    await user.type(composer, " edited");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(requestIds).toHaveLength(2));
    expect(requestIds[1]).not.toBe(requestIds[0]);
  });
  it("treats same-name same-type same-size different bytes as a new identity", async () => {
    const user = userEvent.setup();
    const thread = threadRow("thread-retry-bytes", "general");
    const requestIds: string[] = [];
    let failed = false;
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") return jsonResponse({ ...bootstrapData, threads: [thread] });
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(thread));
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          const body = init.body as FormData;
          requestIds.push(String(body.get("requestId")));
          if (!failed) {
            failed = true;
            return jsonResponse({ error: { message: "Unavailable" } }, 503);
          }
          return jsonResponse({ message: {}, runs: [] }, 201);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);
    const input = await screen.findByLabelText("Choose files or images");
    const fileA = new File(["alpha"], "same.bin", { type: "application/octet-stream" });
    await user.upload(input, fileA);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Unavailable");
    await user.click(screen.getByRole("button", { name: "Remove same.bin" }));

    const fileB = new File(["beta"], "same.bin", {
      type: "application/octet-stream",
      lastModified: fileA.lastModified,
    });
    await user.upload(input, fileB);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(requestIds).toHaveLength(2));
    expect(requestIds[1]).not.toBe(requestIds[0]);
  });

  it("treats reordered files as a new intent", async () => {
    const user = userEvent.setup();
    const thread = threadRow("thread-retry-order", "general");
    const requestIds: string[] = [];
    let failed = false;
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") return jsonResponse({ ...bootstrapData, threads: [thread] });
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(thread));
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          const body = init.body as FormData;
          requestIds.push(String(body.get("requestId")));
          if (!failed) {
            failed = true;
            return jsonResponse({ error: { message: "Unavailable" } }, 503);
          }
          return jsonResponse({ message: {}, runs: [] }, 201);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);
    const input = await screen.findByLabelText("Choose files or images");
    await user.upload(input, uploadFile("a.txt"));
    await user.upload(input, uploadFile("b.txt"));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Unavailable");
    await user.click(screen.getByRole("button", { name: "Remove b.txt" }));
    await user.click(screen.getByRole("button", { name: "Remove a.txt" }));
    await user.upload(input, uploadFile("b.txt"));
    await user.upload(input, uploadFile("a.txt"));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(requestIds).toHaveLength(2));
    expect(requestIds[1]).not.toBe(requestIds[0]);
  });

  it("retires the identity after success so the same words become a new message", async () => {
    const user = userEvent.setup();
    const thread = threadRow("thread-retry-success", "general");
    const requestIds: string[] = [];
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") return jsonResponse({ ...bootstrapData, threads: [thread] });
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(thread));
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          requestIds.push((JSON.parse(String(init.body)) as { requestId: string }).requestId);
          return jsonResponse({ message: {}, runs: [] }, 201);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Done");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(requestIds).toHaveLength(1));
    await user.type(composer, "Done");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(requestIds).toHaveLength(2));
    expect(requestIds[1]).not.toBe(requestIds[0]);
    expect(window.localStorage.getItem(pendingKey(workspace.id, thread.id))).toBeNull();
  });

  it("keeps pending identities per thread and out-of-order success cannot clear a new intent", async () => {
    const user = userEvent.setup();
    const first = threadRow("thread-switch-first", "first");
    const second = threadRow("thread-switch-second", "second");
    const firstPending = deferredResponse();
    const secondPending = deferredResponse();
    const firstIds: string[] = [];
    const secondIds: string[] = [];
    window.history.replaceState({}, "", `/threads/${first.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [first, second] });
        }
        if (path === historyUrl(first)) return jsonResponse(historySnapshot(first));
        if (path === historyUrl(second)) return jsonResponse(historySnapshot(second));
        if (path === `/api/threads/${first.id}/messages` && init?.method === "POST") {
          firstIds.push((JSON.parse(String(init.body)) as { requestId: string }).requestId);
          return firstPending.promise;
        }
        if (path === `/api/threads/${second.id}/messages` && init?.method === "POST") {
          secondIds.push((JSON.parse(String(init.body)) as { requestId: string }).requestId);
          return secondPending.promise;
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);
    let composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "First");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(screen.getByRole("button", { name: /#second/ }));
    composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Second");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(firstIds.length + secondIds.length).toBe(2));

    await act(async () => {
      firstPending.resolve(jsonResponse({ message: {}, runs: [] }, 201));
    });
    await act(async () => {
      secondPending.resolve(jsonResponse({ message: {}, runs: [] }, 201));
    });

    expect(firstIds.length).toBe(1);
    expect(secondIds.length).toBe(1);
    expect(window.localStorage.getItem(pendingKey(workspace.id, first.id))).toBeNull();
    expect(window.localStorage.getItem(pendingKey(workspace.id, second.id))).toBeNull();
  });

  it("restores a text retry from browser storage and reuses the request identity", async () => {
    const thread = threadRow("thread-reload-retry", "general");
    const key = pendingKey(workspace.id, thread.id);
    const requestId = newRequestId();
    const persistedKey = await fingerprintSubmission("Persisted", []);
    window.localStorage.setItem(
      key,
      JSON.stringify({ version: 1, requestId, key: persistedKey, files: [], createdAt: now }),
    );
    window.localStorage.setItem(`nexestra.draft.${workspace.id}:${thread.id}`, "Persisted");
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const requestIds: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") return jsonResponse({ ...bootstrapData, threads: [thread] });
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(thread));
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          requestIds.push((JSON.parse(String(init.body)) as { requestId: string }).requestId);
          return jsonResponse({ message: {}, runs: [] }, 201);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    expect(composer).toHaveValue("Persisted");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(requestIds).toEqual([requestId]));
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("degraded browser storage keeps the pending identity in memory for an explicit retry", async () => {
    const user = userEvent.setup();
    const thread = threadRow("thread-no-storage", "general");
    const requestIds: string[] = [];
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") return jsonResponse({ ...bootstrapData, threads: [thread] });
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(thread));
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          requestIds.push((JSON.parse(String(init.body)) as { requestId: string }).requestId);
          if (requestIds.length === 1)
            return jsonResponse({ error: { message: "Unavailable" } }, 503);
          return jsonResponse({ message: {}, runs: [] }, 201);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "In memory");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Unavailable");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(requestIds.length).toBe(2));
    expect(requestIds[0]).toBe(requestIds[1]);
    vi.restoreAllMocks();
  });

  it("warns that the previous send was not confirmed; reloaded files missing require reattach or an explicit new message", async () => {
    const user = userEvent.setup();
    const thread = threadRow("thread-reload-files", "general");
    const key = pendingKey(workspace.id, thread.id);
    const requestId = newRequestId();
    const persistedKey = await fingerprintSubmission("With file", []);
    window.localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        requestId,
        key: persistedKey,
        files: [{ name: "lost.png", type: "image/png", size: 42 }],
        createdAt: now,
      }),
    );
    window.localStorage.setItem(`nexestra.draft.${workspace.id}:${thread.id}`, "With file");
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const postedIds: string[] = [];
    let posting = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") return jsonResponse({ ...bootstrapData, threads: [thread] });
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(thread));
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          posting += 1;
          postedIds.push((JSON.parse(String(init.body)) as { requestId: string }).requestId);
          return jsonResponse({ message: {}, runs: [] }, 201);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    expect(composer).toHaveValue("With file");
    expect(await screen.findByText(/The previous send was not confirmed/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Reattach original files" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(
      await screen.findByText(/Reattach the original files, or choose Send as new message/),
    ).toBeVisible();
    expect(posting).toBe(0);

    await user.click(screen.getByRole("button", { name: "Send as new message" }));
    await waitFor(() => expect(postedIds).toHaveLength(1));
    expect(postedIds[0]).not.toBe(requestId);
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("skips agent-readiness preflight when retrying the exact pending payload", async () => {
    const user = userEvent.setup();
    const thread = threadRow("thread-ready-retry", "general");
    const busyAgent = {
      id: "agent-planner",
      workspaceId: workspace.id,
      kind: "worker" as const,
      name: "Planner",
      handle: "planner",
      description: "Plans work",
      instructions: "",
      enabled: true,
      archived: false,
      harness: "codex" as const,
      createdAt: now,
      updatedAt: now,
      readiness: "unavailable" as const,
      readinessLabel: "Unavailable",
    };
    const content = "@planner do the work";
    const key = pendingKey(workspace.id, thread.id);
    const requestId = newRequestId();
    const persistedKey = await fingerprintSubmission(content, []);
    window.localStorage.setItem(
      key,
      JSON.stringify({ version: 1, requestId, key: persistedKey, files: [], createdAt: now }),
    );
    window.localStorage.setItem(`nexestra.draft.${workspace.id}:${thread.id}`, content);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const requestIds: string[] = [];
    let failed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [thread], agents: [busyAgent] });
        }
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(thread));
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          requestIds.push((JSON.parse(String(init.body)) as { requestId: string }).requestId);
          if (!failed) {
            failed = true;
            return jsonResponse({ error: { message: "Unavailable" } }, 503);
          }
          return jsonResponse({ message: {}, runs: [] }, 201);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    expect(composer).toHaveValue(content);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(requestIds).toEqual([requestId]));
    expect(screen.queryByText(/planner cannot be invoked/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(requestIds).toHaveLength(2));
    expect(requestIds[1]).toBe(requestId);
  });

  it("preflights a new mention send when the agent is unavailable", async () => {
    const user = userEvent.setup();
    const thread = threadRow("thread-ready-new", "general");
    const busyAgent = {
      id: "agent-planner",
      workspaceId: workspace.id,
      kind: "worker" as const,
      name: "Planner",
      handle: "planner",
      description: "Plans work",
      instructions: "",
      enabled: true,
      archived: false,
      harness: "codex" as const,
      createdAt: now,
      updatedAt: now,
      readiness: "unavailable" as const,
      readinessLabel: "Unavailable",
    };
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const requestIds: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [thread], agents: [busyAgent] });
        }
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(thread));
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          requestIds.push((JSON.parse(String(init.body)) as { requestId: string }).requestId);
          return jsonResponse({ message: {}, runs: [] }, 201);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "@planner do the work");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/planner cannot be invoked/)).toBeVisible();
    expect(requestIds).toHaveLength(0);
  });

  it("rejects changed attachment bytes and requires an explicit new message after reload", async () => {
    const user = userEvent.setup();
    const thread = threadRow("thread-reload-replaced", "general");
    const key = pendingKey(workspace.id, thread.id);
    const requestId = newRequestId();
    const original = new File(["aaaa"], "lost.bin", { type: "application/octet-stream" });
    const persistedKey = await fingerprintSubmission("With file", [original]);
    window.localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        requestId,
        key: persistedKey,
        files: [{ name: original.name, type: original.type, size: original.size }],
        createdAt: now,
      }),
    );
    window.localStorage.setItem(`nexestra.draft.${workspace.id}:${thread.id}`, "With file");
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const postedIds: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") return jsonResponse({ ...bootstrapData, threads: [thread] });
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(thread));
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          const body = init.body as FormData;
          postedIds.push(String(body.get("requestId")));
          return jsonResponse({ message: {}, runs: [] }, 201);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);
    const input = await screen.findByLabelText("Choose files or images");
    await user.upload(
      input,
      new File(["bbbb"], original.name, {
        type: original.type,
        lastModified: original.lastModified,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/files differ from the unconfirmed send/)).toBeVisible();
    expect(postedIds).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Send as new message" }));
    await waitFor(() => expect(postedIds).toHaveLength(1));
    expect(postedIds[0]).not.toBe(requestId);
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("reuses the saved request identity when original attachment bytes are restored", async () => {
    const user = userEvent.setup();
    const thread = threadRow("thread-reload-exact", "general");
    const key = pendingKey(workspace.id, thread.id);
    const requestId = newRequestId();
    const original = new File(["aaaa"], "lost.bin", { type: "application/octet-stream" });
    const persistedKey = await fingerprintSubmission("With file", [original]);
    window.localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        requestId,
        key: persistedKey,
        files: [{ name: original.name, type: original.type, size: original.size }],
        createdAt: now,
      }),
    );
    window.localStorage.setItem(`nexestra.draft.${workspace.id}:${thread.id}`, "With file");
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const postedIds: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") return jsonResponse({ ...bootstrapData, threads: [thread] });
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(thread));
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          const body = init.body as FormData;
          postedIds.push(String(body.get("requestId")));
          return jsonResponse({ message: {}, runs: [] }, 201);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);
    await user.upload(await screen.findByLabelText("Choose files or images"), original);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(postedIds).toEqual([requestId]));
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("does not reuse a confirmed identity when clearing browser storage fails", async () => {
    const user = userEvent.setup();
    const thread = threadRow("thread-tombstone", "general");
    const key = pendingKey(workspace.id, thread.id);
    const requestId = newRequestId();
    const persistedKey = await fingerprintSubmission("Same words", []);
    window.localStorage.setItem(
      key,
      JSON.stringify({ version: 1, requestId, key: persistedKey, files: [], createdAt: now }),
    );
    window.localStorage.setItem(`nexestra.draft.${workspace.id}:${thread.id}`, "Same words");
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    const postedIds: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") return jsonResponse({ ...bootstrapData, threads: [thread] });
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(thread));
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          postedIds.push((JSON.parse(String(init.body)) as { requestId: string }).requestId);
          return jsonResponse({ message: {}, runs: [] }, 201);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(postedIds).toEqual([requestId]));
    expect(await screen.findByText(/could not clear the retry identity/)).toBeVisible();
    await user.type(composer, "Same words");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(postedIds).toHaveLength(2));
    expect(postedIds[1]).not.toBe(requestId);
    expect(window.localStorage.getItem(key)).not.toBeNull();
    vi.restoreAllMocks();
  });
});
