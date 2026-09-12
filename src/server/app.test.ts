import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Agent, AgentRun, RuntimeStatus } from "../shared/contracts.js";
import { createApp } from "./app.js";
import type { AssignmentRepositoryManager } from "./repository-manager.js";
import type { AgentInvocation, AgentRunner } from "./runtime.js";
import { FileStore, PREVIEW_BUDGET_BYTES, StoreError } from "./store.js";

const execFileAsync = promisify(execFile);

const runtime: RuntimeStatus = {
  chatgpt: { installed: true, connected: true, message: "Logged in using ChatGPT" },
  harnesses: {
    codex: { installed: true, version: "test" },
    opencode: { installed: true, version: "test" },
  },
};

class FakeRunner implements AgentRunner {
  invocations = 0;
  lastInvocation?: AgentInvocation;
  gate?: Promise<void>;
  requireToolApproval = false;
  requireToolQuestion = false;
  approvalRequested: Promise<void> = Promise.resolve();
  questionRequested: Promise<void> = Promise.resolve();
  private markApprovalRequested: () => void = () => undefined;
  private markQuestionRequested: () => void = () => undefined;

  prepareToolApproval() {
    this.requireToolApproval = true;
    this.approvalRequested = new Promise<void>((resolve) => {
      this.markApprovalRequested = resolve;
    });
  }

  prepareToolQuestion() {
    this.requireToolQuestion = true;
    this.questionRequested = new Promise<void>((resolve) => {
      this.markQuestionRequested = resolve;
    });
  }

  async runtimeStatus() {
    return runtime;
  }

  async invoke(agent: Agent, invocation: AgentInvocation) {
    this.invocations += 1;
    this.lastInvocation = invocation;
    await this.gate;
    if (this.requireToolApproval) {
      if (!invocation.runId || !invocation.toolHooks) throw new Error("missing tool hooks");
      const now = new Date().toISOString();
      const toolCall = {
        id: "tool-approval",
        runId: invocation.runId,
        threadId: invocation.thread.id,
        agentId: agent.id,
        name: "bash" as const,
        permission: "bash" as const,
        status: "waiting_approval" as const,
        input: '{"command":"pnpm test"}',
        createdAt: now,
        updatedAt: now,
      };
      const decision = invocation.toolHooks.requestApproval(toolCall);
      this.markApprovalRequested();
      const approved = await decision;
      await invocation.toolHooks.update({
        ...toolCall,
        status: approved ? "completed" : "denied",
        summary: approved ? "Command finished." : "Denied by the user.",
        updatedAt: new Date().toISOString(),
      });
    }
    if (this.requireToolQuestion) {
      if (!invocation.runId || !invocation.toolHooks?.requestInput) {
        throw new Error("missing question hooks");
      }
      const now = new Date().toISOString();
      const toolCall = {
        id: "tool-question",
        runId: invocation.runId,
        threadId: invocation.thread.id,
        agentId: agent.id,
        name: "question" as const,
        permission: "question" as const,
        status: "waiting_input" as const,
        input: '{"questions":[{"question":"Continue?"}]}',
        questions: [
          {
            header: "Decision",
            question: "Continue?",
            options: [{ label: "Proceed", description: "Keep going." }],
            multiple: false,
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      const answer = invocation.toolHooks.requestInput(toolCall);
      this.markQuestionRequested();
      const answers = await answer;
      await invocation.toolHooks.update({
        ...toolCall,
        answers,
        status: "completed",
        summary: "User answered.",
        updatedAt: new Date().toISOString(),
      });
    }
    return `Hello from ${agent.name}`;
  }
}

describe("HTTP app", () => {
  let store: FileStore;
  let runner: FakeRunner;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-app-"));
    store = await FileStore.open({ root, workspacePath: root });
    runner = new FakeRunner();
    app = createApp({ store, runner });
  });

  it("creates a workspace and returns only its scoped bootstrap data", async () => {
    const response = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Product Team" }),
    });
    expect(response.status).toBe(201);
    const workspace = (await response.json()) as { id: string; name: string };

    await store.createAgent({
      workspaceId: workspace.id,
      kind: "worker",
      name: "Product Planner",
      handle: "planner",
      description: "",
      instructions: "",
      harness: "codex",
    });
    await store.createTask({ title: "Other workspace blocker", status: "blocked" });
    const task = await store.createTask({
      workspaceId: workspace.id,
      title: "Product decision",
      status: "blocked",
    });
    const bootstrap = await app.request(`/api/bootstrap?workspaceId=${workspace.id}`);

    await expect(bootstrap.json()).resolves.toMatchObject({
      workspace: { id: workspace.id, name: "Product Team" },
      workspaces: [{ name: "Nexestra" }, { id: workspace.id, name: "Product Team" }],
      agents: [{ workspaceId: workspace.id, handle: "planner" }],
      threads: [{ workspaceId: workspace.id, name: "general" }],
      tasks: [{ id: task.id, workspaceId: workspace.id }],
      attention: [{ id: `task:${task.id}`, kind: "task_blocked", title: task.title }],
    });
    const activity = await app.request(`/api/activity?workspaceId=${workspace.id}`);
    await expect(activity.json()).resolves.toMatchObject({
      workspaceId: workspace.id,
      activeRuns: [],
      attention: [{ id: `task:${task.id}`, kind: "task_blocked", title: task.title }],
    });
  });

