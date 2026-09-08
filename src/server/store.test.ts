import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    expect(persisted).toMatchObject({ version: 7, knowledge: [], assignments: [] });
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

  it("renames workspaces with unique slugs and persists the rail order", async () => {
    const store = await openStore();
    const [firstWorkspace] = store.listWorkspaces();
    if (!firstWorkspace) throw new Error("expected seeded workspace");
    const secondWorkspace = await store.createWorkspace({ name: "Product Team" });

    await expect(
      store.updateWorkspace(firstWorkspace.id, { name: "Nexus Studio" }),
    ).resolves.toMatchObject({
      id: firstWorkspace.id,
      name: "Nexus Studio",
      slug: "nexus-studio",
    });
    await expect(
      store.updateWorkspace(secondWorkspace.id, { name: "Nexus Studio" }),
    ).resolves.toMatchObject({ slug: "nexus-studio-2" });
    expect(store.listWorkspaces()).toMatchObject([
      { id: firstWorkspace.id, name: "Nexus Studio" },
      { id: secondWorkspace.id, name: "Nexus Studio" },
    ]);

    await expect(
      store.reorderWorkspaces({ workspaceIds: [secondWorkspace.id, firstWorkspace.id] }),
    ).resolves.toMatchObject([{ id: secondWorkspace.id }, { id: firstWorkspace.id }]);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    expect(reopened.listWorkspaces()).toMatchObject([
      { id: secondWorkspace.id, name: "Nexus Studio" },
      { id: firstWorkspace.id, name: "Nexus Studio" },
    ]);
  });

  it("rejects reorder payloads that do not exactly match the current workspace list", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const secondWorkspace = await store.createWorkspace({ name: "Product Team" });

    await expect(store.reorderWorkspaces({ workspaceIds: [workspace.id] })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      store.reorderWorkspaces({ workspaceIds: [workspace.id, "workspace-foreign"] }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.reorderWorkspaces({
        workspaceIds: [workspace.id, secondWorkspace.id, "workspace-foreign"],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.reorderWorkspaces({ workspaceIds: [workspace.id, workspace.id] }),
    ).rejects.toThrow(/Include each workspace exactly once/);
    await expect(store.reorderWorkspaces({ workspaceIds: [] })).rejects.toThrow();
  });

  it("serializes workspace creation and reorder so concurrent writes cannot lose records", async () => {
    const store = await openStore();
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const internal = store as unknown as {
      writeState: (state?: unknown) => Promise<void>;
    };
    const writeState = internal.writeState.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    internal.writeState = async (state) => {
      await gate;
      await writeState(state);
    };

    try {
      const reorder = store.reorderWorkspaces({ workspaceIds: [workspace.id] }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      const created = store.createWorkspace({ name: "Second" });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      release();
      const [orderOutcome, createdWorkspace] = await Promise.all([reorder, created]);
      expect(orderOutcome).toEqual({
        result: [expect.objectContaining({ id: workspace.id })],
      });

      const reopened = await FileStore.open({
        root: store.root,
        workspacePath: store.workspacePath,
      });
      expect(reopened.listWorkspaces()).toMatchObject([
        { id: workspace.id, name: "Nexestra" },
        { id: createdWorkspace.id, name: "Second" },
      ]);
    } finally {
      internal.writeState = writeState;
    }
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
    await expect(readFile(store.stateFile, "utf8")).resolves.toContain('"version": 7');
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

  it("migrates version 6 tasks to the verification contract", async () => {
    const store = await openStore();
    const task = await store.createTask({
      title: "Existing task",
      description: "Existing description",
      status: "todo",
      assigneeId: null,
      threadId: null,
      verificationCommand: "pnpm test",
    });
    const state = JSON.parse(await readFile(store.stateFile, "utf8"));
    state.version = 6;
    delete state.tasks[0].verificationCommand;
    await writeFile(store.stateFile, `${JSON.stringify(state)}\n`);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });

    expect(reopened.getTask(task.id)).toMatchObject({ verificationCommand: "" });
    await expect(readFile(store.stateFile, "utf8")).resolves.toContain('"version": 7');
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

  it("pins document references at persistence and resolves original bytes after replacement", async () => {
    const store = await openStore();
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const item = await store.createKnowledgeDocument(
      {
        name: "Architecture guide",
        handle: "architecture",
        description: "",
      },
      {
        name: "architecture.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture v1"),
      },
    );
    const oldMessage = await store.createUserMessage(
      thread.id,
      "Use #architecture for this change.",
      [],
      [],
      [{ knowledgeId: item.id, handle: item.handle }],
    );
    expect(oldMessage.knowledgeReferences[0]?.revisionId).toBe(item.currentRevisionId);
    const replaced = await store.replaceKnowledgeDocument(
      item.id,
      { expectedRevisionId: item.currentRevisionId },
      {
        name: "architecture-v2.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture v2"),
      },
    );
    if (replaced.kind !== "document") throw new Error("expected document");
    expect(replaced.currentRevisionId).not.toBe(item.currentRevisionId);
    expect(replaced.revisions).toHaveLength(2);
    expect(await readFile(store.knowledgePath(replaced), "utf8")).toBe("# Architecture v2");
    expect(await store.agentKnowledge(oldMessage)).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          fileName: "architecture.md",
          storagePath: expect.stringContaining("/revisions/"),
        }),
        content: "# Architecture v1",
      }),
    ]);
    const newMessage = await store.createUserMessage(
      thread.id,
      "Use the latest #architecture now.",
      [],
      [],
      [{ knowledgeId: item.id, handle: item.handle }],
    );
    expect(newMessage.knowledgeReferences[0]?.revisionId).toBe(replaced.currentRevisionId);
    await expect(store.agentKnowledge(newMessage)).resolves.toEqual([
      expect.objectContaining({ content: "# Architecture v2" }),
    ]);
  });

  it("restores a prior document revision as a new current version", async () => {
    const store = await openStore();
    const item = await store.createKnowledgeDocument(
      {
        name: "Architecture guide",
        handle: "architecture",
        description: "",
      },
      {
        name: "architecture.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture v1"),
      },
    );
    const firstRevisionId = item.currentRevisionId;
    const replaced = await store.replaceKnowledgeDocument(
      item.id,
      { expectedRevisionId: firstRevisionId },
      {
        name: "architecture-v2.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture v2"),
      },
    );
    if (replaced.kind !== "document") throw new Error("expected document");
    if (!firstRevisionId) throw new Error("expected first revision");
    const restored = await store.restoreKnowledgeDocumentRevision(item.id, firstRevisionId, {
      expectedRevisionId: replaced.currentRevisionId,
    });
    if (restored.kind !== "document") throw new Error("expected document");
    expect(restored.currentRevisionId).not.toBe(firstRevisionId);
    expect(restored.revisions).toHaveLength(3);
    expect(restored.revisions.at(-1)?.restoredFromId).toBe(firstRevisionId);
    expect(restored.fileName).toBe("architecture.md");
    expect(await readFile(store.knowledgePath(restored), "utf8")).toBe("# Architecture v1");
    const oldBytes = await store.documentRevisionContent(item.id, firstRevisionId);
    expect(new TextDecoder().decode(oldBytes.bytes)).toBe("# Architecture v1");
  });

  it("captures a legacy document when a new message pins it and keeps provenance after replacement", async () => {
    const store = await openStore();
    const item = await store.createKnowledgeDocument(
      {
        name: "Legacy notes",
        handle: "legacy-notes",
        description: "",
      },
      {
        name: "legacy.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Legacy original"),
      },
    );
    const internal = store as unknown as { state: { knowledge: Array<Record<string, unknown>> } };
    const legacyRoot = store.knowledgePath(item);
    internal.state.knowledge = internal.state.knowledge.map((entry) =>
      entry.id === item.id ? { ...entry, revisions: [], currentRevisionId: undefined } : entry,
    );
    const before = await store.createUserMessage(
      store.listThreads()[0]?.id ?? "",
      "Use #legacy-notes",
      [],
      [],
      [{ knowledgeId: item.id, handle: item.handle }],
    );
    expect(before.knowledgeReferences[0]?.revisionId).toBeTruthy();
    const captured = store.getKnowledge(item.id);
    if (captured?.kind !== "document") throw new Error("expected document");
    expect(captured.revisions).toHaveLength(1);
    expect(captured.storagePath).toContain("/revisions/");
    const replaced = await store.replaceKnowledgeDocument(
      item.id,
      { expectedRevisionId: before.knowledgeReferences[0]?.revisionId ?? "" },
      {
        name: "legacy-v2.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Legacy v2"),
      },
    );
    if (replaced.kind !== "document") throw new Error("expected document");
    expect(replaced.revisions).toHaveLength(2);
    expect(replaced.createdAt).toBe(item.createdAt);
    expect(replaced.revisions[0]).toMatchObject({
      fileName: "legacy.md",
      createdAt: before.createdAt,
    });
    expect(await store.documentRevisionContent(item.id, replaced.revisions[0]?.id ?? "")).toEqual(
      expect.objectContaining({
        bytes: expect.any(Uint8Array),
      }),
    );
    const legacyContent = await store.documentRevisionContent(
      item.id,
      replaced.revisions[0]?.id ?? "",
    );
    expect(new TextDecoder().decode(legacyContent.bytes)).toBe("# Legacy original");
    await expect(store.agentKnowledge(before)).resolves.toEqual([
      expect.objectContaining({ content: "# Legacy original" }),
    ]);
    expect(await readFile(legacyRoot, "utf8")).toBe("# Legacy original");
  });

  it("keeps a legacy capture published when message state write fails after transcript append", async () => {
    const store = await openStore();
    const item = await store.createKnowledgeDocument(
      { name: "Legacy notes", handle: "legacy-notes", description: "" },
      {
        name: "legacy.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Legacy original"),
      },
    );
    const internal = store as unknown as {
      state: { knowledge: Array<Record<string, unknown>> };
      writeState: (state?: unknown) => Promise<void>;
    };
    internal.state.knowledge = internal.state.knowledge.map((entry) =>
      entry.id === item.id ? { ...entry, revisions: [], currentRevisionId: undefined } : entry,
    );
    let writeCount = 0;
    const originalWrite = internal.writeState.bind(store);
    internal.writeState = async (state) => {
      writeCount += 1;
      if (writeCount === 2) throw new Error("simulated message state write failure");
      return originalWrite(state);
    };
    await expect(
      store.createUserMessage(
        store.listThreads()[0]?.id ?? "",
        "Use #legacy-notes",
        [],
        [],
        [{ knowledgeId: item.id, handle: item.handle }],
      ),
    ).rejects.toThrow("simulated message state write failure");

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const data = await reopened.threadData(store.listThreads()[0]?.id ?? "");
    const message = data.messages.find(
      (entry) => entry.author.kind === "user" && entry.knowledgeReferences.length > 0,
    );
    if (!message) throw new Error("expected pinned message after reopen");
    expect(message.knowledgeReferences[0]?.revisionId).toBeTruthy();
    const captured = reopened.getKnowledge(item.id);
    if (captured?.kind !== "document") throw new Error("expected captured document");
    expect(captured.revisions).toHaveLength(1);
    expect(captured.currentRevisionId).toBe(message.knowledgeReferences[0]?.revisionId);
    await expect(reopened.agentKnowledge(message)).resolves.toEqual([
      expect.objectContaining({ content: "# Legacy original" }),
    ]);

    const replaced = await reopened.replaceKnowledgeDocument(
      item.id,
      { expectedRevisionId: captured.currentRevisionId },
      {
        name: "legacy-v2.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Legacy v2"),
      },
    );
    if (replaced.kind !== "document") throw new Error("expected replaced document");
    await expect(reopened.agentKnowledge(message)).resolves.toEqual([
      expect.objectContaining({ content: "# Legacy original" }),
    ]);
  });
  it("rejects stale or foreign document revision mutations and missing revisions", async () => {
    const store = await openStore();
    const item = await store.createKnowledgeDocument(
      {
        name: "Architecture guide",
        handle: "architecture",
        description: "",
      },
      {
        name: "architecture.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture v1"),
      },
    );
    const other = await store.createKnowledgeDocument(
      {
        name: "Other notes",
        handle: "other",
        description: "",
      },
      {
        name: "other.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Other"),
      },
    );
    await expect(store.documentRevisionContent(item.id, "missing-revision")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      store.restoreKnowledgeDocumentRevision(item.id, "missing-revision", {
        expectedRevisionId: item.currentRevisionId,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      store.replaceKnowledgeDocument(
        item.id,
        { expectedRevisionId: "stale" },
        {
          name: "stale.md",
          mediaType: "text/markdown",
          bytes: new TextEncoder().encode("# Stale"),
        },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.restoreKnowledgeDocumentRevision(item.id, other.revisions[0]?.id ?? "", {
        expectedRevisionId: item.currentRevisionId,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    const repository = await store.createKnowledgeRepository({
      name: "Repository",
      handle: "repo",
      description: "",
      source: "/tmp/source",
    });
    await expect(
      store.replaceKnowledgeDocument(
        repository.id,
        { expectedRevisionId: "legacy" },
        { name: "repo.txt", mediaType: "text/plain", bytes: new Uint8Array([1]) },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rolls back a document replacement when the state write fails", async () => {
    const store = await openStore();
    const item = await store.createKnowledgeDocument(
      {
        name: "Architecture guide",
        handle: "architecture",
        description: "",
      },
      {
        name: "architecture.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Architecture v1"),
      },
    );
    const internal = store as unknown as { writeState: (state?: unknown) => Promise<void> };
    const originalWrite = internal.writeState.bind(store);
    internal.writeState = async () => {
      throw new Error("simulated state write failure");
    };
    try {
      await expect(
        store.replaceKnowledgeDocument(
          item.id,
          { expectedRevisionId: item.currentRevisionId },
          {
            name: "architecture-v2.md",
            mediaType: "text/markdown",
            bytes: new TextEncoder().encode("# Architecture v2"),
          },
        ),
      ).rejects.toThrow("simulated state write failure");
    } finally {
      internal.writeState = originalWrite;
    }
    expect(store.getKnowledge(item.id)).toMatchObject({
      fileName: "architecture.md",
      currentRevisionId: item.currentRevisionId,
      storagePath: item.storagePath,
    });
    expect(await readFile(store.knowledgePath(item), "utf8")).toBe("# Architecture v1");
    const revisionDirectory = dirname(item.storagePath);
    expect(await readdir(join(store.root, revisionDirectory))).toEqual([item.currentRevisionId]);
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

describe("FileStore agent profile updates", () => {
  it("updates Worker identity, harness, and optional model fields, keeping the handle unique", async () => {
    const store = await openStore();
    const agent = await store.createAgent({
      kind: "worker",
      name: "Old Planner",
      handle: "old-planner",
      description: "",
      instructions: "",
      harness: "codex",
      model: "gpt-test",
      reasoningEffort: "high",
    });
    await store.createAgent({
      kind: "worker",
      name: "Reserved",
      handle: "reserved",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const updated = await store.updateAgent(agent.id, {
      name: "New Planner",
      handle: "planner",
      description: "Plans the work",
      instructions: "Keep replies short.",
      harness: "opencode",
      model: null,
      reasoningEffort: "max",
    });
    expect(updated).toMatchObject({
      kind: "worker",
      name: "New Planner",
      handle: "planner",
      description: "Plans the work",
      instructions: "Keep replies short.",
      harness: "opencode",
      reasoningEffort: "max",
    });
    expect(updated).not.toHaveProperty("model");
    expect(store.findAgentByHandle("old-planner")).toBeUndefined();
    await expect(store.updateAgent(agent.id, { handle: "reserved" })).rejects.toMatchObject({
      code: "conflict",
    });
    const restored = await store.updateAgent(agent.id, { model: "gpt-test" });
    expect(restored).toMatchObject({ kind: "worker", model: "gpt-test" });
  });
  it("keeps, rotates, and removes a custom Master credential without leaking secrets", async () => {
    const store = await openStore();
    const agent = await store.createAgent({
      kind: "master",
      name: "Gateway",
      handle: "gateway",
      description: "",
      instructions: "",
      provider: {
        type: "custom" as const,
        name: "Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat" as const,
        apiKey: "sk-original",
      },
    });
    const providerFields = {
      type: "custom" as const,
      name: "Gateway",
      baseUrl: "https://gateway.example/v1",
      model: "model-a",
      protocol: "openai-chat" as const,
    };
    const kept = await store.updateAgent(agent.id, { provider: providerFields });
    if (kept.kind !== "master") throw new Error("expected master");
    expect(kept.provider).toMatchObject({ type: "custom", hasCredential: true });
    expect(store.getCredential(agent.id)).toBe("sk-original");
    const rotated = await store.updateAgent(agent.id, {
      provider: { ...providerFields, apiKey: "sk-rotated" },
    });
    if (rotated.kind !== "master") throw new Error("expected master");
    expect(rotated.provider).toMatchObject({ hasCredential: true });
    expect(store.getCredential(agent.id)).toBe("sk-rotated");
    const removed = await store.updateAgent(agent.id, {
      provider: { ...providerFields, removeCredential: true },
    });
    if (removed.kind !== "master") throw new Error("expected master");
    expect(removed.provider).toMatchObject({ hasCredential: false });
    expect(store.getCredential(agent.id)).toBeUndefined();
    const stateText = await readFile(store.stateFile, "utf8");
    const credentialText = await readFile(store.credentialFile, "utf8");
    expect(stateText).not.toContain("sk-");
    expect(credentialText).not.toContain("sk-rotated");
  });
  it("rolls back a credential rotation when the state write fails", async () => {
    const store = await openStore();
    const agent = await store.createAgent({
      kind: "master",
      name: "Gateway",
      handle: "gateway",
      description: "",
      instructions: "",
      provider: {
        type: "custom" as const,
        name: "Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat" as const,
        apiKey: "sk-original",
      },
    });
    const internal = store as unknown as { writeState: (state?: unknown) => Promise<void> };
    const writeState = internal.writeState.bind(store);
    internal.writeState = async () => {
      throw new Error("simulated state write failure");
    };
    try {
      await expect(
        store.updateAgent(agent.id, {
          provider: {
            type: "custom" as const,
            name: "Gateway",
            baseUrl: "https://gateway.example/v1",
            model: "model-a",
            protocol: "openai-chat" as const,
            apiKey: "sk-new-rotated",
          },
        }),
      ).rejects.toThrow("simulated state write failure");
      expect(store.getCredential(agent.id)).toBe("sk-original");
      expect(await readFile(store.credentialFile, "utf8")).toContain("sk-original");
      expect(await readFile(store.credentialFile, "utf8")).not.toContain("sk-new-rotated");
      expect(await readFile(store.stateFile, "utf8")).not.toContain("sk-new-rotated");
    } finally {
      internal.writeState = writeState;
    }
  });
  it("rejects configuration fields that do not match the agent kind", async () => {
    const store = await openStore();
    const master = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: { type: "chatgpt", model: "" },
    });
    await expect(store.updateAgent(master.id, { harness: "codex" })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("marks interrupted repository clones failed at startup without changing identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-store-clone-recovery-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const source = join(root, "provenance-source");
    const gitLike = await store.createKnowledgeRepository({
      name: "Interrupted complete clone",
      handle: "interrupted-complete",
      description: "",
      source,
    });
    await mkdir(join(store.knowledgePath(gitLike), ".git"), { recursive: true });
    const missing = await store.createKnowledgeRepository({
      name: "Interrupted early clone",
      handle: "interrupted-early",
      description: "",
      source: join(root, "missing-source"),
    });
    const itemRoot = dirname(store.knowledgePath(gitLike));
    await mkdir(join(itemRoot, "source.retrying-crash", ".git"), { recursive: true });

    const reopened = await FileStore.open({ root, workspacePath: root });
    const gitLikeRecovered = reopened.getKnowledge(gitLike.id);
    const missingRecovered = reopened.getKnowledge(missing.id);
    if (gitLikeRecovered?.kind !== "repository" || missingRecovered?.kind !== "repository") {
      throw new Error("expected repository knowledge");
    }
    expect(gitLikeRecovered).toMatchObject({
      id: gitLike.id,
      handle: "interrupted-complete",
      source,
      status: "failed",
      createdAt: gitLike.createdAt,
    });
    expect(gitLikeRecovered.error).toMatch(/existing git clone/);
    expect(missingRecovered).toMatchObject({ status: "failed", createdAt: missing.createdAt });
    expect(missingRecovered.error).toMatch(/server restart/);
    expect(await readdir(itemRoot)).toEqual(
      expect.arrayContaining(["source", "source.retrying-crash"]),
    );
    await expect(readdir(join(itemRoot, "source.retrying-crash", ".git"))).resolves.toEqual([]);
  });

  it("rejects knowledge edits while a repository clone is still running", async () => {
    const store = await openStore();
    const repository = await store.createKnowledgeRepository({
      name: "Cloning repository",
      handle: "cloning-repo",
      description: "",
      source: join(store.workspacePath, "source"),
    });
    await expect(
      store.updateKnowledge(repository.id, { name: "Renamed while cloning" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await store.updateKnowledgeRepository(repository.id, { status: "failed", error: "stopped" });
    await expect(
      store.updateKnowledge(repository.id, { name: "Renamed after retry failed" }),
    ).resolves.toMatchObject({ name: "Renamed after retry failed" });
  });

  it("rolls back interrupted clone recovery when the state write fails", async () => {
    const store = await openStore();
    const repository = await store.createKnowledgeRepository({
      name: "Cloning repository",
      handle: "cloning-rollback",
      description: "",
      source: join(store.workspacePath, "missing-source"),
    });
    const internal = store as unknown as {
      recoverInterruptedRepositories: () => Promise<void>;
      writeState: (state?: unknown) => Promise<void>;
    };
    const writeState = internal.writeState.bind(store);
    internal.writeState = async () => {
      throw new Error("simulated state write failure");
    };
    try {
      await expect(internal.recoverInterruptedRepositories()).rejects.toThrow(
        "simulated state write failure",
      );
    } finally {
      internal.writeState = writeState;
    }
    expect(store.getKnowledge(repository.id)).toMatchObject({ status: "cloning" });
    expect(store.getKnowledge(repository.id)).not.toHaveProperty("error");
  });
});
