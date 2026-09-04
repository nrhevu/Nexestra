import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileStore, StoreError } from "./store.js";

async function openStore() {
  const root = await mkdtemp(join(tmpdir(), "nexestra-store-"));
  return FileStore.open({ root, workspacePath: root });
}

describe("FileStore", () => {
  it("migrates version 1 metadata into a default workspace without changing record IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-store-legacy-"));
    const createdAt = "2026-09-01T10:00:00.000Z";
    await writeFile(
      join(root, "state.json"),
      `${JSON.stringify({
        version: 1,
        agents: [],
        threads: [
          {
            id: "legacy-thread",
            name: "general",
            slug: "general",
            createdAt,
            updatedAt: createdAt,
            messageCount: 0,
            lastMessageAt: null,
          },
        ],
        tasks: [],
      })}\n`,
    );

    const store = await FileStore.open({ root, workspacePath: root });
    const [workspace] = store.listWorkspaces();

    expect(workspace).toMatchObject({ name: "Nexestra", slug: "nexestra" });
    expect(store.getThread("legacy-thread")).toMatchObject({
      id: "legacy-thread",
      workspaceId: workspace?.id,
    });
    const persisted = JSON.parse(await readFile(store.stateFile, "utf8"));
    expect(persisted).toMatchObject({ version: 6, knowledge: [], assignments: [] });
  });

  it("creates isolated workspaces with their own general thread and agent handles", async () => {
    const store = await openStore();
    const [firstWorkspace] = store.listWorkspaces();
    if (!firstWorkspace) throw new Error("expected default workspace");
    const secondWorkspace = await store.createWorkspace({ name: "Product Team" });
    const firstAgent = await store.createAgent({
      kind: "worker",
      name: "Planner One",
      handle: "planner",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const secondAgent = await store.createAgent({
      workspaceId: secondWorkspace.id,
      kind: "worker",
      name: "Planner Two",
      handle: "planner",
      description: "",
      instructions: "",
      harness: "opencode",
    });

    expect(store.listThreads(firstWorkspace.id)).toHaveLength(1);
    expect(store.listThreads(secondWorkspace.id)).toMatchObject([{ name: "general" }]);
    expect(store.listAgents(firstWorkspace.id).map((agent) => agent.id)).toEqual([firstAgent.id]);
    expect(store.listAgents(secondWorkspace.id).map((agent) => agent.id)).toEqual([secondAgent.id]);
    await expect(
      store.createTask({
        workspaceId: secondWorkspace.id,
        title: "Cross-workspace assignment",
        assigneeId: firstAgent.id,
        threadId: null,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("keeps every participant's messages in one append-only thread file", async () => {
    const store = await openStore();
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
    const user = await store.createUserMessage(thread.id, "@codex hello", [
      { agentId: agent.id, handle: agent.handle },
    ]);
    await store.createAgentMessage(thread.id, agent, "Hello.", user.id);

    const data = await store.threadData(thread.id);
    expect(data.messages.map((message) => message.author.kind)).toEqual(["user", "agent"]);
    expect(data.messages[1]?.triggerMessageId).toBe(user.id);
    const transcript = await readFile(store.transcriptPath(thread.id), "utf8");
    expect(transcript).toContain("@codex hello");
    expect(transcript).toContain("Hello.");
  });

  it("stores shared documents and resolves their #references for agents", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const item = await store.createKnowledgeDocument(
      {
        name: "Architecture guide",
        handle: "architecture",
        description: "Repository conventions",
      },
      {
        name: "architecture.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture\n\nUse one canonical transcript."),
      },
    );
    const message = await store.createUserMessage(
      thread.id,
      "Use #architecture for this change.",
      [],
      [],
      [{ knowledgeId: item.id, handle: item.handle }],
    );

    expect(store.listKnowledge()).toEqual([expect.objectContaining({ id: item.id })]);
    await expect(store.agentKnowledge(message)).resolves.toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ handle: "architecture" }),
        content: expect.stringContaining("canonical transcript"),
      }),
    ]);
    await expect(
      store.createKnowledgeDocument(
        { name: "Duplicate", handle: "architecture" },
        { name: "duplicate.txt", mediaType: "text/plain", bytes: new Uint8Array([1]) },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await readFile(store.knowledgePath(item), "utf8")).toContain("Architecture");
  });

  it("updates knowledge metadata and permanently removes an unused document", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const item = await store.createKnowledgeDocument(
      {
        name: "Architecture guide",
        handle: "architecture",
        description: "Repository conventions",
      },
      {
        name: "architecture.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture\n"),
      },
    );
    const file = store.knowledgePath(item);

    await expect(
      store.updateKnowledge(item.id, {
        name: "System architecture",
        handle: "system-architecture",
        description: "Current system boundaries",
      }),
    ).resolves.toMatchObject({
      name: "System architecture",
      handle: "system-architecture",
      description: "Current system boundaries",
    });
    expect(store.findKnowledgeByHandle("architecture", workspace.id)).toBeUndefined();
    expect(store.findKnowledgeByHandle("system-architecture", workspace.id)?.id).toBe(item.id);

    await store.deleteKnowledge(item.id);

    expect(store.getKnowledge(item.id)).toBeUndefined();
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stores uploads and indexes web and workspace-file references in the thread transcript", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    await mkdir(join(store.workspacePath, "notes"), { recursive: true });
    await writeFile(join(store.workspacePath, "notes", "plan.md"), "# Plan\n");
    const message = await store.createUserMessage(
      thread.id,
      "See https://example.com/spec and `notes/plan.md`.",
      [],
      [
        {
          name: "diagram.png",
          mediaType: "image/png",
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        },
      ],
    );

    const data = await store.threadData(thread.id);
    expect(message.artifactIds).toHaveLength(3);
    expect(data.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "image", source: "upload", name: "diagram.png" }),
        expect.objectContaining({ kind: "link", url: "https://example.com/spec" }),
        expect.objectContaining({ kind: "file", path: "notes/plan.md" }),
      ]),
    );
    const upload = data.artifacts.find((artifact) => artifact.source === "upload");
    if (!upload) throw new Error("expected uploaded artifact");
    const content = await store.artifactContent(thread.id, upload.id);
    expect([...new Uint8Array(await readFile(content.file))]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    await expect(reopened.threadData(thread.id)).resolves.toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ id: upload.id, messageId: message.id }),
      ]),
    });
  });

  it("indexes links and safe workspace files referenced by an agent reply", async () => {
    const store = await openStore();
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
    await writeFile(join(store.workspacePath, "result.txt"), "done\n");
    const trigger = await store.createUserMessage(thread.id, "@codex report", [
      { agentId: agent.id, handle: agent.handle },
    ]);
    const reply = await store.createAgentMessage(
      thread.id,
      agent,
      "I used [the result](result.txt) and https://example.com/run.",
      trigger.id,
    );

    const data = await store.threadData(thread.id);
    expect(data.artifacts.filter((artifact) => artifact.messageId === reply.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", path: "result.txt" }),
        expect.objectContaining({ kind: "link", url: "https://example.com/run" }),
      ]),
    );
  });

  it("persists trimmed Worker model settings across restarts", async () => {
    const store = await openStore();
    const created = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
      model: "  gpt-5.4  ",
      reasoningEffort: "  high  ",
    });

    expect(created).toMatchObject({ model: "gpt-5.4", reasoningEffort: "high" });
    const reopened = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    expect(reopened.getAgent(created.id)).toMatchObject({
      model: "gpt-5.4",
      reasoningEffort: "high",
    });
  });

  it("loads legacy Worker records without model settings", async () => {
    const store = await openStore();
    const created = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const state = JSON.parse(await readFile(store.stateFile, "utf8"));
    expect(state.agents[0]).not.toHaveProperty("model");
    expect(state.agents[0]).not.toHaveProperty("reasoningEffort");

    const reopened = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    expect(reopened.getAgent(created.id)).not.toHaveProperty("model");
    expect(reopened.getAgent(created.id)).not.toHaveProperty("reasoningEffort");
  });

  it("migrates version 2 Master agents to ask mode", async () => {
    const store = await openStore();
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
    const state = JSON.parse(await readFile(store.stateFile, "utf8"));
    state.version = 2;
    delete state.agents[0].accessMode;
    await writeFile(store.stateFile, `${JSON.stringify(state)}\n`);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });

    expect(reopened.getAgent(agent.id)).toMatchObject({ accessMode: "ask" });
    await expect(readFile(store.stateFile, "utf8")).resolves.toContain('"version": 6');
  });

  it("migrates version 3 Master permissions to ask mode", async () => {
    const store = await openStore();
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
    const state = JSON.parse(await readFile(store.stateFile, "utf8"));
    state.version = 3;
    delete state.agents[0].accessMode;
    state.agents[0].permissions = { read: "allow", edit: "ask", bash: "deny" };
    await writeFile(store.stateFile, `${JSON.stringify(state)}\n`);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });

    expect(reopened.getAgent(agent.id)).toMatchObject({ accessMode: "ask" });
  });

  it("migrates version 4 permission profiles to auto or full and removes the old matrix", async () => {
    const store = await openStore();
    const autoAgent = await store.createAgent({
      kind: "master",
      name: "Builder",
      handle: "builder",
      description: "",
      instructions: "",
      provider: { type: "chatgpt", model: "" },
    });
    const fullAgent = await store.createAgent({
      kind: "master",
      name: "Trusted",
      handle: "trusted",
      description: "",
      instructions: "",
      provider: { type: "chatgpt", model: "" },
    });
    const state = JSON.parse(await readFile(store.stateFile, "utf8"));
    state.version = 4;
    delete state.agents[0].accessMode;
    state.agents[0].permissions = {
      read: "allow",
      edit: "allow",
      bash: "allow",
      skill: "allow",
      todowrite: "allow",
      webfetch: "ask",
      websearch: "ask",
      question: "allow",
      external: "ask",
    };
    delete state.agents[1].accessMode;
    state.agents[1].permissions = Object.fromEntries(
      Object.keys(state.agents[0].permissions).map((key) => [key, "allow"]),
    );
    await writeFile(store.stateFile, `${JSON.stringify(state)}\n`);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const migratedAuto = reopened.getAgent(autoAgent.id);
    const migratedFull = reopened.getAgent(fullAgent.id);

    expect(migratedAuto).toMatchObject({ accessMode: "auto" });
    expect(migratedFull).toMatchObject({ accessMode: "full" });
    expect(migratedAuto).not.toHaveProperty("permissions");
    expect(migratedFull).not.toHaveProperty("permissions");
  });

  it("never writes a custom provider key to public state or transcripts", async () => {
    const store = await openStore();
    const secret = "sk-super-secret";
    const agent = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Local gateway",
        baseUrl: "http://127.0.0.1:11434/v1/",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });

    expect(store.getCredential(agent.id)).toBe(secret);
    expect(await readFile(store.stateFile, "utf8")).not.toContain(secret);
    expect(JSON.stringify(store.listAgents())).not.toContain(secret);
  });

  it("redacts legacy short credentials without corrupting ordinary text", async () => {
    const store = await openStore();
    await writeFile(
      store.credentialFile,
      `${JSON.stringify({ version: 1, credentials: { legacy: "a" } })}\n`,
    );
    const reopened = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });

    expect(reopened.redactSecrets("data; key=a; exact a")).toBe(
      "data; key=[REDACTED]; exact [REDACTED]",
    );
  });

  it("permanently deletes an agent, its credential, and current task assignments", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const secret = "sk-delete-me";
    const agent = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Local gateway",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });
    const task = await store.createTask({
      title: "Review the plan",
      description: "",
      status: "todo",
      assigneeId: agent.id,
      threadId: null,
    });
    const trigger = await store.createUserMessage(thread.id, "@maya keep this history", [
      { agentId: agent.id, handle: agent.handle },
    ]);
    await store.createAgentMessage(thread.id, agent, "This reply stays.", trigger.id);
    const transcriptBefore = await readFile(store.transcriptPath(thread.id), "utf8");

    await store.deleteAgent(agent.id);

    expect(store.getAgent(agent.id)).toBeUndefined();
    expect(store.findAgentByHandle(agent.handle)).toBeUndefined();
    expect(store.getCredential(agent.id)).toBeUndefined();
    expect(store.listTasks().find((entry) => entry.id === task.id)?.assigneeId).toBeNull();
    expect(await readFile(store.transcriptPath(thread.id), "utf8")).toBe(transcriptBefore);
    const credentials = JSON.parse(await readFile(store.credentialFile, "utf8"));
    expect(credentials.credentials).not.toHaveProperty(agent.id);
    expect(JSON.stringify(credentials)).not.toContain(secret);

    const reopened = await FileStore.open({
      root: store.root,
      workspacePath: store.workspacePath,
    });
    expect(reopened.getAgent(agent.id)).toBeUndefined();
    expect(reopened.listTasks().find((entry) => entry.id === task.id)?.assigneeId).toBeNull();
    await expect(reopened.deleteAgent(agent.id)).rejects.toMatchObject({ code: "not_found" });

    await expect(
      reopened.createAgent({
        kind: "worker",
        name: "New Maya",
        handle: "maya",
        description: "",
        instructions: "",
        harness: "codex",
      }),
    ).resolves.toMatchObject({ handle: "maya" });
  });

  it("keeps the durable intermediate state retryable when state persistence fails", async () => {
    const store = await openStore();
    const agent = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Local gateway",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: "sk-delete-me",
      },
    });
    const internal = store as unknown as {
      writeState: (state?: unknown) => Promise<void>;
    };
    const writeState = internal.writeState.bind(store);
    internal.writeState = async () => {
      throw new Error("simulated state write failure");
    };

    try {
      await expect(store.deleteAgent(agent.id)).rejects.toThrow("simulated state write failure");
      expect(store.getAgent(agent.id)).toBeDefined();
      expect(store.getCredential(agent.id)).toBeUndefined();
      expect(await readFile(store.stateFile, "utf8")).toContain(agent.id);
      expect(await readFile(store.credentialFile, "utf8")).not.toContain(agent.id);
    } finally {
      internal.writeState = writeState;
    }

    await expect(store.deleteAgent(agent.id)).resolves.toBeUndefined();
    expect(store.getAgent(agent.id)).toBeUndefined();
  });

  it("rejects unsafe custom provider URLs", async () => {
    const store = await openStore();
    const input = {
      kind: "master" as const,
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: {
        type: "custom" as const,
        name: "Gateway",
        model: "model-a",
        protocol: "openai-chat" as const,
      },
    };

    await expect(
      store.createAgent({
        ...input,
        provider: { ...input.provider, baseUrl: "http://example.com/v1" },
      }),
    ).rejects.toBeInstanceOf(StoreError);
    await expect(
      store.createAgent({
        ...input,
        provider: { ...input.provider, baseUrl: "https://user:pass@example.com/v1?token=x" },
      }),
    ).rejects.toBeInstanceOf(StoreError);
  });

  it("rejects duplicate handles case-insensitively", async () => {
    const store = await openStore();
    await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });

    await expect(
      store.createAgent({
        kind: "worker",
        name: "Other",
        handle: "CODEX",
        description: "",
        instructions: "",
        harness: "opencode",
      }),
    ).rejects.toBeInstanceOf(StoreError);
  });

  it("creates a task directly in the selected board column", async () => {
    const store = await openStore();
    const task = await store.createTask({
      title: "Review",
      description: "",
      status: "in_progress",
      assigneeId: null,
      threadId: null,
    });
    expect(task.status).toBe("in_progress");
  });

  it("updates and deletes a task while protecting active Worker assignments", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
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
    await store.updateKnowledgeRepository(repository.id, {
      status: "ready",
      defaultBranch: "main",
    });
    const task = await store.createTask({
      title: "Initial task",
      description: "Initial description",
      assigneeId: worker.id,
      threadId: thread.id,
    });
    const now = new Date().toISOString();
    const assignment = await store.createAssignment({
      id: "assignment-active",
      workspaceId: workspace.id,
      taskId: task.id,
      threadId: thread.id,
      masterRunId: "master-run",
      workerAgentId: worker.id,
      repositoryId: repository.id,
      status: "running",
      branch: "nexestra/assignment-active",
      worktreePath: "workspaces/workspace/worktrees/assignment-active",
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      store.updateTask(task.id, {
        title: "Updated task",
        description: "Updated description",
        status: "in_progress",
      }),
    ).resolves.toMatchObject({
      title: "Updated task",
      description: "Updated description",
      status: "in_progress",
    });
    await expect(store.deleteTask(task.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(store.deleteKnowledge(repository.id)).rejects.toMatchObject({ code: "conflict" });

    await store.updateAssignment(assignment.id, { status: "completed" });
    await store.deleteTask(task.id);
    await store.deleteKnowledge(repository.id);

    expect(store.getTask(task.id)).toBeUndefined();
    expect(store.getKnowledge(repository.id)).toBeUndefined();
  });

  it("replays message order after restart and marks an unfinished run interrupted", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const first = await store.createUserMessage(thread.id, "one", []);
    const second = await store.createUserMessage(thread.id, "two", []);
    const now = new Date().toISOString();
    await store.updateRun({
      id: crypto.randomUUID(),
      threadId: thread.id,
      triggerMessageId: second.id,
      agentId: crypto.randomUUID(),
      attempt: 1,
      status: "running",
      createdAt: now,
      updatedAt: now,
    });

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const data = await reopened.threadData(thread.id);
    expect(data.messages.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(data.runs[0]?.status).toBe("interrupted");
  });

  it("replays tool events and interrupts pending approval and input after restart", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const now = new Date().toISOString();
    const run = await store.updateRun({
      id: "run-pending",
      threadId: thread.id,
      triggerMessageId: "message",
      agentId: "agent",
      attempt: 1,
      status: "waiting_approval",
      createdAt: now,
      updatedAt: now,
    });
    await store.updateToolCall({
      id: "tool-pending",
      runId: run.id,
      threadId: thread.id,
      agentId: run.agentId,
      name: "bash",
      permission: "bash",
      status: "waiting_approval",
      input: '{"command":"pnpm test"}',
      createdAt: now,
      updatedAt: now,
    });
    const inputRun = await store.updateRun({
      id: "run-input",
      threadId: thread.id,
      triggerMessageId: "message",
      agentId: "agent",
      attempt: 1,
      status: "waiting_input",
      createdAt: now,
      updatedAt: now,
    });
    await store.updateToolCall({
      id: "tool-input",
      runId: inputRun.id,
      threadId: thread.id,
      agentId: inputRun.agentId,
      name: "question",
      permission: "question",
      status: "waiting_input",
      input:
        '{"questions":[{"question":"Continue?","header":"Confirm","options":[{"label":"Yes","description":"Continue the run."}]}]}',
      createdAt: now,
      updatedAt: now,
    });

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const data = await reopened.threadData(thread.id);

    expect(data.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: run.id, status: "interrupted" }),
        expect.objectContaining({ id: inputRun.id, status: "interrupted" }),
      ]),
    );
    expect(data.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tool-pending", status: "interrupted" }),
        expect.objectContaining({ id: "tool-input", status: "interrupted" }),
      ]),
    );
  });

  it("repairs a partial JSONL tail before appending another event", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const first = await store.createUserMessage(thread.id, "before crash", []);
    await appendFile(store.transcriptPath(thread.id), '{"type":"message.created","sequence":2');

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const second = await reopened.createUserMessage(thread.id, "after crash", []);
    const data = await reopened.threadData(thread.id);

    expect(data.messages.map((message) => message.id)).toEqual([first.id, second.id]);
    expect(second.sequence).toBe(2);
  });

  it("completes a recovered run when its reply was already persisted", async () => {
    const store = await openStore();
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
    const trigger = await store.createUserMessage(thread.id, "@codex reply", [
      { agentId: agent.id, handle: agent.handle },
    ]);
    const now = new Date().toISOString();
    const run = {
      id: crypto.randomUUID(),
      threadId: thread.id,
      triggerMessageId: trigger.id,
      agentId: agent.id,
      attempt: 1,
      status: "running" as const,
      createdAt: now,
      updatedAt: now,
    };
    await store.updateRun(run);
    await store.createAgentMessage(thread.id, agent, "synced reply", trigger.id);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const data = await reopened.threadData(thread.id);
    expect(data.runs[0]?.status).toBe("completed");
  });
});