  it("returns validated declarative custom surfaces in bootstrap data", async () => {
    await writeFile(
      join(store.workspacePath, "nexestra.config.json"),
      JSON.stringify({
        surfaces: [
          {
            id: "inference",
            title: "Inference lab",
            description: "Compare profiles.",
            cards: [{ id: "runs", title: "Runs", action: "runs" }],
          },
        ],
      }),
    );
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const response = await app.request(`/api/bootstrap?workspaceId=${workspace.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      customSurfaces: Array<{ title: string; cards: Array<{ action: string }> }>;
    };
    expect(body.customSurfaces).toEqual([
      expect.objectContaining({
        title: "Inference lab",
        cards: [expect.objectContaining({ action: "runs" })],
      }),
    ]);
  });

  it("reads and saves a redacted workspace whiteboard within its workspace", async () => {
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    await store.createAgent({
      workspaceId: workspace.id,
      kind: "master",
      name: "Secret provider",
      handle: "secret",
      description: "",
      instructions: "",
      accessMode: "ask",
      provider: {
        type: "custom",
        name: "Local provider",
        baseUrl: "https://provider.example/v1",
        model: "test",
        protocol: "openai-chat",
        apiKey: "sk-whiteboard-secret",
      },
    });
    const initial = await app.request(`/api/whiteboard?workspaceId=${workspace.id}`);
    await expect(initial.json()).resolves.toMatchObject({
      workspaceId: workspace.id,
      content: "",
      updatedAt: null,
    });
    const saved = await app.request(`/api/whiteboard?workspaceId=${workspace.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# Plan\n\nToken: sk-whiteboard-secret" }),
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      workspaceId: workspace.id,
      content: "# Plan\n\nToken: [REDACTED]",
    });
    const loaded = await app.request(`/api/whiteboard?workspaceId=${workspace.id}`);
    await expect(loaded.json()).resolves.toMatchObject({
      content: "# Plan\n\nToken: [REDACTED]",
    });
    const foreign = await app.request("/api/whiteboard?workspaceId=missing");
    expect(foreign.status).toBe(404);
    const rejected = await app.request(`/api/whiteboard?workspaceId=${workspace.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ content: "nope" }),
    });
    expect(rejected.status).toBe(403);
  });

  it("renames and reorders workspaces and rejects stale or duplicate order payloads", async () => {
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Product Team" }),
    });
    expect(created.status).toBe(201);
    const product = (await created.json()) as { id: string };

    const rename = await app.request(`/api/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nexus Studio" }),
    });
    expect(rename.status).toBe(200);
    await expect(rename.json()).resolves.toMatchObject({
      id: workspace.id,
      name: "Nexus Studio",
      slug: "nexus-studio",
    });

    const order = await app.request("/api/workspaces/order", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceIds: [product.id, workspace.id] }),
    });
    expect(order.status).toBe(200);
    await expect(order.json()).resolves.toMatchObject([{ id: product.id }, { id: workspace.id }]);

    const listed = await app.request("/api/workspaces");
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject([{ id: product.id }, { id: workspace.id }]);

    const stale = await app.request("/api/workspaces/order", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceIds: [workspace.id] }),
    });
    expect(stale.status).toBe(409);
    const duplicate = await app.request("/api/workspaces/order", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceIds: [workspace.id, workspace.id] }),
    });
    expect(duplicate.status).toBe(400);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    expect(reopened.listWorkspaces().map((entry) => entry.id)).toEqual([product.id, workspace.id]);
  });

  it.each(["bootstrap", "activity"])(
    "rejects an explicitly unknown workspace for %s instead of returning another workspace",
    async (endpoint) => {
      for (const workspaceId of ["missing-workspace", ""]) {
        const response = await app.request(`/api/${endpoint}?workspaceId=${workspaceId}`);
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "not_found", message: "Workspace not found." },
        });
      }
    },
  );

  it("creates an agent and dispatches only an explicit mention", async () => {
    const agentResponse = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "worker",
        name: "Codex",
        handle: "codex",
        description: "",
        instructions: "",
        harness: "codex",
        model: "gpt-test",
        reasoningEffort: "high",
      }),
    });
    expect(agentResponse.status).toBe(201);
    await expect(agentResponse.json()).resolves.toMatchObject({
      kind: "worker",
      harness: "codex",
      model: "gpt-test",
      reasoningEffort: "high",
    });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");

    await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "regular note" }),
    });
    expect(runner.invocations).toBe(0);

    await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@codex please reply" }),
    });
    await app.dispatcher.waitForIdle();
    expect(runner.invocations).toBe(1);
    const data = await store.threadData(thread.id);
    expect(data.messages.at(-1)?.content).toBe("Hello from Codex");
  });

  it("uploads an image with a message and serves it from the thread artifact endpoint", async () => {
    await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const form = new FormData();
    form.append("content", "@codex inspect this image");
    form.append(
      "files",
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "diagram.png", {
        type: "image/png",
      }),
    );

    const sent = await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      body: form,
    });
    expect(sent.status).toBe(201);
    await app.dispatcher.waitForIdle();
    expect(runner.lastInvocation?.artifacts).toMatchObject([
      { artifact: { kind: "image", name: "diagram.png" } },
    ]);

    const data = await store.threadData(thread.id);
    const artifact = data.artifacts.find((entry) => entry.name === "diagram.png");
    if (!artifact) throw new Error("expected image artifact");
    const response = await app.request(
      `/api/threads/${thread.id}/artifacts/${artifact.id}/content`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("creates, reads, updates, and deletes shared knowledge", async () => {
    const form = new FormData();
    form.append("name", "Architecture guide");
    form.append("handle", "architecture");
    form.append("description", "Repository conventions");
    form.append(
      "file",
      new File(["# Architecture\n"], "architecture.md", { type: "text/markdown" }),
    );
    const created = await app.request("/api/knowledge/documents", {
      method: "POST",
      body: form,
    });

    expect(created.status).toBe(201);
    const item = (await created.json()) as { id: string; handle: string; mediaType: string };
    expect(item).toMatchObject({ handle: "architecture", mediaType: "text/markdown" });
    const content = await app.request(`/api/knowledge/${item.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-disposition")).toContain("architecture.md");
    await expect(content.text()).resolves.toBe("# Architecture\n");
    const details = await app.request(`/api/knowledge/${item.id}`);
    expect(details.status).toBe(200);
    await expect(details.json()).resolves.toMatchObject({ id: item.id, handle: "architecture" });
    const updated = await app.request(`/api/knowledge/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "System architecture",
        handle: "system-architecture",
        description: "Current system boundaries",
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      name: "System architecture",
      handle: "system-architecture",
      description: "Current system boundaries",
    });
    const bootstrap = await app.request("/api/bootstrap");
    await expect(bootstrap.json()).resolves.toMatchObject({
      knowledge: [expect.objectContaining({ id: item.id, handle: "system-architecture" })],
      assignments: [],
    });
    const deleted = await app.request(`/api/knowledge/${item.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect((await app.request(`/api/knowledge/${item.id}`)).status).toBe(404);
  });

  it("replaces and restores knowledge documents while keeping revision history", async () => {
    const createForm = new FormData();
    createForm.append("name", "Architecture guide");
    createForm.append("handle", "architecture");
    createForm.append("description", "");
    createForm.append(
      "file",
      new File(["# Architecture v1\n"], "architecture.md", { type: "text/markdown" }),
    );
    const created = await app.request("/api/knowledge/documents", {
      method: "POST",
      body: createForm,
    });
    expect(created.status).toBe(201);
    const item = (await created.json()) as {
      id: string;
      currentRevisionId: string;
      revisions: { id: string }[];
    };
    expect(item.revisions).toHaveLength(1);
    const firstRevisionId = item.currentRevisionId;

    const replaceForm = new FormData();
    replaceForm.append("expectedRevisionId", firstRevisionId);
    replaceForm.append(
      "file",
      new File(["# Architecture v2\n"], "architecture-v2.md", { type: "text/markdown" }),
    );
    const replacedResponse = await app.request(`/api/knowledge/${item.id}/document`, {
      method: "PUT",
      body: replaceForm,
    });
    expect(replacedResponse.status).toBe(200);
    const replaced = (await replacedResponse.json()) as {
      currentRevisionId: string;
      fileName: string;
      revisions: { id: string }[];
    };
    expect(replaced.fileName).toBe("architecture-v2.md");
    expect(replaced.currentRevisionId).not.toBe(firstRevisionId);
    expect(replaced.revisions).toHaveLength(2);

    const revisions = await app.request(`/api/knowledge/${item.id}/revisions`);
    expect(revisions.status).toBe(200);
    await expect(revisions.json()).resolves.toMatchObject({
      currentRevisionId: replaced.currentRevisionId,
      revisions: [{ id: replaced.currentRevisionId }, { id: firstRevisionId }],
    });
    const oldContent = await app.request(
      `/api/knowledge/${item.id}/revisions/${firstRevisionId}/content`,
    );
    expect(oldContent.status).toBe(200);
    expect(oldContent.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(oldContent.text()).resolves.toBe("# Architecture v1\n");
    const currentContent = await app.request(`/api/knowledge/${item.id}/content`);
    expect(await currentContent.text()).toBe("# Architecture v2\n");

    const restoredResponse = await app.request(
      `/api/knowledge/${item.id}/revisions/${firstRevisionId}/restore`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevisionId: replaced.currentRevisionId }),
      },
    );
    expect(restoredResponse.status).toBe(200);
    const restored = (await restoredResponse.json()) as {
      currentRevisionId: string;
      revisions: { restoredFromId?: string }[];
    };
    expect(restored.currentRevisionId).not.toBe(replaced.currentRevisionId);
    expect(restored.revisions).toHaveLength(3);
    expect(restored.revisions.at(-1)?.restoredFromId).toBe(firstRevisionId);
    const restoredContent = await app.request(`/api/knowledge/${item.id}/content`);
    expect(await restoredContent.text()).toBe("# Architecture v1\n");

    const staleForm = new FormData();
    staleForm.append("expectedRevisionId", replaced.currentRevisionId);
    staleForm.append("file", new File(["# Stale\n"], "stale.md", { type: "text/markdown" }));
    const stale = await app.request(`/api/knowledge/${item.id}/document`, {
      method: "PUT",
      body: staleForm,
    });
    expect(stale.status).toBe(409);
    expect((await app.request(`/api/knowledge/${item.id}/revisions/missing/content`)).status).toBe(
      404,
    );
  });

  it("refuses corrupted document bytes through both current and revision downloads", async () => {
    const item = await store.createKnowledgeDocument(
      { name: "Release guide", handle: "release-guide", description: "" },
      {
        name: "release.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("Release on Friday."),
      },
    );
    await writeFile(store.knowledgePath(item), "Unexpected local changes.");

    for (const path of [
      `/api/knowledge/${item.id}/content`,
      `/api/knowledge/${item.id}/revisions/${item.currentRevisionId}/content`,
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid", message: "Document revision content is corrupted." },
      });
    }
  });

  it("serves bounded current and historical previews without writes or provider calls", async () => {
    const created = await store.createKnowledgeDocument(
      { name: "Preview guide", handle: "preview-guide", description: "" },
      {
        name: "preview.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Preview v1"),
      },
    );
    const firstRevisionId = created.currentRevisionId;
    const largeBytes = Buffer.concat([
      Buffer.alloc(PREVIEW_BUDGET_BYTES, 0x41),
      Buffer.from("😀"),
      Buffer.from("tail"),
    ]);
    await store.replaceKnowledgeDocument(
      created.id,
      { expectedRevisionId: firstRevisionId },
      { name: "preview-large.md", mediaType: "text/plain", bytes: largeBytes },
    );
    const binary = await store.createKnowledgeDocument(
      { name: "Diagram", handle: "preview-diagram", description: "" },
      {
        name: "diagram.png",
        mediaType: "image/png",
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      },
    );
    const stateBefore = await readFile(store.stateFile, "utf8");

    const currentResponse = await app.request(`/api/knowledge/${created.id}/preview`);
    expect(currentResponse.status).toBe(200);
    const current = (await currentResponse.json()) as {
      fileName: string;
      supported: boolean;
      truncated: boolean;
      text?: string;
    };
    expect(current).toMatchObject({
      fileName: "preview-large.md",
      supported: true,
      truncated: true,
    });
    expect(current.text).not.toContain("😀");
    expect(Buffer.byteLength(current.text ?? "", "utf8")).toBe(PREVIEW_BUDGET_BYTES);
    expect(JSON.stringify(current)).not.toContain("workspaces");

    const oldResponse = await app.request(
      `/api/knowledge/${created.id}/preview?revisionId=${firstRevisionId}`,
    );
    expect(oldResponse.status).toBe(200);
    await expect(oldResponse.json()).resolves.toMatchObject({
      fileName: "preview.md",
      supported: true,
      truncated: false,
      text: "# Preview v1",
      isCurrent: false,
    });

    const unsupported = await app.request(`/api/knowledge/${binary.id}/preview`);
    expect(unsupported.status).toBe(200);
    await expect(unsupported.json()).resolves.toMatchObject({
      supported: false,
      fileName: "diagram.png",
      reason: expect.stringContaining("cannot be previewed"),
    });
    const missing = await app.request(`/api/knowledge/${created.id}/preview?revisionId=missing`);
    expect(missing.status).toBe(404);
    expect(await readFile(store.stateFile, "utf8")).toBe(stateBefore);
    expect(runner.invocations).toBe(0);
  });

  it("reports a corrupted revision before invalid UTF-8 in previews", async () => {
    const item = await store.createKnowledgeDocument(
      { name: "Broken preview", handle: "broken-preview", description: "" },
      {
        name: "broken.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("ok"),
      },
    );
    await writeFile(store.knowledgePath(item), Buffer.from([0x6f, 0x6b, 0xff]));
    const response = await app.request(`/api/knowledge/${item.id}/preview`);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid", message: "Document revision content is corrupted." },
    });
  });

  it("rejects replacement uploads with too many files before buffering", async () => {
    const createForm = new FormData();
    createForm.append("name", "Notes");
    createForm.append("handle", "notes");
    createForm.append("description", "");
    createForm.append("file", new File(["one"], "one.md", { type: "text/markdown" }));
    const created = await app.request("/api/knowledge/documents", {
      method: "POST",
      body: createForm,
    });
    expect(created.status).toBe(201);
    const item = (await created.json()) as { id: string; currentRevisionId: string };
    const form = new FormData();
    form.append("expectedRevisionId", item.currentRevisionId);
    form.append("file", new File(["one"], "one.md", { type: "text/markdown" }));
    form.append("file", new File(["two"], "two.md", { type: "text/markdown" }));
    const rejected = await app.request(`/api/knowledge/${item.id}/document`, {
      method: "PUT",
      body: form,
    });
    expect(rejected.status).toBe(400);
  });

  it("creates, reads, updates, and deletes a Taskboard task", async () => {
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Draft documentation",
        description: "Write the first draft.",
        status: "todo",
        assigneeId: null,
        threadId: null,
        verificationCommand: "pnpm test",
      }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };

    const details = await app.request(`/api/tasks/${task.id}`);
    expect(details.status).toBe(200);
    await expect(details.json()).resolves.toMatchObject({
      id: task.id,
      title: "Draft documentation",
    });
    const updated = await app.request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Publish documentation",
        description: "Review and publish the draft.",
        status: "blocked",
        verificationCommand: "pnpm check",
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      title: "Publish documentation",
      description: "Review and publish the draft.",
      status: "blocked",
      verificationCommand: "pnpm check",
    });

    const deleted = await app.request(`/api/tasks/${task.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect((await app.request(`/api/tasks/${task.id}`)).status).toBe(404);
  });

  it("reports live activity without scanning persisted thread history", async () => {
    let releaseRunner: () => void = () => undefined;
    runner.gate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });

    const sent = await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@codex keep working" }),
    });
    expect(sent.status).toBe(201);

    await vi.waitFor(() => expect(runner.lastInvocation).toBeDefined());
    const transcript = vi.spyOn(store, "threadData").mockRejectedValue(new Error("No transcript"));

    const active = await app.request(`/api/activity?workspaceId=${workspace.id}`);
    await expect(active.json()).resolves.toMatchObject({
      workspaceId: workspace.id,
      activeRuns: [{ agentId: agent.id, threadId: thread.id }],
      attention: [],
    });
    const bootstrap = await app.request(`/api/bootstrap?workspaceId=${workspace.id}`);
    await expect(bootstrap.json()).resolves.toMatchObject({
      activeRuns: [{ agentId: agent.id, threadId: thread.id }],
      attention: [],
    });
    expect(transcript).not.toHaveBeenCalled();
    transcript.mockRestore();

    releaseRunner();
    await app.dispatcher.waitForIdle();
    const idle = await app.request(`/api/activity?workspaceId=${workspace.id}`);
    await expect(idle.json()).resolves.toEqual({
      workspaceId: workspace.id,
      activeRuns: [],
      attention: [],
    });
  });

  it("stops an active ordinary run through the guarded run endpoint", async () => {
    let releaseRunner: () => void = () => undefined;
    runner.gate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const sent = await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@codex stop me" }),
    });
    expect(sent.status).toBe(201);
    await vi.waitFor(() => expect(runner.lastInvocation).toBeDefined());
    const [run] = app.dispatcher.activeRuns();
    if (!run) throw new Error("expected active run");

    const stopped = await app.request(`/api/runs/${run.id}/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
    await expect(stopped.json()).resolves.toMatchObject({ id: run.id, status: "interrupted" });
    releaseRunner();
    await app.dispatcher.waitForIdle();
    const data = await store.threadData(thread.id);
    expect(data.runs).toEqual([
      expect.objectContaining({ id: run.id, agentId: agent.id, status: "interrupted" }),
    ]);
  });

  it("returns the persisted Worker process for a Taskboard task", async () => {
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const master = await store.createAgent({
      kind: "master",
      name: "Lead",
      handle: "lead",
      description: "",
      instructions: "",
      accessMode: "full",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "https://example.test/v1",
        model: "model-a",
        protocol: "openai-chat",
      },
    });
    const worker = await store.createAgent({
      kind: "worker",
      name: "Builder",
      handle: "builder",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const repository = await store.createKnowledgeRepository({
      name: "Product repository",
      handle: "product-repo",
      source: "https://github.com/example/product.git",
    });
    const task = await store.createTask({
      title: "Implement feature",
      description: "Build and test it.",
      status: "in_progress",
      assigneeId: worker.id,
      threadId: thread.id,
    });
    const now = new Date().toISOString();
    const assignmentId = crypto.randomUUID();
    await store.createAssignment({
      id: assignmentId,
      workspaceId: workspace.id,
      taskId: task.id,
      threadId: thread.id,
      masterRunId: master.id,
      workerAgentId: worker.id,
      repositoryId: repository.id,
      status: "running",
      branch: `nexestra/${assignmentId}`,
      worktreePath: `workspaces/${workspace.id}/worktrees/${assignmentId}`,
      createdAt: now,
      updatedAt: now,
    });
    await store.updateRun({
      id: assignmentId,
      threadId: thread.id,
      triggerMessageId: "message-1",
      agentId: worker.id,
      attempt: 1,
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    await store.updateToolCall({
      id: `${assignmentId}:read`,
      runId: assignmentId,
      threadId: thread.id,
      agentId: worker.id,
      name: "read",
      permission: "read",
      status: "completed",
      input: '{"filePath":"README.md"}',
      createdAt: now,
      updatedAt: now,
    });

    const response = await app.request(`/api/tasks/${task.id}/process`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      task: { id: task.id },
      assignment: { id: assignmentId, workerAgentId: worker.id },
      run: { id: assignmentId, status: "running" },
      toolCalls: [{ runId: assignmentId, name: "read" }],
    });

    const stopped = await app.request(`/api/tasks/${task.id}/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
    await expect(stopped.json()).resolves.toMatchObject({
      task: { id: task.id, status: "todo", assigneeId: null },
      assignment: { id: assignmentId, status: "interrupted" },
      run: { id: assignmentId, status: "interrupted" },
    });
  });

  it("opens a thread event stream with an immediate activity snapshot", async () => {
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");

    const response = await app.request(`/api/threads/${thread.id}/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("expected event stream body");
    const chunk = await reader.read();
    await reader.cancel();

    expect(new TextDecoder().decode(chunk.value)).toContain("event: thread");
    expect(new TextDecoder().decode(chunk.value)).toContain('"activities":[]');
  });

  it("renames, archives, restores, and rejects new messages in archived threads", async () => {
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");

    const renamed = await app.request(`/api/threads/${thread.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed Thread" }),
    });
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({
      id: thread.id,
      name: "Renamed Thread",
      slug: "renamed-thread",
      archived: false,
    });

    const archived = await app.request(`/api/threads/${thread.id}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await expect(archived.json()).resolves.toMatchObject({ id: thread.id, archived: true });

    const rejected = await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "late note" }),
    });
    expect(rejected.status).toBe(409);
    const afterSend = await store.threadData(thread.id);
    expect(afterSend.messages).toHaveLength(0);

    const restored = await app.request(`/api/threads/${thread.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await expect(restored.json()).resolves.toMatchObject({ id: thread.id, archived: false });
    expect(store.transcriptPath(thread.id)).toBe(join(store.threadDirectory, `${thread.id}.jsonl`));
  });

  it("rejects mutating browser requests from a non-loopback origin", async () => {
    const response = await app.request("/api/threads", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ name: "blocked" }),
    });
    expect(response.status).toBe(403);
  });

  it("approves a pending Master tool call and resumes the run", async () => {
    runner.prepareToolApproval();
    const agent = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      accessMode: "ask",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "model-a",
        protocol: "openai-chat",
      },
    });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@maya run the tests" }),
    });
    await runner.approvalRequested;

    await vi.waitFor(async () => {
      const pending = await app.request(`/api/activity?workspaceId=${thread.workspaceId}`);
      expect(await pending.json()).toMatchObject({
        attention: [{ kind: "approval", threadId: thread.id, title: "Maya in #general" }],
      });
    });

    const approval = await app.request("/api/tool-calls/tool-approval/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(approval.status).toBe(204);
    await app.dispatcher.waitForIdle();

    const cleared = await app.request(`/api/activity?workspaceId=${thread.workspaceId}`);
    await expect(cleared.json()).resolves.toMatchObject({ attention: [] });

    const data = await store.threadData(thread.id);
    expect(data.runs).toMatchObject([{ status: "completed" }]);
    expect(data.toolCalls).toMatchObject([
      { id: "tool-approval", status: "completed", summary: "Command finished." },
    ]);
    expect(data.messages.at(-1)?.content).toBe(`Hello from ${agent.name}`);
  });

  it("accepts an answer for a pending Master question and resumes the run", async () => {
    runner.prepareToolQuestion();
    const agent = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "model-a",
        protocol: "openai-chat",
      },
    });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@maya ask me" }),
    });
    await runner.questionRequested;

    await vi.waitFor(async () => {
      const pending = await app.request(`/api/activity?workspaceId=${thread.workspaceId}`);
      expect(await pending.json()).toMatchObject({
        attention: [{ kind: "input", threadId: thread.id, title: "Maya in #general" }],
      });
    });

    const response = await app.request("/api/tool-calls/tool-question/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: [["Proceed"]] }),
    });
    expect(response.status).toBe(204);
    await app.dispatcher.waitForIdle();

    const cleared = await app.request(`/api/activity?workspaceId=${thread.workspaceId}`);
    await expect(cleared.json()).resolves.toMatchObject({ attention: [] });

    const data = await store.threadData(thread.id);
    expect(data.runs).toMatchObject([{ status: "completed" }]);
    expect(data.toolCalls).toMatchObject([
      { id: "tool-question", status: "completed", answers: [["Proceed"]] },
    ]);
    expect(data.messages.at(-1)?.content).toBe(`Hello from ${agent.name}`);
  });

  it("permanently deletes an idle agent and returns not found when repeated", async () => {
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });

    const response = await app.request(`/api/agents/${agent.id}`, { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(store.getAgent(agent.id)).toBeUndefined();

    const bootstrap = await app.request("/api/bootstrap");
    await expect(bootstrap.json()).resolves.toMatchObject({ agents: [] });

    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const note = await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Keep @codex as plain text" }),
    });
    expect(note.status).toBe(201);
    await expect(note.json()).resolves.toMatchObject({
      message: { content: "Keep @codex as plain text", mentions: [] },
      runs: [],
    });
    expect(runner.invocations).toBe(0);

    const repeated = await app.request(`/api/agents/${agent.id}`, { method: "DELETE" });
    expect(repeated.status).toBe(404);
    await expect(repeated.json()).resolves.toMatchObject({
      error: { code: "not_found", message: "Agent not found." },
    });
  });

  it("rejects deletion while an agent has queued or running work", async () => {
    let releaseRunner: () => void = () => undefined;
    runner.gate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");

    await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@codex wait" }),
    });

    const blocked = await app.request(`/api/agents/${agent.id}`, { method: "DELETE" });
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "conflict" },
    });

    releaseRunner();
    await app.dispatcher.waitForIdle();
    const deleted = await app.request(`/api/agents/${agent.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
  });

  it("rejects deletion after chat reserves an agent but before persisting the message", async () => {
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const createUserMessage = store.createUserMessage.bind(store);
    let markPersistenceStarted: () => void = () => undefined;
    let resumePersistence: () => void = () => undefined;
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve;
    });
    const persistenceGate = new Promise<void>((resolve) => {
      resumePersistence = resolve;
    });
    store.createUserMessage = async (threadId, content, mentions) => {
      markPersistenceStarted();
      await persistenceGate;
      return createUserMessage(threadId, content, mentions);
    };

    const send = app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@codex race" }),
    });
    await persistenceStarted;

    const blocked = await app.request(`/api/agents/${agent.id}`, { method: "DELETE" });
    expect(blocked.status).toBe(409);
    expect(store.getAgent(agent.id)).toBeDefined();

    resumePersistence();
    expect((await send).status).toBe(201);
    await app.dispatcher.waitForIdle();
    const deleted = await app.request(`/api/agents/${agent.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
  });

  it("keeps unknown API paths inside the JSON error namespace", async () => {
    const response = await app.request("/api");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("opens assignment worktrees by absolute path without invoking a shell", async () => {
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace and thread");
    const now = new Date().toISOString();
    const assignmentId = "assignment-open";
    const relativeWorktree = `workspaces/${workspace.id}/worktrees/${assignmentId}`;
    await store.createAssignment({
      id: assignmentId,
      workspaceId: workspace.id,
      taskId: "task-open",
      threadId: thread.id,
      masterRunId: "run-master",
      workerAgentId: "agent-worker",
      repositoryId: "repository-open",
      status: "completed",
      branch: `nexestra/${assignmentId}`,
      worktreePath: relativeWorktree,
      createdAt: now,
      updatedAt: now,
    });
    const launchPath = vi.fn(async () => undefined);
    app = createApp({ store, runner, launchPath });

    const opened = await app.request(`/api/assignments/${assignmentId}/open`, { method: "POST" });
    const revealed = await app.request(`/api/assignments/${assignmentId}/reveal`, {
      method: "POST",
    });

    expect(opened.status).toBe(204);
    expect(revealed.status).toBe(204);
    expect(launchPath).toHaveBeenNthCalledWith(1, join(store.root, relativeWorktree), false);
    expect(launchPath).toHaveBeenNthCalledWith(2, join(store.root, relativeWorktree), true);

    await store.createAssignment({
      id: "assignment-outside",
      workspaceId: workspace.id,
      taskId: "task-outside",
      threadId: thread.id,
      masterRunId: "run-master",
      workerAgentId: "agent-worker",
      repositoryId: "repository-open",
      status: "completed",
      branch: "nexestra/assignment-outside",
      worktreePath: "../../outside",
      createdAt: now,
      updatedAt: now,
    });
    const blocked = await app.request("/api/assignments/assignment-outside/open", {
      method: "POST",
    });
    expect(blocked.status).toBe(400);
    expect(launchPath).toHaveBeenCalledTimes(2);
  });

  it("cleans up only finished assignment worktrees", async () => {
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace and thread");
    const repository = await store.createKnowledgeRepository({
      workspaceId: workspace.id,
      name: "Product repository",
      handle: "product-repo",
      description: "",
      source: "/tmp/product-repo",
    });
    await store.updateKnowledgeRepository(repository.id, {
      status: "ready",
      defaultBranch: "main",
    });
    const now = new Date().toISOString();
    const assignmentId = "assignment-cleanup";
    const relativeWorktree = `workspaces/${workspace.id}/worktrees/${assignmentId}`;
    await store.createAssignment({
      id: assignmentId,
      workspaceId: workspace.id,
      taskId: "task-cleanup",
      threadId: thread.id,
      masterRunId: "run-master",
      workerAgentId: "agent-worker",
      repositoryId: repository.id,
      status: "completed",
      branch: `nexestra/${assignmentId}`,
      worktreePath: relativeWorktree,
      createdAt: now,
      updatedAt: now,
    });
    const cleanupAssignment = vi.fn(async () => undefined);
    const deleteAssignmentBranch = vi.fn(async () => undefined);
    const repositories: AssignmentRepositoryManager = {
      assignmentLocation: (workspaceId, id) => ({
        branch: `nexestra/${id}`,
        worktreePath: `workspaces/${workspaceId}/worktrees/${id}`,
        absolutePath: join(store.root, "workspaces", workspaceId, "worktrees", id),
      }),
      prepareAssignment: async () => undefined,
      cleanupAssignment,
      deleteAssignmentBranch,
    };
    app = createApp({ store, runner, repositories });

    const cleaned = await app.request(`/api/assignments/${assignmentId}/cleanup`, {
      method: "POST",
    });
    expect(cleaned.status).toBe(200);
    const updated = (await cleaned.json()) as { worktreeCleanedAt?: string };
    expect(updated.worktreeCleanedAt).toEqual(expect.any(String));
    expect(cleanupAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ id: repository.id }),
      expect.objectContaining({
        branch: `nexestra/${assignmentId}`,
        worktreePath: relativeWorktree,
        absolutePath: join(store.root, relativeWorktree),
      }),
    );

    const repeat = await app.request(`/api/assignments/${assignmentId}/cleanup`, {
      method: "POST",
    });
    expect(repeat.status).toBe(409);
    const branchDeleted = await app.request(`/api/assignments/${assignmentId}/branch`, {
      method: "POST",
    });
    expect(branchDeleted.status).toBe(200);
    const deleted = (await branchDeleted.json()) as { branchDeletedAt?: string };
    expect(deleted.branchDeletedAt).toEqual(expect.any(String));
    expect(deleteAssignmentBranch).toHaveBeenCalledWith(
      expect.objectContaining({ id: repository.id }),
      expect.objectContaining({
        branch: `nexestra/${assignmentId}`,
        worktreePath: relativeWorktree,
        absolutePath: join(store.root, relativeWorktree),
      }),
    );
    const branchRepeat = await app.request(`/api/assignments/${assignmentId}/branch`, {
      method: "POST",
    });
    expect(branchRepeat.status).toBe(409);
    await store.createAssignment({
      id: "assignment-cleanup-active",
      workspaceId: workspace.id,
      taskId: "task-cleanup-active",
      threadId: thread.id,
      masterRunId: "run-master",
      workerAgentId: "agent-worker",
      repositoryId: repository.id,
      status: "running",
      branch: "nexestra/assignment-cleanup-active",
      worktreePath: `workspaces/${workspace.id}/worktrees/assignment-cleanup-active`,
      createdAt: now,
      updatedAt: now,
    });
    const active = await app.request("/api/assignments/assignment-cleanup-active/cleanup", {
      method: "POST",
    });
    expect(active.status).toBe(409);
    expect(cleanupAssignment).toHaveBeenCalledTimes(1);
    const activeBranch = await app.request("/api/assignments/assignment-cleanup-active/branch", {
      method: "POST",
    });
    expect(activeBranch.status).toBe(409);
    expect(deleteAssignmentBranch).toHaveBeenCalledTimes(1);
  });
  it("rejects configuration edits while an agent is busy and applies them afterwards", async () => {
    let releaseRunner: () => void = () => undefined;
    runner.gate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@codex wait" }),
    });
    const blocked = await app.request(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Busy Editor" }),
    });
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "conflict" },
    });
    releaseRunner();
    await app.dispatcher.waitForIdle();
    const updated = await app.request(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Edited Codex" }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ name: "Edited Codex" });
  });
  it("rejects unknown fields and kind changes when updating an agent", async () => {
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    for (const payload of [
      { name: "Changed", kind: "master" },
      { name: "Changed", workspaceId: "other-workspace" },
    ]) {
      const response = await app.request(`/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(400);
    }
  });

  it("recovers a failed repository clone through the retry endpoint without changing identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-app-retry-"));
    const retryStore = await FileStore.open({ root, workspacePath: root });
    const [workspace] = retryStore.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const source = join(root, "docs-source");
    const failed = await retryStore.createKnowledgeRepository({
      name: "Docs repository",
      handle: "docs",
      description: "",
      source,
    });
    await retryStore.updateKnowledgeRepository(failed.id, {
      status: "failed",
      error: "The source was temporarily unavailable.",
    });
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "README.md"), "# Docs\n");
    await execFileAsync("git", ["init", "--initial-branch=main", source]);
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      source,
      "-c",
      "user.name=Nexestra Test",
      "-c",
      "user.email=test@nexestra.local",
      "commit",
      "-m",
      "Initial commit",
    ]);
    const retryApp = createApp({ store: retryStore, runner });

    const response = await retryApp.request(`/api/knowledge/repositories/${failed.id}/retry`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const recovered = (await response.json()) as {
      id: string;
      handle: string;
      source: string;
      status: string;
      createdAt: string;
      defaultBranch?: string;
    };
    expect(recovered).toMatchObject({
      id: failed.id,
      handle: "docs",
      source,
      status: "ready",
      defaultBranch: "main",
    });
    expect(recovered.createdAt).toBe(failed.createdAt);
    await expect(
      readFile(join(retryStore.knowledgePath(failed), "README.md"), "utf8"),
    ).resolves.toContain("# Docs");

    const repeat = await retryApp.request(`/api/knowledge/repositories/${failed.id}/retry`, {
      method: "POST",
    });
    expect(repeat.status).toBe(409);
    const missing = await retryApp.request("/api/knowledge/repositories/unknown/retry", {
      method: "POST",
    });
    expect(missing.status).toBe(404);
  });
});

describe("HTTP message search", () => {
  let store: FileStore;
  let runner: FakeRunner;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-search-app-"));
    store = await FileStore.open({ root, workspacePath: root });
    runner = new FakeRunner();
    app = createApp({ store, runner });
  });

  it("validates search query filters and scopes to the workspace", async () => {
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const other = await store.createWorkspace({ name: "Other" });
    const otherThread = store.listThreads(other.id)[0];
    if (!otherThread) throw new Error("expected thread");

    const unknownWorkspace = await app.request("/api/search/messages?workspaceId=missing&q=needle");
    expect(unknownWorkspace.status).toBe(404);

    const foreignThread = await app.request(
      `/api/search/messages?workspaceId=${workspace.id}&q=needle&threadId=${otherThread.id}`,
    );
    expect(foreignThread.status).toBe(404);

    const badFilter = await app.request(
      `/api/search/messages?workspaceId=${workspace.id}&q=needle&archived=unknown`,
    );
    expect(badFilter.status).toBe(400);

    const missingQuery = await app.request(`/api/search/messages?workspaceId=${workspace.id}`);
    expect(missingQuery.status).toBe(400);

    const longQuery = await app.request(
      `/api/search/messages?workspaceId=${workspace.id}&q=${"a".repeat(201)}`,
    );
    expect(longQuery.status).toBe(400);

    const highOffset = await app.request(
      `/api/search/messages?workspaceId=${workspace.id}&q=needle&offset=10001`,
    );
    expect(highOffset.status).toBe(400);
  });

  it("returns bounded search hits without invoking providers", async () => {
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const thread = store.listThreads(workspace.id)[0];
    if (!thread) throw new Error("expected thread");
    const message = await store.createUserMessage(thread.id, "needle phrase", []);

    const response = await app.request(`/api/search/messages?workspaceId=${workspace.id}&q=phrase`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      query: { term: "phrase", workspaceId: workspace.id, threadId: null, archived: "all" },
      complete: true,
      matchesFound: 1,
      nextOffset: null,
    });
    const matches = body.matches as Array<Record<string, unknown>>;
    expect(matches[0]).toMatchObject({
      messageId: message.id,
      thread: { id: thread.id, archived: false },
    });
    expect(matches[0]).not.toHaveProperty("content");
    expect(runner.invocations).toBe(0);
  });

  it.each([
    { kind: "internal", status: 500, code: "internal_error" },
    { kind: "store", status: 409, code: "conflict" },
    { kind: "validation", status: 400, code: "invalid_request" },
  ])("redacts stored credentials from $kind HTTP errors and logs", async (scenario) => {
    const secret = "fixture-http-boundary-secret";
    await store.createAgent({
      kind: "master",
      name: "Error Gateway",
      handle: "error-gateway",
      provider: {
        type: "custom",
        name: "Error Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });
    const message = `Could not use source ${secret}.`;
    const error =
      scenario.kind === "validation"
        ? z
            .string()
            .refine(() => false, { message })
            .safeParse("fixture").error
        : scenario.kind === "store"
          ? new StoreError("conflict", message)
          : new Error(message, { cause: { credential: secret } });
    const getKnowledge = vi.spyOn(store, "getKnowledge").mockImplementation(() => {
      throw error;
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await app.request("/api/knowledge/error-fixture");
      expect(response.status).toBe(scenario.status);
      expect(await response.json()).toEqual({
        error: { code: scenario.code, message: "Could not use source [REDACTED]." },
      });
      for (const value of log.mock.calls.flat()) {
        expect(typeof value).toBe("string");
        expect(value).not.toContain(secret);
      }
      if (scenario.kind === "internal") expect(log).toHaveBeenCalled();
      expect(runner.invocations).toBe(0);
    } finally {
      getKnowledge.mockRestore();
      log.mockRestore();
    }
  });

  it("redacts stored credentials from query echo over HTTP", async () => {
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected workspace");
    const secret = "fixture-http-world";
    await store.createAgent({
      kind: "master",
      name: "Http Gateway",
      handle: "http-gateway",
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Http Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });
    const response = await app.request(
      `/api/search/messages?workspaceId=${workspace.id}&q=${encodeURIComponent(secret)}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect((body.query as { term: string }).term).toBe("[REDACTED]");
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(runner.invocations).toBe(0);
  });
});
describe("conversation history HTTP routes", () => {
  let store: FileStore;
  let runner: FakeRunner;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-history-http-"));
    store = await FileStore.open({ root, workspacePath: root });
    runner = new FakeRunner();
    app = createApp({ store, runner });
  });

  it("returns thread-scoped activeRuns and foreign metadata without reading transcripts", async () => {
    const [workspace] = store.listWorkspaces();
    const thread = store.listThreads(workspace?.id ?? "")[0];
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const message = await store.createUserMessage(thread.id, "hello history", []);
    const otherThread = await store.createThread({ name: "Other" });
    const otherMessage = await store.createUserMessage(otherThread.id, "other history", []);
    const now = new Date().toISOString();
    const runHere = {
      id: "run-history-here",
      threadId: thread.id,
      triggerMessageId: message.id,
      agentId: "agent-history",
      attempt: 1,
      status: "running" as const,
      createdAt: now,
      updatedAt: now,
    };
    const runElsewhere = {
      ...runHere,
      id: "run-history-elsewhere",
      threadId: otherThread.id,
      triggerMessageId: otherMessage.id,
    };
    const liveRuns = (app.dispatcher as unknown as { liveRuns: Map<string, AgentRun> }).liveRuns;
    liveRuns.set(runHere.id, runHere);
    liveRuns.set(runElsewhere.id, runElsewhere);
    const response = await app.request(
      `/api/threads/${thread.id}/history?workspaceId=${workspace.id}&limit=10`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: { id: string }[];
      activeRuns: { id: string }[];
    };
    expect(body.messages.map((entry) => entry.id)).toEqual([message.id]);
    expect(body.activeRuns.map((entry) => entry.id)).toEqual([runHere.id]);

    const transcriptPathSpy = vi.spyOn(store, "transcriptPath");
    const metadata = await app.request(`/api/threads/${otherThread.id}/metadata`);
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      id: otherThread.id,
      workspaceId: otherThread.workspaceId,
    });
    expect(transcriptPathSpy).not.toHaveBeenCalled();
  });

  it("validates history and metadata query semantics over HTTP", async () => {
    const [workspace] = store.listWorkspaces();
    const thread = store.listThreads(workspace?.id ?? "")[0];
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const message = await store.createUserMessage(thread.id, "anchor me", []);
    const foreign = await store.createWorkspace({ name: "Foreign" });
    const multiple = await app.request(
      `/api/threads/${thread.id}/history?workspaceId=${workspace.id}&before=${message.id}&after=${message.id}`,
    );
    expect(multiple.status).toBe(400);
    const atOk = await app.request(
      `/api/threads/${thread.id}/history?workspaceId=${workspace.id}&at=1`,
    );
    expect(atOk.status).toBe(200);
    await expect(atOk.json()).resolves.toMatchObject({
      messages: [{ id: message.id }],
      page: { targetMessageId: message.id, targetFound: true, targetMessageIndex: 1 },
    });
    const mixedAt = await app.request(
      `/api/threads/${thread.id}/history?workspaceId=${workspace.id}&at=1&before=${message.id}`,
    );
    expect(mixedAt.status).toBe(400);
    const zeroAt = await app.request(
      `/api/threads/${thread.id}/history?workspaceId=${workspace.id}&at=0`,
    );
    expect(zeroAt.status).toBe(400);
    const pastAt = await app.request(
      `/api/threads/${thread.id}/history?workspaceId=${workspace.id}&at=999`,
    );
    expect(pastAt.status).toBe(200);
    await expect(pastAt.json()).resolves.toMatchObject({
      messages: [{ id: message.id }],
      page: { targetFound: false, targetMessageIndex: 999 },
    });
    const unknownBefore = await app.request(
      `/api/threads/${thread.id}/history?workspaceId=${workspace.id}&before=unknown-anchor`,
    );
    expect(unknownBefore.status).toBe(400);
    const unknownAround = await app.request(
      `/api/threads/${thread.id}/history?workspaceId=${workspace.id}&around=unknown-anchor`,
    );
    expect(unknownAround.status).toBe(200);
    await expect(unknownAround.json()).resolves.toMatchObject({
      page: { targetMessageId: "unknown-anchor", targetFound: false },
    });
    const foreignHistory = await app.request(
      `/api/threads/${thread.id}/history?workspaceId=${foreign.id}`,
    );
    expect(foreignHistory.status).toBe(404);
    const fresh = await store.createThread({ name: "Fresh history" });
    const emptyBefore = await app.request(
      `/api/threads/${fresh.id}/history?workspaceId=${workspace.id}&before=missing-anchor`,
    );
    expect(emptyBefore.status).toBe(400);
    const emptyAfter = await app.request(
      `/api/threads/${fresh.id}/history?workspaceId=${workspace.id}&after=missing-anchor`,
    );
    expect(emptyAfter.status).toBe(400);
    const emptyAround = await app.request(
      `/api/threads/${fresh.id}/history?workspaceId=${workspace.id}&around=missing-anchor`,
    );
    expect(emptyAround.status).toBe(200);
    await expect(emptyAround.json()).resolves.toMatchObject({
      page: { totalMessages: 0, targetMessageId: "missing-anchor", targetFound: false },
    });
    const missingMetadata = await app.request("/api/threads/missing/metadata");
    expect(missingMetadata.status).toBe(404);
  });

  it("writes and clears agent message feedback through the HTTP route", async () => {
    const [workspace] = store.listWorkspaces();
    const thread = store.listThreads(workspace?.id ?? "")[0];
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const agent = await store.createAgent({
      kind: "worker",
      name: "Reviewer",
      handle: "reviewer",
      harness: "codex",
    });
    const userMessage = await store.createUserMessage(thread.id, "Question", []);
    const reply = await store.createAgentMessage(thread.id, agent, "Answer", userMessage.id);
    const rated = await app.request(`/api/threads/${thread.id}/messages/${reply.id}/feedback`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "positive", note: "Useful." }),
    });
    expect(rated.status).toBe(200);
    await expect(rated.json()).resolves.toMatchObject({
      threadId: thread.id,
      messageId: reply.id,
      value: "positive",
      note: "Useful.",
    });
    const history = await app.request(
      `/api/threads/${thread.id}/history?workspaceId=${workspace.id}&limit=10`,
    );
    await expect(history.json()).resolves.toMatchObject({
      feedback: [expect.objectContaining({ messageId: reply.id, value: "positive" })],
    });
    const cleared = await app.request(`/api/threads/${thread.id}/messages/${reply.id}/feedback`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: null }),
    });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toBeNull();
    const rejected = await app.request(
      `/api/threads/${thread.id}/messages/${userMessage.id}/feedback`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "positive" }),
      },
    );
    expect(rejected.status).toBe(400);
  });
});
